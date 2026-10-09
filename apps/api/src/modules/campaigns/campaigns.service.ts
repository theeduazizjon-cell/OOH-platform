import { Injectable } from '@nestjs/common';
import {
  allowedActions,
  CAMPAIGN_TRANSITIONS,
  type CampaignAction,
  type CampaignDetail,
  type CampaignListItem,
  type CampaignListQuery,
  type CreateCampaignRequest,
  type CreateLocationRequest,
  LOCATION_TRANSITIONS,
  type LocationAction,
  locationCancellable,
  type LocationItem,
  type LocationStatus,
  locationPinTaskKey,
  type Page,
  type StorePointRequest,
  type PermissionKey,
  TERMINAL_LOCATION_STATUSES,
  type UpdateCampaignRequest,
  type UpdateLocationRequest,
} from '@ooh/contracts';
import {
  appUser,
  campaign,
  campaignLocation,
  membership,
  opportunity,
  organisation,
  type Transaction,
} from '@ooh/db';
import { and, asc, eq, inArray, isNull, lt, notInArray, type SQL, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { AuditService } from '../../core/audit/audit.service';
import { type Principal } from '../../core/auth/principal';
import { DatabaseService } from '../../core/database/database.service';
import { AppError } from '../../core/http/app-error';
import { type ClientInfo } from '../../core/http/client-info';
import { assertIfMatch, type IfMatch } from '../../core/http/concurrency';
import { decodeIdCursor, encodeIdCursor } from '../../core/http/cursor';
import { geocodeQuery } from '../../core/geo/geo-provider';
import { OutboxService } from '../../core/state/outbox.service';
import { TransitionsService } from '../../core/state/transitions.service';
import { userActor } from '../../core/audit/actor';
import { TasksService } from '../tasks/tasks.service';

type CampaignRow = typeof campaign.$inferSelect;
type LocationRow = typeof campaignLocation.$inferSelect;
type Changes = Record<string, { from: unknown; to: unknown }>;

const TERMINAL: LocationStatus[] = [...TERMINAL_LOCATION_STATUSES];
const notFound = () => new AppError('NOT_FOUND', 'Campaign not found.');
const locationNotFound = () => new AppError('NOT_FOUND', 'Location not found.');

export interface NewCampaign {
  name: string;
  clientOrganisationId: string;
  agencyOrganisationId: string | null;
  opportunityId: string | null;
  ownerMembershipId: string;
  notes: string | null;
}
export type NewLocation = Omit<typeof campaignLocation.$inferInsert, 'tenantId' | 'campaignId'>;

/**
 * Campaigns and locations (06-state-machines.md §4–§5). Read scope ORGANISATION (portal users):
 * campaigns where their company is the client or the agency, or a client their agency serves.
 * Change scope OWN: the campaign owner (and, for a location, its buyer).
 */
@Injectable()
export class CampaignsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly transitions: TransitionsService,
    private readonly outbox: OutboxService,
    private readonly tasks: TasksService,
  ) {}

  // ── campaigns ──────────────────────────────────────────────────────────────

  list(principal: Principal, query: CampaignListQuery): Promise<Page<CampaignListItem>> {
    const after = query.cursor ? decodeIdCursor(query.cursor) : undefined;
    return this.inTenant(principal, async (tx) => {
      const rows = await this.loadItems(
        tx,
        and(
          this.readScope(principal, 'campaign.read'),
          isNull(campaign.archivedAt),
          query.status ? eq(campaign.status, query.status) : undefined,
          query.clientOrganisationId
            ? eq(campaign.clientOrganisationId, query.clientOrganisationId)
            : undefined,
          query.q
            ? sql`(lower(immutable_unaccent(${campaign.name})) LIKE '%' || lower(immutable_unaccent(${query.q}::text)) || '%' OR ${campaign.code} LIKE ${query.q}::text || '%')`
            : undefined,
          after ? lt(campaign.id, after) : undefined,
        ),
        query.limit + 1,
      );
      const hasMore = rows.length > query.limit;
      const data = rows.slice(0, query.limit);
      return { data, page: { nextCursor: hasMore ? encodeIdCursor(data.at(-1)!.id) : null, hasMore } };
    });
  }

  get(principal: Principal, id: string): Promise<CampaignDetail> {
    return this.inTenant(principal, (tx) => this.loadDetail(tx, principal, id));
  }

  create(principal: Principal, input: CreateCampaignRequest, client: ClientInfo): Promise<CampaignDetail> {
    return this.inTenant(principal, async (tx) => {
      const id = await this.insertCampaign(tx, principal, client, {
        name: input.name,
        clientOrganisationId: input.clientOrganisationId,
        agencyOrganisationId: input.agencyOrganisationId ?? null,
        opportunityId: null,
        ownerMembershipId: input.ownerMembershipId ?? principal.membershipId,
        notes: input.notes ?? null,
      });
      return this.loadDetail(tx, principal, id);
    });
  }

  update(
    principal: Principal,
    id: string,
    input: UpdateCampaignRequest,
    ifMatch: IfMatch,
    client: ClientInfo,
  ): Promise<CampaignDetail> {
    return this.inTenant(principal, async (tx) => {
      const current = await this.lockCampaign(tx, principal, id, 'campaign.update');
      requireOpenCampaign(current);
      if (input.agencyOrganisationId) {
        await assertCompany(tx, 'agencyOrganisationId', input.agencyOrganisationId);
        if (input.agencyOrganisationId === current.clientOrganisationId)
          throw invalid('agencyOrganisationId', 'The agency and the client are different companies');
      }
      if (input.ownerMembershipId && input.ownerMembershipId !== current.ownerMembershipId)
        await assertInternalMember(tx, 'ownerMembershipId', input.ownerMembershipId);
      assertIfMatch(ifMatch, current.version);

      const changes = diff(current, input, ['name', 'agencyOrganisationId', 'ownerMembershipId', 'notes']);
      if (!changes) return this.loadDetail(tx, principal, id);
      await tx
        .update(campaign)
        .set({ ...pick(input, Object.keys(changes)), version: sql`${campaign.version} + 1` })
        .where(eq(campaign.id, id));
      await this.audit.record(tx, {
        ...actor(principal, client),
        action: 'campaign.updated',
        subjectType: 'campaign',
        subjectId: id,
        changes,
      });
      return this.loadDetail(tx, principal, id);
    });
  }

  /** hold / resume / cancel. Cancel cascades to every location still open (all must be pre-LIVE). */
  transition(
    principal: Principal,
    id: string,
    action: CampaignAction,
    input: { reason?: string },
    ifMatch: IfMatch,
    client: ClientInfo,
  ): Promise<CampaignDetail> {
    const rule = CAMPAIGN_TRANSITIONS[action];
    return this.inTenant(principal, async (tx) => {
      const current = await this.lockCampaign(tx, principal, id, rule.permission);
      if (!rule.from.includes(current.status)) {
        throw new AppError(
          'INVALID_TRANSITION',
          `A ${current.status.toLowerCase()} campaign can't ${action}.`,
          {
            meta: { allowedActions: allowedActions(CAMPAIGN_TRANSITIONS, current.status) },
          },
        );
      }
      const open = await tx
        .select()
        .from(campaignLocation)
        .where(and(eq(campaignLocation.campaignId, id), notInArray(campaignLocation.status, TERMINAL)))
        .for('update');
      if (action === 'cancel') {
        const live = open.filter((l) => !locationCancellable(l.status, l.previousStatus));
        if (live.length > 0) {
          throw new AppError(
            'CONFLICT',
            'Some locations are already live; they end through removal, not cancellation.',
            {
              meta: { locations: live.map((l) => ({ id: l.id, name: l.name, status: l.status })) },
            },
          );
        }
      }
      assertIfMatch(ifMatch, current.version);
      const to = rule.to === 'PREVIOUS' ? current.status : rule.to;
      await tx
        .update(campaign)
        .set({
          status: to,
          holdReason: action === 'hold' ? (input.reason ?? null) : null,
          ...(action === 'cancel' ? { cancelReason: input.reason } : {}),
          version: sql`${campaign.version} + 1`,
        })
        .where(eq(campaign.id, id));
      await this.transitions.record(tx, principal, client, {
        subjectType: 'campaign',
        subjectId: id,
        from: current.status,
        to,
        action,
        event: { hold: 'campaign.held', resume: 'campaign.resumed', cancel: 'campaign.cancelled' }[action],
        ...(input.reason ? { reason: input.reason } : {}),
      });
      if (action === 'cancel') {
        for (const location of open) {
          await this.setLocationStatus(tx, principal, client, location, 'cancel', 'CANCELLED', {
            cancelReason: `Campaign cancelled: ${input.reason}`,
          });
        }
      }
      return this.loadDetail(tx, principal, id);
    });
  }

  /**
   * A campaign inside the caller's transaction (also used by brief convert): code `YYYY-NNNN`,
   * unique per tenant, allocated under a per-tenant advisory lock.
   */
  async insertCampaign(
    tx: Transaction,
    principal: Principal,
    client: ClientInfo,
    input: NewCampaign,
  ): Promise<string> {
    await assertCompany(tx, 'clientOrganisationId', input.clientOrganisationId);
    if (input.agencyOrganisationId) {
      await assertCompany(tx, 'agencyOrganisationId', input.agencyOrganisationId);
      if (input.agencyOrganisationId === input.clientOrganisationId)
        throw invalid('agencyOrganisationId', 'The agency and the client are different companies');
    }
    await assertInternalMember(tx, 'ownerMembershipId', input.ownerMembershipId);
    const code = await nextCode(tx, principal.tenantId);
    const [created] = await tx
      .insert(campaign)
      .values({ ...input, tenantId: principal.tenantId, code, createdByMembershipId: principal.membershipId })
      .returning({ id: campaign.id });
    await this.transitions.record(tx, principal, client, {
      subjectType: 'campaign',
      subjectId: created!.id,
      from: null,
      to: 'ACTIVE',
      action: 'create',
      event: 'campaign.created',
      payload: { code, clientOrganisationId: input.clientOrganisationId },
    });
    return created!.id;
  }

  // ── locations ──────────────────────────────────────────────────────────────

  addLocation(
    principal: Principal,
    campaignId: string,
    input: CreateLocationRequest,
    client: ClientInfo,
  ): Promise<LocationItem> {
    return this.inTenant(principal, async (tx) => {
      const current = await this.lockCampaign(tx, principal, campaignId, 'campaign_location.manage');
      requireOpenCampaign(current);
      const id = await this.insertLocation(tx, principal, client, campaignId, {
        name: input.name,
        address: input.address ?? null,
        city: input.city ?? null,
        county: input.county ?? null,
        startDate: input.startDate ?? null,
        endDate: input.endDate ?? null,
        requestedUnits: input.requestedUnits ?? null,
        buyerMembershipId:
          input.buyerMembershipId === undefined ? current.ownerMembershipId : input.buyerMembershipId,
        researchRadiusM: input.researchRadiusM ?? null,
      });
      return this.loadLocation(tx, principal, id);
    });
  }

  /** A DRAFT location inside the caller's transaction (also used by brief convert). */
  async insertLocation(
    tx: Transaction,
    principal: Principal,
    client: ClientInfo,
    campaignId: string,
    values: NewLocation,
  ): Promise<string> {
    if (values.buyerMembershipId)
      await assertInternalMember(tx, 'buyerMembershipId', values.buyerMembershipId);
    const [created] = await tx
      .insert(campaignLocation)
      .values({ ...values, tenantId: principal.tenantId, campaignId })
      .returning({ id: campaignLocation.id });
    await this.transitions.record(tx, principal, client, {
      subjectType: 'campaign_location',
      subjectId: created!.id,
      from: null,
      to: 'DRAFT',
      action: 'create',
      event: 'campaign_location.created',
      // The worker geocodes the store and creates its "Research …" task from this event.
      payload: {
        campaignId,
        geocodeQuery: geocodeQuery({
          address: values.address ?? null,
          city: values.city ?? null,
          county: values.county ?? null,
        }),
      },
    });
    return created!.id;
  }

  getLocation(principal: Principal, id: string): Promise<LocationItem> {
    return this.inTenant(principal, (tx) => this.loadLocation(tx, principal, id));
  }

  updateLocation(
    principal: Principal,
    id: string,
    input: UpdateLocationRequest,
    ifMatch: IfMatch,
    client: ClientInfo,
  ): Promise<LocationItem> {
    return this.inTenant(principal, async (tx) => {
      const current = await this.lockLocation(tx, principal, id);
      if (TERMINAL.includes(current.status)) {
        throw new AppError('INVALID_TRANSITION', 'This location is finished or cancelled.');
      }
      if (input.buyerMembershipId && input.buyerMembershipId !== current.buyerMembershipId)
        await assertInternalMember(tx, 'buyerMembershipId', input.buyerMembershipId);
      const start = input.startDate === undefined ? current.startDate : input.startDate;
      const end = input.endDate === undefined ? current.endDate : input.endDate;
      if (start && end && end < start) throw invalid('endDate', 'The end date is before the start date');
      assertIfMatch(ifMatch, current.version);

      const changes = diff(current, input, [
        'name',
        'address',
        'city',
        'county',
        'startDate',
        'endDate',
        'requestedUnits',
        'buyerMembershipId',
        'researchRadiusM',
      ]);
      if (!changes) return this.loadLocation(tx, principal, id);
      // A draft's new address is geocoded again, unless a person already confirmed the pin.
      const regeocode =
        (changes.address || changes.city || changes.county) &&
        current.status === 'DRAFT' &&
        current.geocodeStatus !== 'CONFIRMED';
      await tx
        .update(campaignLocation)
        .set({
          ...pick(input, Object.keys(changes)),
          ...(regeocode ? UNGEOCODED : {}),
          version: sql`${campaignLocation.version} + 1`,
        })
        .where(eq(campaignLocation.id, id));
      if (regeocode) {
        const next = { ...current, ...pick(input, Object.keys(changes)) };
        await this.outbox.publish(tx, principal.tenantId, 'campaign_location.address_changed', {
          campaign_locationId: id,
          campaignId: current.campaignId,
          geocodeQuery: geocodeQuery(next),
          actorMembershipId: principal.membershipId,
        });
      }
      // "Who changed campaign dates" [R§40] is answered by the field-level audit.
      await this.audit.record(tx, {
        ...actor(principal, client),
        action: 'campaign_location.updated',
        subjectType: 'campaign_location',
        subjectId: id,
        changes,
      });
      return this.loadLocation(tx, principal, id);
    });
  }

  /** hold (reason) / resume (back to the remembered status) / cancel (reason, pre-LIVE only). */
  transitionLocation(
    principal: Principal,
    id: string,
    action: LocationAction,
    input: { reason?: string },
    ifMatch: IfMatch,
    client: ClientInfo,
  ): Promise<LocationItem> {
    const rule = LOCATION_TRANSITIONS[action];
    return this.inTenant(principal, async (tx) => {
      const current = await this.lockLocation(tx, principal, id);
      const allowed =
        rule.from.includes(current.status) &&
        (action !== 'cancel' || locationCancellable(current.status, current.previousStatus));
      if (allowed && action === 'start-research' && current.geocodeStatus !== 'CONFIRMED') {
        throw new AppError('INVALID_TRANSITION', 'Confirm the store pin before starting research.', {
          meta: { allowedActions: locationActions(current) },
        });
      }
      if (!allowed) {
        throw new AppError(
          'INVALID_TRANSITION',
          `A ${current.status.toLowerCase()} location can't ${action}.`,
          {
            meta: { allowedActions: locationActions(current) },
          },
        );
      }
      assertIfMatch(ifMatch, current.version);
      const to: LocationStatus = {
        'start-research': 'RESEARCH' as const,
        hold: 'ON_HOLD' as const,
        resume: current.previousStatus!,
        cancel: 'CANCELLED' as const,
      }[action];
      await this.setLocationStatus(tx, principal, client, current, action, to, {
        ...(action === 'hold' ? { holdReason: input.reason ?? null, previousStatus: current.status } : {}),
        ...(action === 'cancel' ? { cancelReason: input.reason } : {}),
      });
      return this.loadLocation(tx, principal, id);
    });
  }

  /**
   * A person places or accepts the store pin (04-user-flows.md A7): geocode status CONFIRMED, which
   * start-research requires. Completes the location's "Confirm store pin" task, if any.
   */
  setStorePoint(
    principal: Principal,
    id: string,
    input: StorePointRequest,
    ifMatch: IfMatch,
    client: ClientInfo,
  ): Promise<LocationItem> {
    return this.inTenant(principal, async (tx) => {
      const current = await this.lockLocation(tx, principal, id);
      if (TERMINAL.includes(current.status)) {
        throw new AppError('INVALID_TRANSITION', 'This location is finished or cancelled.');
      }
      assertIfMatch(ifMatch, current.version);
      const [before] = await tx
        .select({ lat: POINT_LAT, lng: POINT_LNG })
        .from(campaignLocation)
        .where(eq(campaignLocation.id, id));
      await tx
        .update(campaignLocation)
        .set({
          storePoint: sql`ST_SetSRID(ST_MakePoint(${input.lng}, ${input.lat}), 4326)::geography`,
          geocodeStatus: 'CONFIRMED',
          placeId: input.placeId ?? null,
          geocodeError: null,
          pinConfirmedAt: new Date(),
          pinConfirmedByMembershipId: principal.membershipId,
          version: sql`${campaignLocation.version} + 1`,
        })
        .where(eq(campaignLocation.id, id));
      await this.audit.record(tx, {
        ...actor(principal, client),
        action: 'campaign_location.store_confirmed',
        subjectType: 'campaign_location',
        subjectId: id,
        changes: {
          storePoint: {
            from: before?.lat == null ? null : { lat: before.lat, lng: before.lng },
            to: { lat: input.lat, lng: input.lng },
          },
          geocodeStatus: { from: current.geocodeStatus, to: 'CONFIRMED' },
        },
      });
      await this.tasks.completeSystemTask(tx, userActor(principal, client), locationPinTaskKey(id));
      return this.loadLocation(tx, principal, id);
    });
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private inTenant<T>(principal: Principal, fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.database.withTenant({ tenantId: principal.tenantId, actorUserId: principal.userId }, fn);
  }

  /** ORGANISATION: the caller's company is the client or the agency, or the agency of the client. */
  private readScope(principal: Principal, permission: PermissionKey): SQL | undefined {
    if (principal.permissions.get(permission) !== 'ORGANISATION') return undefined;
    // Raw SQL: correlated references to "campaign" must be qualified (drizzle renders them bare).
    return sql`EXISTS (
      SELECT 1 FROM membership m
      WHERE m.id = ${principal.membershipId} AND m.organisation_id IS NOT NULL AND (
        m.organisation_id IN ("campaign"."client_organisation_id", "campaign"."agency_organisation_id")
        OR EXISTS (
          SELECT 1 FROM organisation_relationship r
          WHERE r.kind = 'AGENCY_OF' AND r.from_organisation_id = m.organisation_id
            AND r.to_organisation_id = "campaign"."client_organisation_id"
        )
      )
    )`;
  }

  private async lockCampaign(
    tx: Transaction,
    principal: Principal,
    id: string,
    permission: PermissionKey,
  ): Promise<CampaignRow> {
    const [row] = await tx
      .select()
      .from(campaign)
      .where(
        and(eq(campaign.id, id), isNull(campaign.archivedAt), this.readScope(principal, 'campaign.read')),
      )
      .for('update');
    if (!row) throw notFound();
    if (principal.permissions.get(permission) === 'OWN' && row.ownerMembershipId !== principal.membershipId) {
      throw new AppError('FORBIDDEN', 'You can only change campaigns you own.');
    }
    return row;
  }

  private async lockLocation(tx: Transaction, principal: Principal, id: string): Promise<LocationRow> {
    const [row] = await tx
      .select({ location: campaignLocation, ownerId: campaign.ownerMembershipId })
      .from(campaignLocation)
      .innerJoin(campaign, eq(campaign.id, campaignLocation.campaignId))
      .where(and(eq(campaignLocation.id, id), this.readScope(principal, 'campaign_location.read')))
      .for('update', { of: campaignLocation });
    if (!row) throw locationNotFound();
    if (
      principal.permissions.get('campaign_location.manage') === 'OWN' &&
      row.location.buyerMembershipId !== principal.membershipId &&
      row.ownerId !== principal.membershipId
    ) {
      throw new AppError('FORBIDDEN', 'You can only change locations you buy for or campaigns you own.');
    }
    return row.location;
  }

  private async setLocationStatus(
    tx: Transaction,
    principal: Principal,
    client: ClientInfo,
    current: LocationRow,
    action: string,
    to: LocationStatus,
    extra: Partial<typeof campaignLocation.$inferInsert>,
  ): Promise<void> {
    await tx
      .update(campaignLocation)
      .set({
        status: to,
        previousStatus: null,
        holdReason: null,
        ...extra,
        version: sql`${campaignLocation.version} + 1`,
      })
      .where(eq(campaignLocation.id, current.id));
    await this.transitions.record(tx, principal, client, {
      subjectType: 'campaign_location',
      subjectId: current.id,
      from: current.status,
      to,
      action,
      event: `campaign_location.${{ 'start-research': 'research_started', hold: 'held', resume: 'resumed', cancel: 'cancelled' }[action] ?? action}`,
      payload: { campaignId: current.campaignId },
      ...(extra.cancelReason
        ? { reason: extra.cancelReason }
        : extra.holdReason
          ? { reason: extra.holdReason }
          : {}),
    });
  }

  private async loadDetail(tx: Transaction, principal: Principal, id: string): Promise<CampaignDetail> {
    const [item] = await this.loadItems(
      tx,
      and(eq(campaign.id, id), isNull(campaign.archivedAt), this.readScope(principal, 'campaign.read')),
      1,
    );
    if (!item) throw notFound();
    const [extra] = await tx
      .select({ notes: campaign.notes, holdReason: campaign.holdReason, cancelReason: campaign.cancelReason })
      .from(campaign)
      .where(eq(campaign.id, id));
    const locationItems = await this.loadLocations(tx, eq(campaignLocation.campaignId, id));
    return { ...item, ...extra!, locationItems, actions: allowedActions(CAMPAIGN_TRANSITIONS, item.status) };
  }

  private async loadItems(
    tx: Transaction,
    where: SQL | undefined,
    limit: number,
  ): Promise<CampaignListItem[]> {
    const clientOrg = alias(organisation, 'client_org');
    const agencyOrg = alias(organisation, 'agency_org');
    const rows = await tx
      .select({
        campaign,
        clientName: clientOrg.displayName,
        agencyName: agencyOrg.displayName,
        opportunityName: opportunity.name,
        ownerName: appUser.displayName,
      })
      .from(campaign)
      .innerJoin(clientOrg, eq(clientOrg.id, campaign.clientOrganisationId))
      .leftJoin(agencyOrg, eq(agencyOrg.id, campaign.agencyOrganisationId))
      .leftJoin(opportunity, eq(opportunity.id, campaign.opportunityId))
      .innerJoin(membership, eq(membership.id, campaign.ownerMembershipId))
      .innerJoin(appUser, eq(appUser.id, membership.userId))
      .where(where)
      .orderBy(sql`${campaign.id} DESC`)
      .limit(limit);
    const ids = rows.map((r) => r.campaign.id);
    const stats =
      ids.length === 0
        ? []
        : await tx
            .select({
              campaignId: campaignLocation.campaignId,
              status: campaignLocation.status,
              n: sql<number>`count(*)::int`,
              start: sql<string | null>`min(${campaignLocation.startDate})::text`,
              end: sql<string | null>`max(${campaignLocation.endDate})::text`,
            })
            .from(campaignLocation)
            .where(inArray(campaignLocation.campaignId, ids))
            .groupBy(campaignLocation.campaignId, campaignLocation.status);
    return rows.map((r) => {
      const mine = stats.filter((s) => s.campaignId === r.campaign.id);
      const active = mine.filter((s) => s.status !== 'CANCELLED');
      const starts = active.map((s) => s.start).filter((d): d is string => d !== null);
      const ends = active.map((s) => s.end).filter((d): d is string => d !== null);
      return {
        id: r.campaign.id,
        code: r.campaign.code,
        name: r.campaign.name,
        status: r.campaign.status,
        client: { id: r.campaign.clientOrganisationId, displayName: r.clientName },
        agency:
          r.campaign.agencyOrganisationId && r.agencyName
            ? { id: r.campaign.agencyOrganisationId, displayName: r.agencyName }
            : null,
        opportunity:
          r.campaign.opportunityId && r.opportunityName
            ? { id: r.campaign.opportunityId, name: r.opportunityName }
            : null,
        owner: { membershipId: r.campaign.ownerMembershipId, displayName: r.ownerName },
        startDate: starts.sort()[0] ?? null,
        endDate: ends.sort().at(-1) ?? null,
        locations: {
          total: mine.reduce((sum, s) => sum + s.n, 0),
          byStatus: Object.fromEntries(mine.map((s) => [s.status, s.n])),
        },
        createdAt: r.campaign.createdAt.toISOString(),
        version: r.campaign.version,
      };
    });
  }

  private async loadLocation(tx: Transaction, principal: Principal, id: string): Promise<LocationItem> {
    const [item] = await this.loadLocations(
      tx,
      and(eq(campaignLocation.id, id), this.readScope(principal, 'campaign_location.read')),
    );
    if (!item) throw locationNotFound();
    return item;
  }

  private async loadLocations(tx: Transaction, where: SQL | undefined): Promise<LocationItem[]> {
    const rows = await tx
      .select({
        location: campaignLocation,
        buyerName: appUser.displayName,
        lat: POINT_LAT,
        lng: POINT_LNG,
      })
      .from(campaignLocation)
      .innerJoin(campaign, eq(campaign.id, campaignLocation.campaignId))
      .leftJoin(membership, eq(membership.id, campaignLocation.buyerMembershipId))
      .leftJoin(appUser, eq(appUser.id, membership.userId))
      .where(where)
      .orderBy(asc(campaignLocation.createdAt), asc(campaignLocation.id));
    return rows.map(({ location: l, buyerName, lat, lng }) => ({
      id: l.id,
      campaignId: l.campaignId,
      name: l.name,
      address: l.address,
      city: l.city,
      county: l.county,
      startDate: l.startDate,
      endDate: l.endDate,
      requestedUnits: l.requestedUnits,
      buyer: l.buyerMembershipId ? { membershipId: l.buyerMembershipId, displayName: buyerName ?? '' } : null,
      status: l.status,
      previousStatus: l.previousStatus,
      holdReason: l.holdReason,
      cancelReason: l.cancelReason,
      researchRadiusM: l.researchRadiusM,
      briefLineId: l.briefLineId,
      storePoint: lat !== null && lng !== null ? { lat: Number(lat), lng: Number(lng) } : null,
      geocodeStatus: l.geocodeStatus,
      geocodedAddress: l.geocodedAddress,
      geocodeError: l.geocodeError,
      pinConfirmedAt: l.pinConfirmedAt?.toISOString() ?? null,
      version: l.version,
      actions: locationActions(l),
    }));
  }
}

function locationActions(
  l: Pick<LocationRow, 'status' | 'previousStatus' | 'geocodeStatus'>,
): LocationAction[] {
  return allowedActions(LOCATION_TRANSITIONS, l.status).filter(
    (a) =>
      (a !== 'cancel' || locationCancellable(l.status, l.previousStatus)) &&
      (a !== 'start-research' || l.geocodeStatus === 'CONFIRMED'),
  );
}

/** Coordinates of the store pin (the geography column holds EWKB; read it as numbers). */
const POINT_LAT = sql<number | null>`ST_Y(${campaignLocation.storePoint}::geometry)`;
const POINT_LNG = sql<number | null>`ST_X(${campaignLocation.storePoint}::geometry)`;

/** Back to "not geocoded yet" (an address changed before the pin was confirmed). */
const UNGEOCODED = {
  storePoint: null,
  geocodeStatus: 'PENDING' as const,
  placeId: null,
  geocodedAddress: null,
  geocodeError: null,
};

function requireOpenCampaign(current: CampaignRow): void {
  if (current.status === 'COMPLETED' || current.status === 'CANCELLED') {
    throw new AppError('INVALID_TRANSITION', `This campaign is ${current.status.toLowerCase()}.`);
  }
}

/** `YYYY-NNNN`, the next free number of the year in the tenant. */
async function nextCode(tx: Transaction, tenantId: string): Promise<string> {
  const year = new Date().getUTCFullYear();
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:campaign_code`}, 0))`);
  const [row] = await tx
    .select({ last: sql<string | null>`max(${campaign.code})` })
    .from(campaign)
    .where(sql`${campaign.code} LIKE ${`${year}-%`}`);
  const next = row?.last ? Number(row.last.slice(5)) + 1 : 1;
  return `${year}-${String(next).padStart(4, '0')}`;
}

async function assertCompany(tx: Transaction, path: string, id: string): Promise<void> {
  const [company] = await tx
    .select({ id: organisation.id })
    .from(organisation)
    .where(and(eq(organisation.id, id), isNull(organisation.archivedAt)));
  if (!company) throw invalid(path, 'Unknown or archived company');
}

async function assertInternalMember(tx: Transaction, path: string, membershipId: string): Promise<void> {
  const [member] = await tx
    .select({ status: membership.status, kind: membership.kind })
    .from(membership)
    .where(eq(membership.id, membershipId));
  if (member?.status !== 'ACTIVE' || member.kind !== 'INTERNAL')
    throw invalid(path, 'Not an active internal member');
}

function diff<T extends object, K extends keyof T & string>(
  current: T,
  input: Partial<Record<K, unknown>>,
  fields: readonly K[],
): Changes | null {
  const changes: Changes = {};
  for (const field of fields) {
    if (input[field] !== undefined && input[field] !== current[field])
      changes[field] = { from: current[field], to: input[field] };
  }
  return Object.keys(changes).length > 0 ? changes : null;
}

function pick(input: object, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((k) => [k, (input as Record<string, unknown>)[k]]));
}

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
