import { Injectable } from '@nestjs/common';
import {
  type ActivityItem,
  type ActivityListQuery,
  type CreateActivityRequest,
  type Page,
  STAGE_CHANGE_ACTIVITY_TYPE,
  type UpdateActivityRequest,
} from '@ooh/contracts';
import {
  activity,
  activityType,
  appUser,
  contact,
  membership,
  opportunity,
  organisation,
  type Transaction,
} from '@ooh/db';
import { and, desc, eq, isNull, type SQL, sql } from 'drizzle-orm';
import { AuditService } from '../../core/audit/audit.service';
import { type Principal } from '../../core/auth/principal';
import { DatabaseService } from '../../core/database/database.service';
import { AppError } from '../../core/http/app-error';
import { type ClientInfo } from '../../core/http/client-info';
import { assertIfMatch, type IfMatch } from '../../core/http/concurrency';
import { decodeKeysetCursor, encodeKeysetCursor } from '../../core/http/cursor';

const notFound = () => new AppError('NOT_FOUND', 'Activity not found.');

/**
 * The timeline of a company: activities logged by people (calls, meetings…) and entries the
 * platform writes itself (stage changes). OWN scope = the author. System entries are never edited.
 */
@Injectable()
export class ActivitiesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  list(principal: Principal, query: ActivityListQuery): Promise<Page<ActivityItem>> {
    const after = query.cursor ? decodeKeysetCursor(query.cursor) : undefined;
    return this.inTenant(principal, async (tx) => {
      const rows = await this.loadItems(
        tx,
        and(
          principal.permissions.get('activity.read') === 'OWN'
            ? eq(activity.authorMembershipId, principal.membershipId)
            : undefined,
          query.organisationId ? eq(activity.organisationId, query.organisationId) : undefined,
          query.opportunityId ? eq(activity.opportunityId, query.opportunityId) : undefined,
          query.contactId ? eq(activity.contactId, query.contactId) : undefined,
          // Newest first: (occurred_at, id) strictly before the cursor.
          after
            ? sql`(${activity.occurredAt}, ${activity.id}) < (${after.sortKey}::timestamptz, ${after.id}::uuid)`
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
          nextCursor: hasMore && last ? encodeKeysetCursor(last.sortKey, last.item.id) : null,
          hasMore,
        },
      };
    });
  }

  create(principal: Principal, input: CreateActivityRequest, client: ClientInfo): Promise<ActivityItem> {
    return this.inTenant(principal, async (tx) => {
      const [company] = await tx
        .select({ archivedAt: organisation.archivedAt })
        .from(organisation)
        .where(eq(organisation.id, input.organisationId));
      if (!company) throw invalid('organisationId', 'Unknown company');
      if (company.archivedAt) throw new AppError('INVALID_TRANSITION', 'This company is archived.');
      await this.assertUserType(tx, input.activityTypeId);
      if (input.contactId) await this.assertBelongs(tx, 'contactId', input.organisationId, input.contactId);
      if (input.opportunityId)
        await this.assertBelongs(tx, 'opportunityId', input.organisationId, input.opportunityId);

      const [created] = await tx
        .insert(activity)
        .values({
          tenantId: principal.tenantId,
          organisationId: input.organisationId,
          contactId: input.contactId ?? null,
          opportunityId: input.opportunityId ?? null,
          activityTypeId: input.activityTypeId,
          occurredAt: input.occurredAt ? new Date(input.occurredAt) : new Date(),
          subject: input.subject,
          body: input.body ?? null,
          authorMembershipId: principal.membershipId,
        })
        .returning({ id: activity.id });
      await this.audit.record(tx, {
        ...actor(principal, client),
        action: 'activity.created',
        subjectType: 'activity',
        subjectId: created!.id,
        metadata: { organisationId: input.organisationId },
      });
      return this.loadItem(tx, created!.id);
    });
  }

  update(
    principal: Principal,
    id: string,
    input: UpdateActivityRequest,
    ifMatch: IfMatch,
    client: ClientInfo,
  ): Promise<ActivityItem> {
    return this.inTenant(principal, async (tx) => {
      const [current] = await tx
        .select({ activity, isSystem: activityType.isSystem })
        .from(activity)
        .innerJoin(activityType, eq(activityType.id, activity.activityTypeId))
        .where(eq(activity.id, id))
        .for('update', { of: activity });
      if (!current) throw notFound();
      if (current.isSystem)
        throw new AppError('INVALID_TRANSITION', 'Entries written by the platform can’t be edited.');
      if (
        principal.permissions.get('activity.update') === 'OWN' &&
        current.activity.authorMembershipId !== principal.membershipId
      ) {
        throw new AppError('FORBIDDEN', 'You can only edit activities you logged.');
      }
      if (input.activityTypeId) await this.assertUserType(tx, input.activityTypeId);
      assertIfMatch(ifMatch, current.activity.version);

      await tx
        .update(activity)
        .set({
          ...(input.activityTypeId ? { activityTypeId: input.activityTypeId } : {}),
          ...(input.occurredAt ? { occurredAt: new Date(input.occurredAt) } : {}),
          ...(input.subject !== undefined ? { subject: input.subject } : {}),
          ...(input.body !== undefined ? { body: input.body } : {}),
          version: sql`${activity.version} + 1`,
        })
        .where(eq(activity.id, id));
      await this.audit.record(tx, {
        ...actor(principal, client),
        action: 'activity.updated',
        subjectType: 'activity',
        subjectId: id,
        // The body may hold personal data (05-domain-model §4): record which fields changed only.
        metadata: {
          fields: Object.keys(input).filter((k) => input[k as keyof UpdateActivityRequest] !== undefined),
        },
      });
      return this.loadItem(tx, id);
    });
  }

  /** A platform-written timeline entry (e.g. "Moved from Lead to Proposal"), inside the caller's tx. */
  async logSystem(
    tx: Transaction,
    tenantId: string,
    entry: { organisationId: string; opportunityId: string; subject: string; body?: string },
  ): Promise<void> {
    const [type] = await tx
      .select({ id: activityType.id })
      .from(activityType)
      .where(eq(activityType.key, STAGE_CHANGE_ACTIVITY_TYPE));
    if (!type) return; // tenant removed nothing (system types can't be deleted), but stay defensive
    await tx.insert(activity).values({
      tenantId,
      organisationId: entry.organisationId,
      opportunityId: entry.opportunityId,
      activityTypeId: type.id,
      subject: entry.subject,
      body: entry.body ?? null,
      authorMembershipId: null,
    });
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private inTenant<T>(principal: Principal, fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.database.withTenant({ tenantId: principal.tenantId, actorUserId: principal.userId }, fn);
  }

  /** Only active, user-selectable types (system types are written by the platform). */
  private async assertUserType(tx: Transaction, activityTypeId: string): Promise<void> {
    const [type] = await tx
      .select({ isSystem: activityType.isSystem, active: activityType.active })
      .from(activityType)
      .where(eq(activityType.id, activityTypeId));
    if (!type || type.isSystem || !type.active)
      throw invalid('activityTypeId', 'Unknown or unavailable type');
  }

  /** The contact or opportunity must be of the same company (also guaranteed by composite FKs). */
  private async assertBelongs(
    tx: Transaction,
    field: 'contactId' | 'opportunityId',
    organisationId: string,
    id: string,
  ): Promise<void> {
    const table = field === 'contactId' ? contact : opportunity;
    const [row] = await tx
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.id, id), eq(table.organisationId, organisationId)));
    if (!row) throw invalid(field, 'Not of this company');
  }

  private async loadItem(tx: Transaction, id: string): Promise<ActivityItem> {
    const [row] = await this.loadItems(tx, eq(activity.id, id), 1);
    if (!row) throw notFound();
    return row.item;
  }

  /**
   * `sortKey` is occurred_at as PostgreSQL prints it: microsecond precision, which a JS Date would
   * truncate (a cursor built from it could skip entries logged within the same millisecond).
   */
  private async loadItems(
    tx: Transaction,
    where: SQL | undefined,
    limit: number,
  ): Promise<{ sortKey: string; item: ActivityItem }[]> {
    const rows = await tx
      .select({
        id: activity.id,
        organisationId: organisation.id,
        organisationName: organisation.displayName,
        contactId: contact.id,
        contactFirst: contact.firstName,
        contactLast: contact.lastName,
        opportunityId: opportunity.id,
        opportunityName: opportunity.name,
        typeId: activityType.id,
        typeKey: activityType.key,
        typeName: activityType.name,
        typeIsSystem: activityType.isSystem,
        occurredAt: activity.occurredAt,
        sortKey: sql<string>`${activity.occurredAt}::text`,
        subject: activity.subject,
        body: activity.body,
        authorId: activity.authorMembershipId,
        authorName: appUser.displayName,
        version: activity.version,
      })
      .from(activity)
      .innerJoin(organisation, eq(organisation.id, activity.organisationId))
      .innerJoin(activityType, eq(activityType.id, activity.activityTypeId))
      .leftJoin(contact, eq(contact.id, activity.contactId))
      .leftJoin(opportunity, and(eq(opportunity.id, activity.opportunityId), isNull(opportunity.archivedAt)))
      .leftJoin(membership, eq(membership.id, activity.authorMembershipId))
      .leftJoin(appUser, eq(appUser.id, membership.userId))
      .where(where)
      .orderBy(desc(activity.occurredAt), desc(activity.id))
      .limit(limit);
    return rows.map((r) => ({
      sortKey: r.sortKey,
      item: {
        id: r.id,
        organisation: { id: r.organisationId, displayName: r.organisationName },
        contact: r.contactId
          ? { id: r.contactId, name: [r.contactFirst, r.contactLast].filter(Boolean).join(' ') }
          : null,
        opportunity: r.opportunityId ? { id: r.opportunityId, name: r.opportunityName ?? '' } : null,
        type: { id: r.typeId, key: r.typeKey, name: r.typeName, isSystem: r.typeIsSystem },
        occurredAt: r.occurredAt.toISOString(),
        subject: r.subject,
        body: r.body,
        author: r.authorId ? { membershipId: r.authorId, displayName: r.authorName ?? '' } : null,
        version: r.version,
      },
    }));
  }
}

function invalid(path: string, message: string): AppError {
  return new AppError('VALIDATION_FAILED', message, { errors: [{ path, message }] });
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
