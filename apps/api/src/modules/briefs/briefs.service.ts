import { Injectable } from '@nestjs/common';
import {
  allowedActions,
  BRIEF_TRANSITIONS,
  type BriefAction,
  type BriefDetail,
  type ConvertBriefRequest,
  type BriefLineInput,
  type BriefLineItem,
  type BriefListItem,
  type BriefListQuery,
  briefConfirmProblems,
  type CreateBriefRequest,
  type Page,
  type PermissionKey,
  type UpdateBriefRequest,
  wonOpportunityTaskKey,
} from '@ooh/contracts';
import {
  appUser,
  brief,
  briefLine,
  campaign,
  membership,
  opportunity,
  organisation,
  type Transaction,
} from '@ooh/db';
import { and, asc, eq, isNull, lt, type SQL, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { AuditService } from '../../core/audit/audit.service';
import { type Principal } from '../../core/auth/principal';
import { DatabaseService } from '../../core/database/database.service';
import { AppError } from '../../core/http/app-error';
import { type ClientInfo } from '../../core/http/client-info';
import { assertIfMatch, type IfMatch } from '../../core/http/concurrency';
import { decodeIdCursor, encodeIdCursor } from '../../core/http/cursor';
import { TransitionsService } from '../../core/state/transitions.service';
import { CampaignsService } from '../campaigns/campaigns.service';
import { TasksService } from '../tasks/tasks.service';

type Row = typeof brief.$inferSelect;
type Changes = Record<string, { from: unknown; to: unknown }>;

const SCALAR_FIELDS = [
  'title',
  'clientOrganisationId',
  'agencyOrganisationId',
  'ownerMembershipId',
  'requestedStart',
  'requestedEnd',
  'datesTbd',
  'deadline',
  'budget',
  'currency',
  'specialRequirements',
] as const;

const notFound = () => new AppError('NOT_FOUND', 'Brief not found.');

/**
 * Briefs (04-user-flows.md A2'–A4, 06-state-machines.md §3). Drafts are edited by buyers; Sales may
 * create (with lines) but not edit. OWN scope = the brief's owner. Every status change writes
 * status_history, audit and an outbox event in the same transaction.
 */
@Injectable()
export class BriefsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly transitions: TransitionsService,
    private readonly tasks: TasksService,
    private readonly campaigns: CampaignsService,
  ) {}

  list(principal: Principal, query: BriefListQuery): Promise<Page<BriefListItem>> {
    const after = query.cursor ? decodeIdCursor(query.cursor) : undefined;
    return this.inTenant(principal, async (tx) => {
      const rows = await this.loadItems(
        tx,
        and(
          this.readScope(principal),
          query.status ? eq(brief.status, query.status) : undefined,
          query.clientOrganisationId ? eq(brief.clientOrganisationId, query.clientOrganisationId) : undefined,
          query.opportunityId ? eq(brief.opportunityId, query.opportunityId) : undefined,
          query.q
            ? sql`lower(immutable_unaccent(${brief.title})) LIKE '%' || lower(immutable_unaccent(${query.q}::text)) || '%'`
            : undefined,
          // Newest first (UUIDv7 ids are time-ordered).
          after ? lt(brief.id, after) : undefined,
        ),
        query.limit + 1,
      );
      const hasMore = rows.length > query.limit;
      const data = rows.slice(0, query.limit);
      return { data, page: { nextCursor: hasMore ? encodeIdCursor(data.at(-1)!.id) : null, hasMore } };
    });
  }

  get(principal: Principal, id: string): Promise<BriefDetail> {
    return this.inTenant(principal, (tx) => this.loadDetail(tx, principal, id));
  }

  create(principal: Principal, input: CreateBriefRequest, client: ClientInfo): Promise<BriefDetail> {
    return this.inTenant(principal, async (tx) => {
      await this.assertCompanies(tx, input);
      const ownerMembershipId = input.ownerMembershipId ?? principal.membershipId;
      await assertOwner(tx, ownerMembershipId);
      const id = await this.insertBrief(tx, principal, client, {
        title: input.title,
        source: 'MANUAL',
        clientOrganisationId: input.clientOrganisationId ?? null,
        agencyOrganisationId: input.agencyOrganisationId ?? null,
        ownerMembershipId,
        requestedStart: input.requestedStart ?? null,
        requestedEnd: input.requestedEnd ?? null,
        datesTbd: input.datesTbd,
        deadline: input.deadline ?? null,
        budget: input.budget ?? null,
        currency: input.currency,
        specialRequirements: input.specialRequirements ?? null,
      });
      await insertLines(tx, principal.tenantId, id, input.lines);
      return this.loadDetail(tx, principal, id);
    });
  }

  /**
   * POST /opportunities/{id}/brief (04-user-flows.md A2'): a draft from a won opportunity, prefilled
   * with its company, name and value. Completes the opportunity's "Create brief" task.
   */
  createFromOpportunity(
    principal: Principal,
    opportunityId: string,
    client: ClientInfo,
  ): Promise<BriefDetail> {
    return this.inTenant(principal, async (tx) => {
      const [deal] = principal.permissions.has('opportunity.read')
        ? await tx
            .select()
            .from(opportunity)
            .where(
              and(
                eq(opportunity.id, opportunityId),
                isNull(opportunity.archivedAt),
                principal.permissions.get('opportunity.read') === 'OWN'
                  ? eq(opportunity.ownerMembershipId, principal.membershipId)
                  : undefined,
              ),
            )
            .for('update')
        : [];
      if (!deal) throw new AppError('NOT_FOUND', 'Opportunity not found.');
      if (deal.stageKind !== 'WON') {
        throw new AppError('INVALID_TRANSITION', 'Only a won opportunity becomes a brief.');
      }
      const [existing] = await tx
        .select({ id: brief.id })
        .from(brief)
        .where(and(eq(brief.opportunityId, opportunityId), sql`${brief.status} <> 'DISCARDED'`));
      if (existing) {
        throw new AppError('CONFLICT', 'This opportunity already has a brief.', {
          meta: { briefId: existing.id },
        });
      }
      const id = await this.insertBrief(tx, principal, client, {
        title: deal.name,
        source: 'OPPORTUNITY',
        opportunityId,
        clientOrganisationId: deal.organisationId,
        agencyOrganisationId: null,
        ownerMembershipId: principal.membershipId,
        requestedStart: null,
        requestedEnd: null,
        datesTbd: false,
        deadline: null,
        budget: deal.estimatedValue,
        currency: deal.currency,
        specialRequirements: null,
      });
      await this.tasks.completeSystemTask(tx, principal, client, wonOpportunityTaskKey(opportunityId));
      return this.loadDetail(tx, principal, id);
    });
  }

  /** Edits a draft; AI-filled fields a person changes become AI_EDITED. */
  update(
    principal: Principal,
    id: string,
    input: UpdateBriefRequest,
    ifMatch: IfMatch,
    client: ClientInfo,
  ): Promise<BriefDetail> {
    return this.inTenant(principal, async (tx) => {
      const current = await this.lock(tx, principal, id, 'brief.update');
      requireDraft(current);
      await this.assertCompanies(tx, input);
      if (input.ownerMembershipId && input.ownerMembershipId !== current.ownerMembershipId)
        await assertOwner(tx, input.ownerMembershipId);
      const start = input.requestedStart === undefined ? current.requestedStart : input.requestedStart;
      const end = input.requestedEnd === undefined ? current.requestedEnd : input.requestedEnd;
      if (start && end && end < start) {
        throw new AppError('VALIDATION_FAILED', 'The end date is before the start date.', {
          errors: [{ path: 'requestedEnd', message: 'The end date is before the start date' }],
        });
      }
      assertIfMatch(ifMatch, current.version);

      const changes: Changes = {};
      for (const field of SCALAR_FIELDS) {
        const value = input[field];
        if (value !== undefined && value !== current[field])
          changes[field] = { from: current[field], to: value };
      }
      if (Object.keys(changes).length === 0) return this.loadDetail(tx, principal, id);
      const provenance = { ...current.fieldProvenance };
      for (const field of Object.keys(changes))
        if (provenance[field] === 'AI') provenance[field] = 'AI_EDITED';

      await tx
        .update(brief)
        .set({
          ...Object.fromEntries(
            Object.keys(changes).map((f) => [f, input[f as (typeof SCALAR_FIELDS)[number]]]),
          ),
          fieldProvenance: provenance,
          version: sql`${brief.version} + 1`,
        })
        .where(eq(brief.id, id));
      await this.audit.record(tx, {
        ...actor(principal, client),
        action: 'brief.updated',
        subjectType: 'brief',
        subjectId: id,
        changes,
      });
      return this.loadDetail(tx, principal, id);
    });
  }

  /** Replaces all lines of a draft (If-Match on the brief, whose version moves on). */
  replaceLines(
    principal: Principal,
    id: string,
    lines: BriefLineInput[],
    ifMatch: IfMatch,
    client: ClientInfo,
  ): Promise<BriefDetail> {
    return this.inTenant(principal, async (tx) => {
      const current = await this.lock(tx, principal, id, 'brief.update');
      requireDraft(current);
      assertIfMatch(ifMatch, current.version);
      const before = await tx
        .select({ storeName: briefLine.storeName })
        .from(briefLine)
        .where(eq(briefLine.briefId, id))
        .orderBy(asc(briefLine.position));
      await tx.delete(briefLine).where(eq(briefLine.briefId, id));
      await insertLines(tx, principal.tenantId, id, lines);
      await tx
        .update(brief)
        .set({ version: sql`${brief.version} + 1` })
        .where(eq(brief.id, id));
      await this.audit.record(tx, {
        ...actor(principal, client),
        action: 'brief.lines_replaced',
        subjectType: 'brief',
        subjectId: id,
        changes: { lines: { from: before.map((l) => l.storeName), to: lines.map((l) => l.storeName) } },
      });
      return this.loadDetail(tx, principal, id);
    });
  }

  /** confirm / reopen / discard (the table in contracts is the single source of the rules). */
  transition(
    principal: Principal,
    id: string,
    action: Exclude<BriefAction, 'convert'>,
    input: { reason?: string },
    ifMatch: IfMatch,
    client: ClientInfo,
  ): Promise<BriefDetail> {
    const rule = BRIEF_TRANSITIONS[action];
    return this.inTenant(principal, async (tx) => {
      const current = await this.lock(tx, principal, id, rule.permission);
      if (!rule.from.includes(current.status)) {
        throw new AppError('INVALID_TRANSITION', `A ${current.status.toLowerCase()} brief can't ${action}.`, {
          meta: { allowedActions: allowedActions(BRIEF_TRANSITIONS, current.status) },
        });
      }
      if (action === 'confirm') {
        const lines = await tx
          .select({ address: briefLine.address, city: briefLine.city })
          .from(briefLine)
          .where(eq(briefLine.briefId, id));
        const problems = briefConfirmProblems({ ...current, lines });
        if (problems.length > 0) {
          throw new AppError('VALIDATION_FAILED', 'The brief is missing what a campaign needs.', {
            errors: problems,
          });
        }
      }
      assertIfMatch(ifMatch, current.version);
      const to = rule.to === 'PREVIOUS' ? current.status : rule.to; // briefs never resume
      await tx
        .update(brief)
        .set({
          status: to,
          ...(action === 'confirm' ? { confirmedAt: new Date() } : {}),
          ...(action === 'reopen' ? { confirmedAt: null } : {}),
          ...(action === 'discard' ? { discardReason: input.reason } : {}),
          version: sql`${brief.version} + 1`,
        })
        .where(eq(brief.id, id));
      await this.transitions.record(tx, principal, client, {
        subjectType: 'brief',
        subjectId: id,
        from: current.status,
        to,
        action,
        event: { confirm: 'brief.confirmed', reopen: 'brief.reopened', discard: 'brief.discarded' }[action],
        ...(input.reason ? { reason: input.reason } : {}),
      });
      return this.loadDetail(tx, principal, id);
    });
  }

  /**
   * CONFIRMED → CONVERTED (04-user-flows.md A5): a new campaign (or an existing one of the same client,
   * OPD-07b) gets one DRAFT location per store line, all in one transaction. Each location's
   * `campaign_location.created` event drives geocoding and its "Research …" task (M3c).
   */
  convert(
    principal: Principal,
    id: string,
    input: ConvertBriefRequest,
    ifMatch: IfMatch,
    client: ClientInfo,
  ): Promise<BriefDetail> {
    return this.inTenant(principal, async (tx) => {
      const current = await this.lock(tx, principal, id, 'brief.convert');
      if (current.status !== 'CONFIRMED') {
        throw new AppError('INVALID_TRANSITION', 'Only a confirmed brief becomes a campaign.', {
          meta: { allowedActions: allowedActions(BRIEF_TRANSITIONS, current.status) },
        });
      }
      if (!current.clientOrganisationId) throw invalidField('clientOrganisationId', 'Choose the client');
      let campaignId = input.campaignId;
      if (campaignId) {
        if (!principal.permissions.has('campaign_location.manage'))
          throw new AppError('FORBIDDEN', 'Adding stores to a campaign needs campaign_location.manage.');
        const [target] = await tx
          .select({ clientId: campaign.clientOrganisationId, status: campaign.status })
          .from(campaign)
          .where(and(eq(campaign.id, campaignId), isNull(campaign.archivedAt)))
          .for('update');
        if (!target) throw invalidField('campaignId', 'Unknown campaign');
        if (target.clientId !== current.clientOrganisationId)
          throw invalidField('campaignId', 'The campaign belongs to another client');
        if (target.status === 'COMPLETED' || target.status === 'CANCELLED')
          throw new AppError('INVALID_TRANSITION', `That campaign is ${target.status.toLowerCase()}.`);
      } else if (!principal.permissions.has('campaign.create')) {
        throw new AppError('FORBIDDEN', 'Creating a campaign needs campaign.create.');
      }
      assertIfMatch(ifMatch, current.version);

      campaignId ??= await this.campaigns.insertCampaign(tx, principal, client, {
        name: input.campaignName ?? current.title,
        clientOrganisationId: current.clientOrganisationId,
        agencyOrganisationId: current.agencyOrganisationId,
        opportunityId: current.opportunityId,
        ownerMembershipId: current.ownerMembershipId,
        notes: current.specialRequirements,
      });
      const lines = await tx
        .select()
        .from(briefLine)
        .where(eq(briefLine.briefId, id))
        .orderBy(asc(briefLine.position));
      const locationIds: string[] = [];
      for (const line of lines) {
        locationIds.push(
          await this.campaigns.insertLocation(tx, principal, client, campaignId, {
            briefLineId: line.id,
            name: line.storeName,
            address: line.address,
            city: line.city,
            county: line.county,
            startDate: line.startDate ?? current.requestedStart,
            endDate: line.endDate ?? current.requestedEnd,
            requestedUnits: line.requestedUnits,
            buyerMembershipId: current.ownerMembershipId,
          }),
        );
      }
      await tx
        .update(brief)
        .set({
          status: 'CONVERTED',
          convertedCampaignId: campaignId,
          convertedAt: new Date(),
          version: sql`${brief.version} + 1`,
        })
        .where(eq(brief.id, id));
      await this.transitions.record(tx, principal, client, {
        subjectType: 'brief',
        subjectId: id,
        from: 'CONFIRMED',
        to: 'CONVERTED',
        action: 'convert',
        event: 'brief.converted',
        payload: { campaignId, locationIds, newCampaign: !input.campaignId, deadline: current.deadline },
      });
      return this.loadDetail(tx, principal, id);
    });
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private inTenant<T>(principal: Principal, fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.database.withTenant({ tenantId: principal.tenantId, actorUserId: principal.userId }, fn);
  }

  private readScope(principal: Principal): SQL | undefined {
    return principal.permissions.get('brief.read') === 'OWN'
      ? eq(brief.ownerMembershipId, principal.membershipId)
      : undefined;
  }

  /** Outside the read scope a brief doesn't exist (404); readable but not changeable is a 403. */
  private async lock(
    tx: Transaction,
    principal: Principal,
    id: string,
    permission: PermissionKey,
  ): Promise<Row> {
    const [row] = await tx
      .select()
      .from(brief)
      .where(and(eq(brief.id, id), this.readScope(principal)))
      .for('update');
    if (!row) throw notFound();
    if (principal.permissions.get(permission) === 'OWN' && row.ownerMembershipId !== principal.membershipId) {
      throw new AppError('FORBIDDEN', 'You can only change briefs you own.');
    }
    return row;
  }

  private async insertBrief(
    tx: Transaction,
    principal: Principal,
    client: ClientInfo,
    values: Omit<typeof brief.$inferInsert, 'tenantId'>,
  ): Promise<string> {
    const [created] = await tx
      .insert(brief)
      .values({ ...values, tenantId: principal.tenantId, createdByMembershipId: principal.membershipId })
      .returning({ id: brief.id });
    await this.transitions.record(tx, principal, client, {
      subjectType: 'brief',
      subjectId: created!.id,
      from: null,
      to: 'DRAFT',
      action: 'create',
      event: 'brief.created',
      payload: {
        source: values.source,
        ...(values.opportunityId ? { opportunityId: values.opportunityId } : {}),
      },
    });
    return created!.id;
  }

  /** Client and agency are live companies of the tenant. */
  private async assertCompanies(
    tx: Transaction,
    input: { clientOrganisationId?: string | null; agencyOrganisationId?: string | null },
  ): Promise<void> {
    for (const path of ['clientOrganisationId', 'agencyOrganisationId'] as const) {
      const id = input[path];
      if (!id) continue;
      const [company] = await tx
        .select({ id: organisation.id })
        .from(organisation)
        .where(and(eq(organisation.id, id), isNull(organisation.archivedAt)));
      if (!company) throw invalid(path, 'Unknown or archived company');
    }
    if (input.clientOrganisationId && input.clientOrganisationId === input.agencyOrganisationId) {
      throw invalid('agencyOrganisationId', 'The agency and the client are different companies');
    }
  }

  private async loadDetail(tx: Transaction, principal: Principal, id: string): Promise<BriefDetail> {
    const [item] = await this.loadItems(tx, and(eq(brief.id, id), this.readScope(principal)), 1);
    if (!item) throw notFound();
    const [extra] = await tx
      .select({
        datesTbd: brief.datesTbd,
        budget: brief.budget,
        currency: brief.currency,
        specialRequirements: brief.specialRequirements,
        discardReason: brief.discardReason,
        confirmedAt: brief.confirmedAt,
        fieldProvenance: brief.fieldProvenance,
        convertedCampaignId: brief.convertedCampaignId,
        campaignCode: campaign.code,
        campaignName: campaign.name,
      })
      .from(brief)
      .leftJoin(campaign, eq(campaign.id, brief.convertedCampaignId))
      .where(eq(brief.id, id));
    const lines = await tx
      .select()
      .from(briefLine)
      .where(eq(briefLine.briefId, id))
      .orderBy(asc(briefLine.position));
    const { convertedCampaignId, campaignCode, campaignName, ...details } = extra!;
    return {
      ...item,
      ...details,
      convertedCampaign:
        convertedCampaignId && campaignCode && campaignName
          ? { id: convertedCampaignId, code: campaignCode, name: campaignName }
          : null,
      currency: details.currency as BriefDetail['currency'],
      confirmedAt: details.confirmedAt?.toISOString() ?? null,
      lines: lines.map(lineItem),
      actions: allowedActions(BRIEF_TRANSITIONS, item.status),
    };
  }

  private async loadItems(tx: Transaction, where: SQL | undefined, limit: number): Promise<BriefListItem[]> {
    const clientOrg = alias(organisation, 'client_org');
    const agencyOrg = alias(organisation, 'agency_org');
    const rows = await tx
      .select({
        brief,
        clientName: clientOrg.displayName,
        agencyName: agencyOrg.displayName,
        opportunityName: opportunity.name,
        ownerName: appUser.displayName,
        // Correlated subquery: drizzle renders `${brief.id}` unqualified here, so name the table.
        lineCount: sql<number>`(SELECT count(*)::int FROM brief_line bl WHERE bl.brief_id = "brief"."id")`,
      })
      .from(brief)
      .leftJoin(clientOrg, eq(clientOrg.id, brief.clientOrganisationId))
      .leftJoin(agencyOrg, eq(agencyOrg.id, brief.agencyOrganisationId))
      .leftJoin(opportunity, eq(opportunity.id, brief.opportunityId))
      .innerJoin(membership, eq(membership.id, brief.ownerMembershipId))
      .innerJoin(appUser, eq(appUser.id, membership.userId))
      .where(where)
      .orderBy(sql`${brief.id} DESC`)
      .limit(limit);
    return rows.map((r) => ({
      id: r.brief.id,
      title: r.brief.title,
      status: r.brief.status,
      source: r.brief.source,
      client:
        r.brief.clientOrganisationId && r.clientName
          ? { id: r.brief.clientOrganisationId, displayName: r.clientName }
          : null,
      agency:
        r.brief.agencyOrganisationId && r.agencyName
          ? { id: r.brief.agencyOrganisationId, displayName: r.agencyName }
          : null,
      opportunity:
        r.brief.opportunityId && r.opportunityName
          ? { id: r.brief.opportunityId, name: r.opportunityName }
          : null,
      owner: { membershipId: r.brief.ownerMembershipId, displayName: r.ownerName },
      requestedStart: r.brief.requestedStart,
      requestedEnd: r.brief.requestedEnd,
      deadline: r.brief.deadline,
      lineCount: r.lineCount,
      aiGenerated: r.brief.aiGenerated,
      createdAt: r.brief.createdAt.toISOString(),
      version: r.brief.version,
    }));
  }
}

async function insertLines(
  tx: Transaction,
  tenantId: string,
  briefId: string,
  lines: readonly BriefLineInput[],
): Promise<void> {
  if (lines.length === 0) return;
  await tx.insert(briefLine).values(
    lines.map((l, i) => ({
      tenantId,
      briefId,
      position: i + 1,
      storeName: l.storeName,
      address: l.address ?? null,
      city: l.city ?? null,
      county: l.county ?? null,
      requestedUnits: l.requestedUnits ?? null,
      dimension: l.dimension ?? null,
      startDate: l.startDate ?? null,
      endDate: l.endDate ?? null,
      notes: l.notes ?? null,
    })),
  );
}

function lineItem(l: typeof briefLine.$inferSelect): BriefLineItem {
  return {
    id: l.id,
    position: l.position,
    storeName: l.storeName,
    address: l.address,
    city: l.city,
    county: l.county,
    requestedUnits: l.requestedUnits,
    dimension: l.dimension,
    startDate: l.startDate,
    endDate: l.endDate,
    notes: l.notes,
  };
}

function requireDraft(current: Row): void {
  if (current.status !== 'DRAFT') {
    throw new AppError('INVALID_TRANSITION', 'Only draft briefs can be edited. Reopen it first.');
  }
}

/** Brief owners are active internal members. */
async function assertOwner(tx: Transaction, membershipId: string): Promise<void> {
  const [member] = await tx
    .select({ status: membership.status, kind: membership.kind })
    .from(membership)
    .where(eq(membership.id, membershipId));
  if (member?.status !== 'ACTIVE' || member.kind !== 'INTERNAL') {
    throw invalid('ownerMembershipId', 'Not an active internal member');
  }
}

const invalidField = (path: string, message: string) => invalid(path, message);

function invalid(path: string, message: string): AppError {
  return new AppError('VALIDATION_FAILED', `${message}.`, { errors: [{ path, message }] });
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
