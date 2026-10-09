import { Injectable } from '@nestjs/common';
import {
  type CreateOpportunityRequest,
  type OpportunityDetail,
  type OpportunityListItem,
  type OpportunityListQuery,
  type Page,
  type PermissionKey,
  type UpdateOpportunityRequest,
} from '@ooh/contracts';
import {
  appUser,
  contact,
  membership,
  opportunity,
  organisation,
  pipeline,
  pipelineStage,
  type Transaction,
} from '@ooh/db';
import { and, asc, desc, eq, isNull, lt, or, type SQL, sql } from 'drizzle-orm';
import { AuditService } from '../../core/audit/audit.service';
import { type Principal } from '../../core/auth/principal';
import { DatabaseService } from '../../core/database/database.service';
import { AppError } from '../../core/http/app-error';
import { type ClientInfo } from '../../core/http/client-info';
import { assertIfMatch, type IfMatch } from '../../core/http/concurrency';
import { decodeIdCursor, encodeIdCursor } from '../../core/http/cursor';
import { OutboxService } from '../../core/state/outbox.service';
import { ActivitiesService } from './activities.service';

type Stage = typeof pipelineStage.$inferSelect;
type Locked = typeof opportunity.$inferSelect & { stage: Stage };

const SCALAR_FIELDS = [
  'name',
  'contactId',
  'ownerMembershipId',
  'estimatedValue',
  'currency',
  'expectedCloseDate',
  'probability',
  'source',
  'nextAction',
  'nextFollowUpDate',
] as const;

const notFound = () => new AppError('NOT_FOUND', 'Opportunity not found.');

/**
 * Opportunities and their state machine (docs/architecture/06-state-machines.md §2): move between
 * OPEN stages, win (value + close date), lose (reason), reopen (Management, reason). The database
 * enforces the same preconditions (check constraints on the stage kind). OWN scope = the owner.
 */
@Injectable()
export class OpportunitiesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly activities: ActivitiesService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  list(principal: Principal, query: OpportunityListQuery): Promise<Page<OpportunityListItem>> {
    const after = query.cursor ? decodeIdCursor(query.cursor) : undefined;
    return this.inTenant(principal, async (tx) => {
      const rows = await this.loadItems(
        tx,
        and(
          this.readScope(principal),
          isNull(opportunity.archivedAt),
          query.pipelineId ? eq(pipelineStage.pipelineId, query.pipelineId) : undefined,
          query.organisationId ? eq(opportunity.organisationId, query.organisationId) : undefined,
          query.status ? eq(opportunity.stageKind, query.status) : undefined,
          query.ownerMembershipId ? eq(opportunity.ownerMembershipId, query.ownerMembershipId) : undefined,
          query.q
            ? or(
                sql`lower(immutable_unaccent(${opportunity.name})) LIKE '%' || lower(immutable_unaccent(${query.q}::text)) || '%'`,
                sql`${organisation.nameKey} LIKE '%' || crm_name_key(${query.q}::text) || '%'`,
              )
            : undefined,
          // Newest first (UUIDv7 ids are time-ordered).
          after ? lt(opportunity.id, after) : undefined,
        ),
        query.limit + 1,
      );
      const hasMore = rows.length > query.limit;
      const data = rows.slice(0, query.limit);
      return { data, page: { nextCursor: hasMore ? encodeIdCursor(data.at(-1)!.id) : null, hasMore } };
    });
  }

  get(principal: Principal, id: string): Promise<OpportunityDetail> {
    return this.inTenant(principal, (tx) => this.loadDetail(tx, principal, id));
  }

  create(
    principal: Principal,
    input: CreateOpportunityRequest,
    client: ClientInfo,
  ): Promise<OpportunityDetail> {
    return this.inTenant(principal, async (tx) => {
      await this.assertCompany(tx, principal, input.organisationId);
      if (input.contactId) await this.assertContact(tx, input.organisationId, input.contactId);
      const ownerId = input.ownerMembershipId ?? principal.membershipId;
      if (input.ownerMembershipId) await this.assertOwner(tx, ownerId);
      const stage = await this.firstOpenStage(tx, input.pipelineId);

      const [created] = await tx
        .insert(opportunity)
        .values({
          tenantId: principal.tenantId,
          organisationId: input.organisationId,
          contactId: input.contactId ?? null,
          ownerMembershipId: ownerId,
          name: input.name,
          estimatedValue: input.estimatedValue ?? null,
          currency: input.currency,
          expectedCloseDate: input.expectedCloseDate ?? null,
          probability: input.probability ?? stage.probability,
          source: input.source ?? null,
          nextAction: input.nextAction ?? null,
          nextFollowUpDate: input.nextFollowUpDate ?? null,
          pipelineStageId: stage.id,
          stageKind: 'OPEN',
          createdByMembershipId: principal.membershipId,
        })
        .returning({ id: opportunity.id });
      await this.audit.record(tx, {
        ...actor(principal, client),
        action: 'opportunity.created',
        subjectType: 'opportunity',
        subjectId: created!.id,
        metadata: { organisationId: input.organisationId, stage: stage.name },
      });
      return this.loadDetail(tx, principal, created!.id);
    });
  }

  update(
    principal: Principal,
    id: string,
    input: UpdateOpportunityRequest,
    ifMatch: IfMatch,
    client: ClientInfo,
  ): Promise<OpportunityDetail> {
    return this.inTenant(principal, async (tx) => {
      const current = await this.lock(tx, principal, id, 'opportunity.update');
      if (input.contactId) await this.assertContact(tx, current.organisationId, input.contactId);
      if (input.ownerMembershipId && input.ownerMembershipId !== current.ownerMembershipId)
        await this.assertOwner(tx, input.ownerMembershipId);
      // A won opportunity keeps its value and close date (the database enforces it too).
      if (
        current.stageKind === 'WON' &&
        (input.estimatedValue === null || input.expectedCloseDate === null)
      ) {
        throw new AppError('VALIDATION_FAILED', 'A won opportunity keeps its value and close date.', {
          errors: [
            ...(input.estimatedValue === null
              ? [{ path: 'estimatedValue', message: 'Required once won' }]
              : []),
            ...(input.expectedCloseDate === null
              ? [{ path: 'expectedCloseDate', message: 'Required once won' }]
              : []),
          ],
        });
      }
      assertIfMatch(ifMatch, current.version);

      const changes: Record<string, { from: unknown; to: unknown }> = {};
      const set: Partial<typeof opportunity.$inferInsert> = {};
      for (const field of SCALAR_FIELDS) {
        const next = input[field];
        const before = current[field] as unknown;
        if (next !== undefined && !sameValue(field, before, next)) {
          changes[field] = { from: before ?? null, to: next };
          (set as Record<string, unknown>)[field] = next;
        }
      }
      if (Object.keys(changes).length === 0) return this.loadDetail(tx, principal, id);
      await tx
        .update(opportunity)
        .set({ ...set, version: sql`${opportunity.version} + 1` })
        .where(eq(opportunity.id, id));
      await this.audit.record(tx, {
        ...actor(principal, client),
        action: 'opportunity.updated',
        subjectType: 'opportunity',
        subjectId: id,
        changes,
      });
      return this.loadDetail(tx, principal, id);
    });
  }

  /** OPEN → another OPEN stage of the same pipeline; logged on the company timeline. */
  moveStage(
    principal: Principal,
    id: string,
    stageId: string,
    ifMatch: IfMatch,
    client: ClientInfo,
  ): Promise<OpportunityDetail> {
    return this.inTenant(principal, async (tx) => {
      const current = await this.lock(tx, principal, id, 'opportunity.update');
      requireOpen(current, 'Only open opportunities move between stages. Reopen it first.');
      const target = await this.stageOfPipeline(tx, current.stage.pipelineId, stageId);
      if (target.kind !== 'OPEN') {
        throw new AppError('VALIDATION_FAILED', 'Use win or lose to close an opportunity.', {
          errors: [{ path: 'stageId', message: 'Not an open stage' }],
        });
      }
      assertIfMatch(ifMatch, current.version);
      if (target.id === current.pipelineStageId) return this.loadDetail(tx, principal, id);
      await this.setStage(tx, id, target, { probability: target.probability ?? current.probability });
      await this.logAndAudit(tx, principal, client, current, 'opportunity.stage_moved', {
        subject: `Moved from ${current.stage.name} to ${target.name}`,
        changes: { stage: { from: current.stage.name, to: target.name } },
      });
      return this.loadDetail(tx, principal, id);
    });
  }

  /** OPEN → WON: needs an estimated value and a close date (given now or already set). */
  win(
    principal: Principal,
    id: string,
    input: { estimatedValue?: string; expectedCloseDate?: string },
    ifMatch: IfMatch,
    client: ClientInfo,
  ): Promise<OpportunityDetail> {
    return this.inTenant(principal, async (tx) => {
      const current = await this.lock(tx, principal, id, 'opportunity.close');
      requireOpen(current, 'This opportunity is already closed.');
      const estimatedValue = input.estimatedValue ?? current.estimatedValue;
      const expectedCloseDate = input.expectedCloseDate ?? current.expectedCloseDate;
      const missing = [
        ...(estimatedValue ? [] : [{ path: 'estimatedValue', message: 'Required to win' }]),
        ...(expectedCloseDate ? [] : [{ path: 'expectedCloseDate', message: 'Required to win' }]),
      ];
      if (missing.length > 0) {
        throw new AppError('VALIDATION_FAILED', 'Winning needs the estimated value and the close date.', {
          errors: missing,
        });
      }
      const won = await this.closingStage(tx, current.stage.pipelineId, 'WON');
      assertIfMatch(ifMatch, current.version);
      await this.setStage(tx, id, won, {
        estimatedValue,
        expectedCloseDate,
        probability: 100,
        closedAt: new Date(),
      });
      await this.logAndAudit(tx, principal, client, current, 'opportunity.won', {
        subject: `Won (${estimatedValue} ${current.currency})`,
        changes: { stage: { from: current.stage.name, to: won.name } },
      });
      // 06-state-machines.md §2: opportunity.won → task "Create brief" (handled by the worker).
      await this.outbox.publish(tx, principal.tenantId, 'opportunity.won', {
        opportunityId: id,
        organisationId: current.organisationId,
        ownerMembershipId: current.ownerMembershipId,
        name: current.name,
        estimatedValue,
        currency: current.currency,
        actorMembershipId: principal.membershipId,
      });
      return this.loadDetail(tx, principal, id);
    });
  }

  /** OPEN → LOST with a reason. */
  lose(
    principal: Principal,
    id: string,
    lostReason: string,
    ifMatch: IfMatch,
    client: ClientInfo,
  ): Promise<OpportunityDetail> {
    return this.inTenant(principal, async (tx) => {
      const current = await this.lock(tx, principal, id, 'opportunity.close');
      requireOpen(current, 'This opportunity is already closed.');
      const lost = await this.closingStage(tx, current.stage.pipelineId, 'LOST');
      assertIfMatch(ifMatch, current.version);
      await this.setStage(tx, id, lost, { lostReason, probability: 0, closedAt: new Date() });
      await this.logAndAudit(tx, principal, client, current, 'opportunity.lost', {
        subject: 'Lost',
        body: lostReason,
        changes: { stage: { from: current.stage.name, to: lost.name } },
        metadata: { lostReason },
      });
      return this.loadDetail(tx, principal, id);
    });
  }

  /** WON/LOST → OPEN (Management), with a reason, into the given or the first open stage. */
  reopen(
    principal: Principal,
    id: string,
    input: { reason: string; stageId?: string },
    ifMatch: IfMatch,
    client: ClientInfo,
  ): Promise<OpportunityDetail> {
    return this.inTenant(principal, async (tx) => {
      const current = await this.lock(tx, principal, id, 'opportunity.reopen');
      if (current.stageKind === 'OPEN') {
        throw new AppError('INVALID_TRANSITION', 'This opportunity is already open.');
      }
      const target = input.stageId
        ? await this.stageOfPipeline(tx, current.stage.pipelineId, input.stageId)
        : await this.firstOpenStage(tx, current.stage.pipelineId);
      if (target.kind !== 'OPEN') {
        throw new AppError('VALIDATION_FAILED', 'Reopen into an open stage.', {
          errors: [{ path: 'stageId', message: 'Not an open stage' }],
        });
      }
      assertIfMatch(ifMatch, current.version);
      await this.setStage(tx, id, target, {
        lostReason: null,
        closedAt: null,
        probability: target.probability,
      });
      await this.logAndAudit(tx, principal, client, current, 'opportunity.reopened', {
        subject: `Reopened into ${target.name}`,
        body: input.reason,
        changes: { stage: { from: current.stage.name, to: target.name } },
        metadata: { reason: input.reason },
      });
      return this.loadDetail(tx, principal, id);
    });
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private inTenant<T>(principal: Principal, fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.database.withTenant({ tenantId: principal.tenantId, actorUserId: principal.userId }, fn);
  }

  private readScope(principal: Principal): SQL | undefined {
    return principal.permissions.get('opportunity.read') === 'OWN'
      ? eq(opportunity.ownerMembershipId, principal.membershipId)
      : undefined;
  }

  /**
   * Locks a live opportunity for a change: outside the read scope it doesn't exist (404); readable
   * but outside the change scope (OWN = owner) is a 403 with the reason.
   */
  private async lock(
    tx: Transaction,
    principal: Principal,
    id: string,
    permission: PermissionKey,
  ): Promise<Locked> {
    const [row] = await tx
      .select({ opportunity, stage: pipelineStage })
      .from(opportunity)
      .innerJoin(pipelineStage, eq(pipelineStage.id, opportunity.pipelineStageId))
      .where(and(eq(opportunity.id, id), isNull(opportunity.archivedAt), this.readScope(principal)))
      .for('update', { of: opportunity });
    if (!row) throw notFound();
    if (
      principal.permissions.get(permission) === 'OWN' &&
      row.opportunity.ownerMembershipId !== principal.membershipId
    ) {
      throw new AppError('FORBIDDEN', 'You can only change opportunities you own.');
    }
    return { ...row.opportunity, stage: row.stage };
  }

  private async setStage(
    tx: Transaction,
    id: string,
    stage: Stage,
    extra: Partial<typeof opportunity.$inferInsert>,
  ): Promise<void> {
    await tx
      .update(opportunity)
      .set({
        pipelineStageId: stage.id,
        stageKind: stage.kind,
        ...extra,
        version: sql`${opportunity.version} + 1`,
      })
      .where(eq(opportunity.id, id));
  }

  private async logAndAudit(
    tx: Transaction,
    principal: Principal,
    client: ClientInfo,
    current: Locked,
    action: string,
    entry: {
      subject: string;
      body?: string;
      changes: Record<string, { from: unknown; to: unknown }>;
      metadata?: Record<string, unknown>;
    },
  ): Promise<void> {
    await this.activities.logSystem(tx, principal.tenantId, {
      organisationId: current.organisationId,
      opportunityId: current.id,
      subject: entry.subject,
      ...(entry.body ? { body: entry.body } : {}),
    });
    await this.audit.record(tx, {
      ...actor(principal, client),
      action,
      subjectType: 'opportunity',
      subjectId: current.id,
      changes: entry.changes,
      ...(entry.metadata ? { metadata: entry.metadata } : {}),
    });
  }

  /** The first active OPEN stage of the given (or the default) active pipeline. */
  private async firstOpenStage(tx: Transaction, pipelineId?: string): Promise<Stage> {
    const [stage] = await tx
      .select({ stage: pipelineStage })
      .from(pipelineStage)
      .innerJoin(pipeline, eq(pipeline.id, pipelineStage.pipelineId))
      .where(
        and(
          pipelineId ? eq(pipeline.id, pipelineId) : eq(pipeline.isDefault, true),
          eq(pipeline.active, true),
          eq(pipelineStage.kind, 'OPEN'),
          eq(pipelineStage.active, true),
        ),
      )
      .orderBy(asc(pipelineStage.position))
      .limit(1);
    if (!stage) {
      throw new AppError('VALIDATION_FAILED', 'Unknown or inactive pipeline.', {
        errors: [{ path: 'pipelineId', message: 'Unknown or inactive pipeline' }],
      });
    }
    return stage.stage;
  }

  private async stageOfPipeline(tx: Transaction, pipelineId: string, stageId: string): Promise<Stage> {
    const [stage] = await tx
      .select()
      .from(pipelineStage)
      .where(
        and(
          eq(pipelineStage.id, stageId),
          eq(pipelineStage.pipelineId, pipelineId),
          eq(pipelineStage.active, true),
        ),
      );
    if (!stage) {
      throw new AppError('VALIDATION_FAILED', 'Unknown stage for this pipeline.', {
        errors: [{ path: 'stageId', message: 'Not a stage of this pipeline' }],
      });
    }
    return stage;
  }

  private async closingStage(tx: Transaction, pipelineId: string, kind: 'WON' | 'LOST'): Promise<Stage> {
    const [stage] = await tx
      .select()
      .from(pipelineStage)
      .where(and(eq(pipelineStage.pipelineId, pipelineId), eq(pipelineStage.kind, kind)));
    if (!stage) throw new Error(`Pipeline ${pipelineId} has no ${kind} stage`);
    return stage;
  }

  private async assertCompany(tx: Transaction, principal: Principal, organisationId: string): Promise<void> {
    const [company] = await tx
      .select({ archivedAt: organisation.archivedAt })
      .from(organisation)
      .where(
        and(
          eq(organisation.id, organisationId),
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
  }

  /** A live contact of the same company (the composite FK guarantees the company too). */
  private async assertContact(tx: Transaction, organisationId: string, contactId: string): Promise<void> {
    const [person] = await tx
      .select({ id: contact.id })
      .from(contact)
      .where(
        and(
          eq(contact.id, contactId),
          eq(contact.organisationId, organisationId),
          isNull(contact.archivedAt),
        ),
      );
    if (!person) {
      throw new AppError('VALIDATION_FAILED', 'The contact must be a current contact of this company.', {
        errors: [{ path: 'contactId', message: 'Not a current contact of this company' }],
      });
    }
  }

  /** Owners are active internal members. */
  private async assertOwner(tx: Transaction, membershipId: string): Promise<void> {
    const [owner] = await tx
      .select({ status: membership.status, kind: membership.kind })
      .from(membership)
      .where(eq(membership.id, membershipId));
    if (!owner || owner.status !== 'ACTIVE' || owner.kind !== 'INTERNAL') {
      throw new AppError('VALIDATION_FAILED', 'The owner must be an active internal member.', {
        errors: [{ path: 'ownerMembershipId', message: 'Not an active internal member' }],
      });
    }
  }

  private async loadDetail(tx: Transaction, principal: Principal, id: string): Promise<OpportunityDetail> {
    const [item] = await this.loadItems(
      tx,
      and(eq(opportunity.id, id), isNull(opportunity.archivedAt), this.readScope(principal)),
      1,
    );
    if (!item) throw notFound();
    const [extra] = await tx
      .select({
        source: opportunity.source,
        nextAction: opportunity.nextAction,
        lostReason: opportunity.lostReason,
        createdAt: opportunity.createdAt,
        updatedAt: opportunity.updatedAt,
      })
      .from(opportunity)
      .where(eq(opportunity.id, id));
    return {
      ...item,
      ...extra!,
      createdAt: extra!.createdAt.toISOString(),
      updatedAt: extra!.updatedAt.toISOString(),
    };
  }

  private async loadItems(
    tx: Transaction,
    where: SQL | undefined,
    limit: number,
  ): Promise<OpportunityListItem[]> {
    const rows = await tx
      .select({
        id: opportunity.id,
        name: opportunity.name,
        organisationId: organisation.id,
        organisationName: organisation.displayName,
        contactId: contact.id,
        contactFirst: contact.firstName,
        contactLast: contact.lastName,
        ownerId: opportunity.ownerMembershipId,
        ownerName: appUser.displayName,
        stageId: pipelineStage.id,
        stageName: pipelineStage.name,
        stageKind: pipelineStage.kind,
        pipelineId: pipelineStage.pipelineId,
        estimatedValue: opportunity.estimatedValue,
        currency: opportunity.currency,
        expectedCloseDate: opportunity.expectedCloseDate,
        probability: opportunity.probability,
        nextFollowUpDate: opportunity.nextFollowUpDate,
        closedAt: opportunity.closedAt,
        version: opportunity.version,
      })
      .from(opportunity)
      .innerJoin(organisation, eq(organisation.id, opportunity.organisationId))
      .innerJoin(pipelineStage, eq(pipelineStage.id, opportunity.pipelineStageId))
      .innerJoin(membership, eq(membership.id, opportunity.ownerMembershipId))
      .innerJoin(appUser, eq(appUser.id, membership.userId))
      .leftJoin(contact, eq(contact.id, opportunity.contactId))
      .where(where)
      .orderBy(desc(opportunity.id))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      organisation: { id: r.organisationId, displayName: r.organisationName },
      contact: r.contactId
        ? { id: r.contactId, name: [r.contactFirst, r.contactLast].filter(Boolean).join(' ') }
        : null,
      owner: { membershipId: r.ownerId, displayName: r.ownerName },
      stage: { id: r.stageId, name: r.stageName, kind: r.stageKind, pipelineId: r.pipelineId },
      estimatedValue: r.estimatedValue,
      currency: r.currency as OpportunityListItem['currency'],
      expectedCloseDate: r.expectedCloseDate,
      probability: r.probability,
      nextFollowUpDate: r.nextFollowUpDate,
      closedAt: r.closedAt?.toISOString() ?? null,
      version: r.version,
    }));
  }
}

function requireOpen(current: Locked, message: string): void {
  if (current.stageKind !== 'OPEN') throw new AppError('INVALID_TRANSITION', message);
}

/** numeric comes back as "12000.00": compare amounts numerically, everything else strictly. */
function sameValue(field: string, before: unknown, next: unknown): boolean {
  if (field === 'estimatedValue' && before != null && next != null) return Number(before) === Number(next);
  return before === next;
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
