import { Injectable } from '@nestjs/common';
import {
  type AccountOwnerCandidate,
  type CreateOrganisationRequest,
  DUPLICATE_NAME_CONTAINMENT,
  DUPLICATE_NAME_SIMILARITY,
  type DuplicateMatch,
  type OrganisationDetail,
  type OrganisationListItem,
  type OrganisationListQuery,
  type Page,
  type PermissionKey,
  type UpdateOrganisationRequest,
} from '@ooh/contracts';
import {
  appUser,
  membership,
  organisation,
  organisationClassification,
  organisationClassificationLink,
  type Transaction,
} from '@ooh/db';
import { and, asc, eq, exists, gt, inArray, isNull, or, type SQL, sql } from 'drizzle-orm';
import { AuditService } from '../../core/audit/audit.service';
import { type Principal } from '../../core/auth/principal';
import { DatabaseService } from '../../core/database/database.service';
import { isUniqueViolation } from '../../core/database/pg-errors';
import { AppError } from '../../core/http/app-error';
import { type ClientInfo } from '../../core/http/client-info';
import { assertIfMatch, type IfMatch } from '../../core/http/concurrency';
import { decodeKeysetCursor, encodeKeysetCursor } from '../../core/http/cursor';

const VAT_UNIQUE_INDEX = 'organisation_tenant_vat_uq';

/** Fields a PATCH may change, compared one by one for the field-level audit trail. */
const SCALAR_FIELDS = [
  'displayName',
  'legalName',
  'vatNumber',
  'website',
  'address',
  'city',
  'county',
  'country',
  'industry',
  'notes',
  'accountOwnerMembershipId',
] as const;

const notFound = () => new AppError('NOT_FOUND', 'Company not found.');

/**
 * Organisations (CRM companies). Scoped permissions are applied in the query, never "fetch then
 * check" (docs/architecture/03-rbac.md §5): with OWN scope a member only reaches the companies whose
 * account owner they are.
 */
@Injectable()
export class OrganisationsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  list(principal: Principal, query: OrganisationListQuery): Promise<Page<OrganisationListItem>> {
    const after = query.cursor ? decodeKeysetCursor(query.cursor) : undefined;
    return this.inTenant(principal, async (tx) => {
      const filters: (SQL | undefined)[] = [
        this.scopeFilter(principal, 'organisation.read'),
        query.includeArchived ? undefined : isNull(organisation.archivedAt),
        query.classificationId
          ? exists(
              tx
                .select({ one: sql`1` })
                .from(organisationClassificationLink)
                .where(
                  and(
                    eq(organisationClassificationLink.organisationId, organisation.id),
                    eq(organisationClassificationLink.classificationId, query.classificationId),
                  ),
                ),
            )
          : undefined,
        query.q ? searchFilter(query.q) : undefined,
        after
          ? or(
              gt(organisation.nameKey, after.sortKey),
              and(eq(organisation.nameKey, after.sortKey), gt(organisation.id, after.id)),
            )
          : undefined,
      ];
      const rows = await this.loadItems(tx, and(...filters), query.limit + 1);
      const hasMore = rows.length > query.limit;
      const data = rows.slice(0, query.limit);
      const last = data.at(-1);
      return {
        data: data.map(({ item }) => item),
        page: {
          nextCursor: hasMore && last ? encodeKeysetCursor(last.nameKey, last.item.id) : null,
          hasMore,
        },
      };
    });
  }

  get(principal: Principal, id: string): Promise<OrganisationDetail> {
    return this.inTenant(principal, (tx) => this.loadDetail(tx, principal, id));
  }

  async create(
    principal: Principal,
    input: CreateOrganisationRequest,
    client: ClientInfo,
  ): Promise<OrganisationDetail> {
    return this.inTenant(principal, async (tx) => {
      await this.assertClassifications(tx, input.classificationIds);
      const ownerId = input.accountOwnerMembershipId ?? principal.membershipId;
      if (input.accountOwnerMembershipId) await this.assertAccountOwner(tx, ownerId);

      const matches = await this.findDuplicates(tx, input.displayName, input.vatNumber ?? null);
      const vatMatch = matches.some((m) => m.reason === 'VAT');
      if (matches.length > 0 && (vatMatch || !input.force)) throw duplicateSuspected(matches, !vatMatch);

      let created: { id: string };
      try {
        [created] = (await tx
          .insert(organisation)
          .values({
            tenantId: principal.tenantId,
            displayName: input.displayName,
            legalName: input.legalName ?? null,
            vatNumber: input.vatNumber ?? null,
            website: input.website ?? null,
            address: input.address ?? null,
            city: input.city ?? null,
            county: input.county ?? null,
            country: input.country,
            industry: input.industry ?? null,
            notes: input.notes ?? null,
            accountOwnerMembershipId: ownerId,
            createdByMembershipId: principal.membershipId,
          })
          .returning({ id: organisation.id })) as [{ id: string }];
      } catch (error) {
        // Another company with this VAT number was created concurrently.
        if (isUniqueViolation(error, VAT_UNIQUE_INDEX))
          throw duplicateSuspected(
            await this.findDuplicates(tx, input.displayName, input.vatNumber ?? null),
            false,
          );
        throw error;
      }
      await this.replaceClassifications(tx, principal.tenantId, created.id, input.classificationIds);
      await this.audit.record(tx, {
        ...actor(principal, client),
        action: 'organisation.created',
        subjectType: 'organisation',
        subjectId: created.id,
        metadata: {
          displayName: input.displayName,
          ...(matches.length > 0
            ? { duplicateOverride: { reason: input.forceReason, matchIds: matches.map((m) => m.id) } }
            : {}),
        },
      });
      return this.loadDetail(tx, principal, created.id);
    });
  }

  update(
    principal: Principal,
    id: string,
    input: UpdateOrganisationRequest,
    ifMatch: IfMatch,
    client: ClientInfo,
  ): Promise<OrganisationDetail> {
    return this.inTenant(principal, async (tx) => {
      const current = await this.lockEditable(tx, principal, id, 'organisation.update');
      if (input.classificationIds) await this.assertClassifications(tx, input.classificationIds);
      if (input.accountOwnerMembershipId) await this.assertAccountOwner(tx, input.accountOwnerMembershipId);
      if (input.vatNumber && input.vatNumber !== current.vatNumber) {
        const vatMatches = (await this.findDuplicates(tx, null, input.vatNumber)).filter((m) => m.id !== id);
        if (vatMatches.length > 0) throw duplicateSuspected(vatMatches, false);
      }
      assertIfMatch(ifMatch, current.version);

      const changes: Record<string, { from: unknown; to: unknown }> = {};
      const set: Partial<typeof organisation.$inferInsert> = {};
      for (const field of SCALAR_FIELDS) {
        const next = input[field];
        if (next !== undefined && next !== current[field]) {
          changes[field] = { from: current[field], to: next };
          (set as Record<string, unknown>)[field] = next;
        }
      }
      if (input.classificationIds) {
        const from = current.classifications.map((c) => c.id).sort();
        const to = [...input.classificationIds].sort();
        if (from.join() !== to.join()) changes.classificationIds = { from, to };
      }
      if (Object.keys(changes).length === 0) return current.detail;

      try {
        await tx
          .update(organisation)
          .set({ ...set, version: sql`${organisation.version} + 1` })
          .where(eq(organisation.id, id));
      } catch (error) {
        if (isUniqueViolation(error, VAT_UNIQUE_INDEX))
          throw duplicateSuspected(await this.findDuplicates(tx, null, input.vatNumber ?? null), false);
        throw error;
      }
      if (changes.classificationIds)
        await this.replaceClassifications(tx, principal.tenantId, id, input.classificationIds!);
      await this.audit.record(tx, {
        ...actor(principal, client),
        action: 'organisation.updated',
        subjectType: 'organisation',
        subjectId: id,
        changes,
      });
      return this.loadDetail(tx, principal, id);
    });
  }

  archive(
    principal: Principal,
    id: string,
    ifMatch: IfMatch,
    client: ClientInfo,
  ): Promise<OrganisationDetail> {
    return this.inTenant(principal, async (tx) => {
      const current = await this.lockEditable(tx, principal, id, 'organisation.archive');
      assertIfMatch(ifMatch, current.version);
      await tx
        .update(organisation)
        .set({ archivedAt: new Date(), version: sql`${organisation.version} + 1` })
        .where(eq(organisation.id, id));
      await this.audit.record(tx, {
        ...actor(principal, client),
        action: 'organisation.archived',
        subjectType: 'organisation',
        subjectId: id,
      });
      return this.loadDetail(tx, principal, id);
    });
  }

  /** Members who can own accounts: active and internal (for the account owner picker). */
  accountOwners(principal: Principal): Promise<AccountOwnerCandidate[]> {
    return this.inTenant(principal, (tx) =>
      tx
        .select({ membershipId: membership.id, displayName: appUser.displayName })
        .from(membership)
        .innerJoin(appUser, eq(appUser.id, membership.userId))
        .where(
          and(
            eq(membership.status, 'ACTIVE'),
            eq(membership.kind, 'INTERNAL'),
            isNull(membership.archivedAt),
          ),
        )
        .orderBy(asc(appUser.displayName)),
    );
  }

  // ── duplicate detection ────────────────────────────────────────────────────

  /**
   * Live companies that look like the same real-world company: same VAT number (also ignoring an
   * "RO" prefix, which Romanian CUIs are written with or without), or a similar normalised name.
   * Deliberately not narrowed by the caller's read scope: a duplicate is a duplicate either way.
   */
  private async findDuplicates(
    tx: Transaction,
    displayName: string | null,
    vatNumber: string | null,
  ): Promise<DuplicateMatch[]> {
    const vatClause = vatNumber
      ? sql`(${organisation.vatNumber} IS NOT NULL AND regexp_replace(${organisation.vatNumber}, '^RO', '') = regexp_replace(${vatNumber}::text, '^RO', ''))`
      : // Always false, but a column expression: PostgreSQL rejects a constant in ORDER BY.
        sql`(${organisation.vatNumber} IS NOT NULL AND false)`;
    const key = displayName ? sql`crm_name_key(${displayName}::text)` : sql`NULL::text`;
    const similarity = sql<number>`coalesce(greatest(
      similarity(${organisation.nameKey}, ${key}),
      strict_word_similarity(${key}, ${organisation.nameKey}),
      strict_word_similarity(${organisation.nameKey}, ${key})), 0)`;
    const rows = await tx
      .select({
        id: organisation.id,
        displayName: organisation.displayName,
        vatNumber: organisation.vatNumber,
        city: organisation.city,
        vatMatch: sql<boolean>`${vatClause}`,
        similarity,
      })
      .from(organisation)
      .where(
        and(
          isNull(organisation.archivedAt),
          or(
            vatClause,
            displayName
              ? sql`(similarity(${organisation.nameKey}, ${key}) >= ${DUPLICATE_NAME_SIMILARITY}
                 OR strict_word_similarity(${key}, ${organisation.nameKey}) >= ${DUPLICATE_NAME_CONTAINMENT}
                 OR strict_word_similarity(${organisation.nameKey}, ${key}) >= ${DUPLICATE_NAME_CONTAINMENT})`
              : undefined,
          ),
        ),
      )
      .orderBy(sql`${vatClause} DESC`, sql`${similarity} DESC`)
      .limit(10);
    return rows.map(({ vatMatch, similarity: score, ...row }) => ({
      ...row,
      reason: vatMatch ? 'VAT' : 'NAME',
      similarity: Math.round(Number(score) * 100) / 100,
    }));
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private inTenant<T>(principal: Principal, fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.database.withTenant({ tenantId: principal.tenantId, actorUserId: principal.userId }, fn);
  }

  /** OWN scope → only companies whose account owner is the caller. */
  scopeFilter(principal: Principal, permission: PermissionKey): SQL | undefined {
    return principal.permissions.get(permission) === 'OWN'
      ? eq(organisation.accountOwnerMembershipId, principal.membershipId)
      : undefined;
  }

  /**
   * Locks a live company for a change. Outside the read scope it doesn't exist for the caller (404);
   * readable but outside the change scope is a 403 with the reason.
   */
  /** Also used by RelationshipsService: a relationship change is a change to its "from" company. */
  async lockEditable(tx: Transaction, principal: Principal, id: string, permission: PermissionKey) {
    const [row] = await tx
      .select({ id: organisation.id })
      .from(organisation)
      .where(and(eq(organisation.id, id), this.scopeFilter(principal, 'organisation.read')))
      .for('update');
    if (!row) throw notFound();
    const detail = await this.loadDetail(tx, principal, id);
    if (detail.archivedAt) throw new AppError('INVALID_TRANSITION', 'This company is archived.');
    if (
      principal.permissions.get(permission) === 'OWN' &&
      detail.accountOwner?.membershipId !== principal.membershipId
    ) {
      throw new AppError('FORBIDDEN', 'You can only change companies you are the account owner of.');
    }
    const [raw] = await tx.select().from(organisation).where(eq(organisation.id, id));
    return { ...raw!, detail, classifications: detail.classifications };
  }

  private async assertClassifications(tx: Transaction, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const found = await tx
      .select({ id: organisationClassification.id, active: organisationClassification.active })
      .from(organisationClassification)
      .where(inArray(organisationClassification.id, [...ids]));
    if (found.length !== ids.length || found.some((c) => !c.active)) {
      throw new AppError('VALIDATION_FAILED', 'Unknown or disabled classification.', {
        errors: [{ path: 'classificationIds', message: 'Unknown or disabled classification' }],
      });
    }
  }

  /** Account owners are active internal members of the tenant. */
  private async assertAccountOwner(tx: Transaction, membershipId: string): Promise<void> {
    const [owner] = await tx
      .select({ status: membership.status, kind: membership.kind })
      .from(membership)
      .where(eq(membership.id, membershipId));
    if (!owner || owner.status !== 'ACTIVE' || owner.kind !== 'INTERNAL') {
      throw new AppError('VALIDATION_FAILED', 'The account owner must be an active internal member.', {
        errors: [{ path: 'accountOwnerMembershipId', message: 'Not an active internal member' }],
      });
    }
  }

  private async replaceClassifications(
    tx: Transaction,
    tenantId: string,
    organisationId: string,
    ids: readonly string[],
  ) {
    await tx
      .delete(organisationClassificationLink)
      .where(eq(organisationClassificationLink.organisationId, organisationId));
    if (ids.length > 0)
      await tx
        .insert(organisationClassificationLink)
        .values(ids.map((classificationId) => ({ tenantId, organisationId, classificationId })));
  }

  private async loadDetail(tx: Transaction, principal: Principal, id: string): Promise<OrganisationDetail> {
    const [row] = await this.loadItems(
      tx,
      and(eq(organisation.id, id), this.scopeFilter(principal, 'organisation.read')),
      1,
    );
    if (!row) throw notFound();
    const [extra] = await tx
      .select({
        website: organisation.website,
        address: organisation.address,
        industry: organisation.industry,
        notes: organisation.notes,
        createdAt: organisation.createdAt,
        updatedAt: organisation.updatedAt,
      })
      .from(organisation)
      .where(eq(organisation.id, id));
    return {
      ...row.item,
      ...extra!,
      createdAt: extra!.createdAt.toISOString(),
      updatedAt: extra!.updatedAt.toISOString(),
    };
  }

  /** Items ordered by (name_key, id), the keyset used by the list cursor. */
  private async loadItems(
    tx: Transaction,
    where: SQL | undefined,
    limit: number,
  ): Promise<{ nameKey: string; item: OrganisationListItem }[]> {
    const rows = await tx
      .select({
        id: organisation.id,
        nameKey: organisation.nameKey,
        displayName: organisation.displayName,
        legalName: organisation.legalName,
        vatNumber: organisation.vatNumber,
        city: organisation.city,
        county: organisation.county,
        country: organisation.country,
        archivedAt: organisation.archivedAt,
        version: organisation.version,
        ownerId: organisation.accountOwnerMembershipId,
        ownerName: appUser.displayName,
      })
      .from(organisation)
      .leftJoin(membership, eq(membership.id, organisation.accountOwnerMembershipId))
      .leftJoin(appUser, eq(appUser.id, membership.userId))
      .where(where)
      .orderBy(asc(organisation.nameKey), asc(organisation.id))
      .limit(limit);

    const links = rows.length
      ? await tx
          .select({
            organisationId: organisationClassificationLink.organisationId,
            id: organisationClassification.id,
            key: organisationClassification.key,
            name: organisationClassification.name,
          })
          .from(organisationClassificationLink)
          .innerJoin(
            organisationClassification,
            eq(organisationClassification.id, organisationClassificationLink.classificationId),
          )
          .where(
            inArray(
              organisationClassificationLink.organisationId,
              rows.map((r) => r.id),
            ),
          )
          .orderBy(asc(organisationClassification.sortOrder), asc(organisationClassification.name))
      : [];

    return rows.map(({ nameKey, ownerId, ownerName, archivedAt, ...row }) => ({
      nameKey,
      item: {
        ...row,
        archivedAt: archivedAt?.toISOString() ?? null,
        accountOwner: ownerId ? { membershipId: ownerId, displayName: ownerName ?? '' } : null,
        classifications: links
          .filter((l) => l.organisationId === row.id)
          .map(({ id, key, name }) => ({ id, key, name })),
      },
    }));
  }
}

/** Accent-, case- and legal-form-insensitive name search, or a VAT number prefix. */
function searchFilter(q: string): SQL {
  const vat = q.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return or(
    sql`${organisation.nameKey} LIKE '%' || crm_name_key(${q}::text) || '%'`,
    vat.length >= 2 ? sql`${organisation.vatNumber} LIKE ${`${vat}%`}` : undefined,
  )!;
}

function duplicateSuspected(matches: DuplicateMatch[], canForce: boolean): AppError {
  return new AppError(
    'DUPLICATE_SUSPECTED',
    canForce
      ? 'A similar company already exists. Open it instead, or confirm that this is a different company.'
      : 'A company with this VAT number already exists.',
    { meta: { matches, canForce } },
  );
}

function actor(principal: Principal, client: ClientInfo) {
  return {
    tenantId: principal.tenantId,
    actorType: 'USER' as const,
    actorUserId: principal.userId,
    actorMembershipId: principal.membershipId,
    client,
  };
}
