import { Injectable } from '@nestjs/common';
import type {
  ContactDetail,
  ContactListItem,
  ContactListQuery,
  CreateContactRequest,
  Page,
  PermissionKey,
  UpdateContactRequest,
} from '@ooh/contracts';
import { contact, organisation, type Transaction } from '@ooh/db';
import { and, asc, eq, gt, isNull, ne, or, type SQL, sql } from 'drizzle-orm';
import { AuditService } from '../../core/audit/audit.service';
import { type Principal } from '../../core/auth/principal';
import { DatabaseService } from '../../core/database/database.service';
import { isUniqueViolation } from '../../core/database/pg-errors';
import { AppError } from '../../core/http/app-error';
import { type ClientInfo } from '../../core/http/client-info';
import { assertIfMatch, type IfMatch } from '../../core/http/concurrency';
import { decodeKeysetCursor, encodeKeysetCursor } from '../../core/http/cursor';

const EMAIL_UNIQUE_INDEX = 'contact_organisation_email_uq';

/**
 * Personal data: never written to the (append-only, never erasable) audit trail. Changes to these
 * fields are recorded as "changed" without their values, so GDPR erasure leaves nothing behind.
 */
const PERSONAL_FIELDS = new Set([
  'firstName',
  'lastName',
  'position',
  'phone',
  'email',
  'linkedin',
  'tags',
  'consentSource',
]);
const EDITABLE_FIELDS = [
  'firstName',
  'lastName',
  'position',
  'phone',
  'email',
  'linkedin',
  'tags',
  'isDecisionMaker',
  'isPrimary',
] as const;

const notFound = () => new AppError('NOT_FOUND', 'Contact not found.');
const duplicateEmail = () =>
  new AppError('CONFLICT', 'This company already has a contact with this email address.', {
    errors: [{ path: 'email', message: 'Already used by another contact of this company' }],
  });

/**
 * Contacts of CRM organisations. A contact's OWN scope follows its organisation: with OWN, a member
 * reaches the contacts of the companies whose account owner they are (applied in the query).
 */
@Injectable()
export class ContactsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  list(principal: Principal, query: ContactListQuery): Promise<Page<ContactListItem>> {
    const after = query.cursor ? decodeKeysetCursor(query.cursor) : undefined;
    return this.inTenant(principal, async (tx) => {
      const rows = await this.loadItems(
        tx,
        and(
          this.scopeFilter(principal, 'contact.read'),
          query.includeArchived ? undefined : isNull(contact.archivedAt),
          query.organisationId ? eq(contact.organisationId, query.organisationId) : undefined,
          query.q ? searchFilter(query.q) : undefined,
          after
            ? or(
                gt(contact.nameKey, after.sortKey),
                and(eq(contact.nameKey, after.sortKey), gt(contact.id, after.id)),
              )
            : undefined,
        ),
        query.limit + 1,
      );
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

  get(principal: Principal, id: string): Promise<ContactDetail> {
    return this.inTenant(principal, (tx) => this.loadDetail(tx, principal, id));
  }

  create(principal: Principal, input: CreateContactRequest, client: ClientInfo): Promise<ContactDetail> {
    return this.inTenant(principal, async (tx) => {
      // The company must exist, be live and be visible to the caller.
      const [company] = await tx
        .select({ archivedAt: organisation.archivedAt })
        .from(organisation)
        .where(
          and(
            eq(organisation.id, input.organisationId),
            principal.permissions.get('organisation.read') === 'OWN'
              ? eq(organisation.accountOwnerMembershipId, principal.membershipId)
              : undefined,
          ),
        );
      if (!company) {
        throw new AppError('VALIDATION_FAILED', 'Unknown company.', {
          errors: [{ path: 'organisationId', message: 'Unknown company' }],
        });
      }
      if (company.archivedAt) throw new AppError('INVALID_TRANSITION', 'This company is archived.');

      if (input.isPrimary) await this.clearPrimary(tx, input.organisationId);
      let created: { id: string };
      try {
        [created] = (await tx
          .insert(contact)
          .values({
            tenantId: principal.tenantId,
            organisationId: input.organisationId,
            firstName: input.firstName,
            lastName: input.lastName ?? null,
            position: input.position ?? null,
            phone: input.phone ?? null,
            email: input.email ?? null,
            linkedin: input.linkedin ?? null,
            isDecisionMaker: input.isDecisionMaker,
            isPrimary: input.isPrimary,
            tags: input.tags,
            ...consentColumns(input.consentStatus, input.consentSource, input.consentAt),
            createdByMembershipId: principal.membershipId,
          })
          .returning({ id: contact.id })) as [{ id: string }];
      } catch (error) {
        if (isUniqueViolation(error, EMAIL_UNIQUE_INDEX)) throw duplicateEmail();
        throw error;
      }
      await this.audit.record(tx, {
        ...actor(principal, client),
        action: 'contact.created',
        subjectType: 'contact',
        subjectId: created.id,
        metadata: { organisationId: input.organisationId, consentStatus: input.consentStatus },
      });
      return this.loadDetail(tx, principal, created.id);
    });
  }

  update(
    principal: Principal,
    id: string,
    input: UpdateContactRequest,
    ifMatch: IfMatch,
    client: ClientInfo,
  ): Promise<ContactDetail> {
    return this.inTenant(principal, async (tx) => {
      const current = await this.lockEditable(tx, principal, id, 'contact.update');
      assertIfMatch(ifMatch, current.version);

      const set: Partial<typeof contact.$inferInsert> = {};
      const changed: string[] = [];
      for (const field of EDITABLE_FIELDS) {
        const next = input[field];
        const before = current[field];
        const same =
          Array.isArray(next) && Array.isArray(before)
            ? next.join('\u0000') === before.join('\u0000')
            : next === before;
        if (next !== undefined && !same) {
          (set as Record<string, unknown>)[field] = next;
          changed.push(field);
        }
      }
      if (input.consentStatus !== undefined && input.consentStatus !== current.consentStatus) {
        Object.assign(set, consentColumns(input.consentStatus, input.consentSource, input.consentAt));
        changed.push('consentStatus', 'consentSource', 'consentAt');
      } else if (input.consentSource !== undefined && input.consentSource !== current.consentSource) {
        if (current.consentStatus === 'UNKNOWN') {
          throw new AppError('VALIDATION_FAILED', 'State the consent before its source.', {
            errors: [{ path: 'consentSource', message: 'No consent stated' }],
          });
        }
        set.consentSource = input.consentSource;
        changed.push('consentSource');
      }
      if (changed.length === 0) return current.detail;

      if (set.isPrimary) await this.clearPrimary(tx, current.organisationId, id);
      try {
        await tx
          .update(contact)
          .set({ ...set, version: sql`${contact.version} + 1` })
          .where(eq(contact.id, id));
      } catch (error) {
        if (isUniqueViolation(error, EMAIL_UNIQUE_INDEX)) throw duplicateEmail();
        throw error;
      }
      await this.audit.record(tx, {
        ...actor(principal, client),
        action: 'contact.updated',
        subjectType: 'contact',
        subjectId: id,
        changes: auditChanges(changed, current, set),
      });
      return this.loadDetail(tx, principal, id);
    });
  }

  archive(principal: Principal, id: string, ifMatch: IfMatch, client: ClientInfo): Promise<ContactDetail> {
    return this.inTenant(principal, async (tx) => {
      const current = await this.lockEditable(tx, principal, id, 'contact.archive');
      assertIfMatch(ifMatch, current.version);
      await tx
        .update(contact)
        .set({ archivedAt: new Date(), isPrimary: false, version: sql`${contact.version} + 1` })
        .where(eq(contact.id, id));
      await this.audit.record(tx, {
        ...actor(principal, client),
        action: 'contact.archived',
        subjectType: 'contact',
        subjectId: id,
      });
      return this.loadDetail(tx, principal, id);
    });
  }

  /**
   * GDPR erasure (05-domain-model §4): personal columns are wiped in place and the contact is
   * archived; the row stays so activities and history keep a valid reference. Irreversible.
   */
  anonymise(principal: Principal, id: string, ifMatch: IfMatch, client: ClientInfo): Promise<ContactDetail> {
    return this.inTenant(principal, async (tx) => {
      const current = await this.lockEditable(tx, principal, id, 'contact.anonymise', {
        allowArchived: true,
      });
      assertIfMatch(ifMatch, current.version);
      const now = new Date();
      await tx
        .update(contact)
        .set({
          firstName: 'Anonymised contact',
          lastName: null,
          position: null,
          phone: null,
          email: null,
          linkedin: null,
          tags: [],
          isPrimary: false,
          isDecisionMaker: false,
          // Never contact them again.
          consentStatus: 'OPTED_OUT',
          consentSource: 'gdpr_erasure',
          consentAt: now,
          anonymisedAt: now,
          archivedAt: current.archivedAt ?? now,
          version: sql`${contact.version} + 1`,
        })
        .where(eq(contact.id, id));
      await this.audit.record(tx, {
        ...actor(principal, client),
        action: 'contact.anonymised',
        subjectType: 'contact',
        subjectId: id,
      });
      return this.loadDetail(tx, principal, id);
    });
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private inTenant<T>(principal: Principal, fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.database.withTenant({ tenantId: principal.tenantId, actorUserId: principal.userId }, fn);
  }

  /** OWN scope → contacts of the companies the caller is account owner of. */
  private scopeFilter(principal: Principal, permission: PermissionKey): SQL | undefined {
    return principal.permissions.get(permission) === 'OWN'
      ? eq(organisation.accountOwnerMembershipId, principal.membershipId)
      : undefined;
  }

  /**
   * Locks a contact for a change: outside the read scope it doesn't exist (404); readable but
   * outside the change scope is a 403; anonymised contacts are final, archived ones read-only.
   */
  private async lockEditable(
    tx: Transaction,
    principal: Principal,
    id: string,
    permission: PermissionKey,
    options: { allowArchived?: boolean } = {},
  ) {
    const [row] = await tx
      .select({ contact, ownerId: organisation.accountOwnerMembershipId })
      .from(contact)
      .innerJoin(organisation, eq(organisation.id, contact.organisationId))
      .where(and(eq(contact.id, id), this.scopeFilter(principal, 'contact.read')))
      .for('update', { of: contact });
    if (!row) throw notFound();
    if (row.contact.anonymisedAt) throw new AppError('INVALID_TRANSITION', 'This contact was anonymised.');
    if (row.contact.archivedAt && !options.allowArchived)
      throw new AppError('INVALID_TRANSITION', 'This contact is archived.');
    if (principal.permissions.get(permission) === 'OWN' && row.ownerId !== principal.membershipId) {
      throw new AppError(
        'FORBIDDEN',
        'You can only change contacts of companies you are the account owner of.',
      );
    }
    return { ...row.contact, detail: await this.loadDetail(tx, principal, id) };
  }

  /** Makes room for a new primary contact (one live primary per organisation). */
  private async clearPrimary(tx: Transaction, organisationId: string, exceptId?: string): Promise<void> {
    await tx
      .update(contact)
      .set({ isPrimary: false, version: sql`${contact.version} + 1` })
      .where(
        and(
          eq(contact.organisationId, organisationId),
          eq(contact.isPrimary, true),
          isNull(contact.archivedAt),
          exceptId ? ne(contact.id, exceptId) : undefined,
        ),
      );
  }

  private async loadDetail(tx: Transaction, principal: Principal, id: string): Promise<ContactDetail> {
    const [row] = await this.loadItems(
      tx,
      and(eq(contact.id, id), this.scopeFilter(principal, 'contact.read')),
      1,
    );
    if (!row) throw notFound();
    const [extra] = await tx
      .select({
        linkedin: contact.linkedin,
        consentSource: contact.consentSource,
        consentAt: contact.consentAt,
        unsubscribedAt: contact.unsubscribedAt,
        createdAt: contact.createdAt,
        updatedAt: contact.updatedAt,
      })
      .from(contact)
      .where(eq(contact.id, id));
    return {
      ...row.item,
      linkedin: extra!.linkedin,
      consentSource: extra!.consentSource,
      consentAt: extra!.consentAt?.toISOString() ?? null,
      unsubscribedAt: extra!.unsubscribedAt?.toISOString() ?? null,
      createdAt: extra!.createdAt.toISOString(),
      updatedAt: extra!.updatedAt.toISOString(),
    };
  }

  private async loadItems(
    tx: Transaction,
    where: SQL | undefined,
    limit: number,
  ): Promise<{ nameKey: string; item: ContactListItem }[]> {
    const rows = await tx
      .select({
        id: contact.id,
        nameKey: contact.nameKey,
        organisationId: organisation.id,
        organisationName: organisation.displayName,
        firstName: contact.firstName,
        lastName: contact.lastName,
        position: contact.position,
        email: contact.email,
        phone: contact.phone,
        isPrimary: contact.isPrimary,
        isDecisionMaker: contact.isDecisionMaker,
        consentStatus: contact.consentStatus,
        newsletterEligible: contact.newsletterEligible,
        tags: contact.tags,
        archivedAt: contact.archivedAt,
        anonymisedAt: contact.anonymisedAt,
        version: contact.version,
      })
      .from(contact)
      .innerJoin(organisation, eq(organisation.id, contact.organisationId))
      .where(where)
      .orderBy(asc(contact.nameKey), asc(contact.id))
      .limit(limit);
    return rows.map(({ nameKey, organisationId, organisationName, archivedAt, anonymisedAt, ...row }) => ({
      nameKey,
      item: {
        ...row,
        organisation: { id: organisationId, displayName: organisationName },
        archivedAt: archivedAt?.toISOString() ?? null,
        anonymisedAt: anonymisedAt?.toISOString() ?? null,
      },
    }));
  }
}

/** Consent columns for a newly stated preference; UNKNOWN clears source and time. */
function consentColumns(
  status: CreateContactRequest['consentStatus'],
  source: string | null | undefined,
  at: string | null | undefined,
) {
  if (status === 'UNKNOWN') return { consentStatus: status, consentSource: null, consentAt: null };
  return { consentStatus: status, consentSource: source ?? null, consentAt: at ? new Date(at) : new Date() };
}

function auditChanges(
  fields: readonly string[],
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const field of new Set(fields)) {
    changes[field] = PERSONAL_FIELDS.has(field)
      ? { from: '[personal data]', to: '[personal data]' }
      : { from: before[field] ?? null, to: after[field] ?? null };
  }
  return changes;
}

/** Name (accent-insensitive) or email prefix. */
function searchFilter(q: string): SQL {
  return or(
    sql`${contact.nameKey} LIKE '%' || lower(immutable_unaccent(${q}::text)) || '%'`,
    sql`${contact.email} ILIKE ${`${q.replace(/[%_\\]/g, '\\$&')}%`}`,
  )!;
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
