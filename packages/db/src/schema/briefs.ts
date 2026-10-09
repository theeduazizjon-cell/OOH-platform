/**
 * Briefs (docs/architecture/05-domain-model.md §briefs & campaigns): a client request and its store
 * lines, before it becomes a campaign. Plus two cross-cutting tables every state machine writes to
 * (06-state-machines.md "Implementation pattern"): `status_history` and `outbox_event`.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { actorType } from './audit';
import { geographyPoint, primaryId, tenantIdColumn, timestamps, versionColumn } from './columns';
import { opportunity, organisation } from './crm';
import { membership, tenant } from './identity';

export const briefSource = pgEnum('brief_source', ['MANUAL', 'OPPORTUNITY', 'EMAIL', 'PORTAL', 'API']);
export const briefStatus = pgEnum('brief_status', ['DRAFT', 'CONFIRMED', 'CONVERTED', 'DISCARDED']);

export const brief = pgTable(
  'brief',
  {
    id: primaryId(),
    tenantId: tenantIdColumn().references(() => tenant.id),
    title: text('title').notNull(),
    source: briefSource('source').notNull().default('MANUAL'),
    status: briefStatus('status').notNull().default('DRAFT'),
    clientOrganisationId: uuid('client_organisation_id'),
    agencyOrganisationId: uuid('agency_organisation_id'),
    opportunityId: uuid('opportunity_id'),
    /** The buyer responsible; drives the OWN permission scope. */
    ownerMembershipId: uuid('owner_membership_id').notNull(),
    requestedStart: date('requested_start', { mode: 'string' }),
    requestedEnd: date('requested_end', { mode: 'string' }),
    datesTbd: boolean('dates_tbd').notNull().default(false),
    deadline: date('deadline', { mode: 'string' }),
    budget: numeric('budget', { precision: 14, scale: 2 }),
    currency: text('currency').notNull().default('RON'),
    specialRequirements: text('special_requirements'),
    discardReason: text('discard_reason'),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    // Reserved for AI intake (M13): references arrive with inbound_email / ai_run.
    aiGenerated: boolean('ai_generated').notNull().default(false),
    fieldProvenance: jsonb('field_provenance')
      .$type<Record<string, 'AI' | 'HUMAN' | 'AI_EDITED'>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    inboundEmailId: uuid('inbound_email_id'),
    aiRunId: uuid('ai_run_id'),
    /** The campaign its stores went to (set by convert). */
    convertedCampaignId: uuid('converted_campaign_id'),
    convertedAt: timestamp('converted_at', { withTimezone: true }),
    createdByMembershipId: uuid('created_by_membership_id'),
    ...timestamps(),
    version: versionColumn(),
  },
  (t) => [
    unique('brief_tenant_id_id_uq').on(t.tenantId, t.id),
    foreignKey({
      name: 'brief_client_fk',
      columns: [t.tenantId, t.clientOrganisationId],
      foreignColumns: [organisation.tenantId, organisation.id],
    }),
    foreignKey({
      name: 'brief_agency_fk',
      columns: [t.tenantId, t.agencyOrganisationId],
      foreignColumns: [organisation.tenantId, organisation.id],
    }),
    foreignKey({
      name: 'brief_opportunity_fk',
      columns: [t.tenantId, t.opportunityId],
      foreignColumns: [opportunity.tenantId, opportunity.id],
    }),
    foreignKey({
      name: 'brief_owner_fk',
      columns: [t.tenantId, t.ownerMembershipId],
      foreignColumns: [membership.tenantId, membership.id],
    }),
    foreignKey({
      name: 'brief_created_by_fk',
      columns: [t.tenantId, t.createdByMembershipId],
      foreignColumns: [membership.tenantId, membership.id],
    }),
    index('brief_status_idx').on(t.tenantId, t.status),
    index('brief_client_idx').on(t.tenantId, t.clientOrganisationId),
    index('brief_opportunity_idx').on(t.tenantId, t.opportunityId),
    check('brief_title_ck', sql`length(btrim(${t.title})) > 0`),
    check('brief_currency_ck', sql`${t.currency} IN ('RON', 'EUR')`),
    check('brief_budget_ck', sql`${t.budget} IS NULL OR ${t.budget} >= 0`),
    check(
      'brief_dates_ck',
      sql`${t.requestedStart} IS NULL OR ${t.requestedEnd} IS NULL OR ${t.requestedEnd} >= ${t.requestedStart}`,
    ),
    check(
      'brief_discarded_ck',
      sql`(${t.status} = 'DISCARDED') = (length(btrim(coalesce(${t.discardReason}, ''))) > 0)`,
    ),
    check(
      'brief_confirmed_ck',
      sql`${t.status} NOT IN ('CONFIRMED', 'CONVERTED') OR ${t.confirmedAt} IS NOT NULL`,
    ),
    check('brief_source_opportunity_ck', sql`${t.source} <> 'OPPORTUNITY' OR ${t.opportunityId} IS NOT NULL`),
    // Declared below in this file: drizzle builds the constraint lazily.
    foreignKey({
      name: 'brief_converted_campaign_fk',
      columns: [t.tenantId, t.convertedCampaignId],
      foreignColumns: [campaign.tenantId, campaign.id],
    }),
    check(
      'brief_converted_ck',
      sql`(${t.status} = 'CONVERTED') = (${t.convertedCampaignId} IS NOT NULL AND ${t.convertedAt} IS NOT NULL)`,
    ),
  ],
);

export const briefLine = pgTable(
  'brief_line',
  {
    id: primaryId(),
    tenantId: tenantIdColumn().references(() => tenant.id),
    briefId: uuid('brief_id').notNull(),
    position: integer('position').notNull(),
    storeName: text('store_name').notNull(),
    address: text('address'),
    city: text('city'),
    county: text('county'),
    requestedUnits: integer('requested_units'),
    /** Free text until asset types and dimension presets arrive (M4). */
    dimension: text('dimension'),
    startDate: date('start_date', { mode: 'string' }),
    endDate: date('end_date', { mode: 'string' }),
    notes: text('notes'),
    ...timestamps(),
  },
  (t) => [
    unique('brief_line_tenant_id_id_uq').on(t.tenantId, t.id),
    unique('brief_line_position_uq').on(t.briefId, t.position),
    foreignKey({
      name: 'brief_line_brief_fk',
      columns: [t.tenantId, t.briefId],
      foreignColumns: [brief.tenantId, brief.id],
    }).onDelete('cascade'),
    check('brief_line_store_ck', sql`length(btrim(${t.storeName})) > 0`),
    check('brief_line_units_ck', sql`${t.requestedUnits} IS NULL OR ${t.requestedUnits} > 0`),
    check(
      'brief_line_dates_ck',
      sql`${t.startDate} IS NULL OR ${t.endDate} IS NULL OR ${t.endDate} >= ${t.startDate}`,
    ),
  ],
);

export const geocodeStatus = pgEnum('geocode_status', [
  'PENDING',
  'RESOLVED',
  'AMBIGUOUS',
  'FAILED',
  'CONFIRMED',
]);

export const campaignStatus = pgEnum('campaign_status', ['ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED']);
export const locationStatus = pgEnum('location_status', [
  'DRAFT',
  'RESEARCH',
  'AWAITING_APPROVAL',
  'APPROVED',
  'IN_PRODUCTION',
  'READY_FOR_INSTALLATION',
  'INSTALLING',
  'LIVE',
  'REMOVAL_DUE',
  'REMOVING',
  'COMPLETED',
  'CANCELLED',
  'ON_HOLD',
]);

/** A campaign: an umbrella over its locations, whose dates and progress it derives. */
export const campaign = pgTable(
  'campaign',
  {
    id: primaryId(),
    tenantId: tenantIdColumn().references(() => tenant.id),
    /** Human reference, unique per tenant (`2026-0007`). */
    code: text('code').notNull(),
    name: text('name').notNull(),
    clientOrganisationId: uuid('client_organisation_id').notNull(),
    agencyOrganisationId: uuid('agency_organisation_id'),
    opportunityId: uuid('opportunity_id'),
    /** The buyer responsible; drives the OWN scope. */
    ownerMembershipId: uuid('owner_membership_id').notNull(),
    status: campaignStatus('status').notNull().default('ACTIVE'),
    holdReason: text('hold_reason'),
    cancelReason: text('cancel_reason'),
    notes: text('notes'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdByMembershipId: uuid('created_by_membership_id'),
    ...timestamps(),
    version: versionColumn(),
  },
  (t) => [
    unique('campaign_tenant_id_id_uq').on(t.tenantId, t.id),
    unique('campaign_code_uq').on(t.tenantId, t.code),
    foreignKey({
      name: 'campaign_client_fk',
      columns: [t.tenantId, t.clientOrganisationId],
      foreignColumns: [organisation.tenantId, organisation.id],
    }),
    foreignKey({
      name: 'campaign_agency_fk',
      columns: [t.tenantId, t.agencyOrganisationId],
      foreignColumns: [organisation.tenantId, organisation.id],
    }),
    foreignKey({
      name: 'campaign_opportunity_fk',
      columns: [t.tenantId, t.opportunityId],
      foreignColumns: [opportunity.tenantId, opportunity.id],
    }),
    foreignKey({
      name: 'campaign_owner_fk',
      columns: [t.tenantId, t.ownerMembershipId],
      foreignColumns: [membership.tenantId, membership.id],
    }),
    foreignKey({
      name: 'campaign_created_by_fk',
      columns: [t.tenantId, t.createdByMembershipId],
      foreignColumns: [membership.tenantId, membership.id],
    }),
    index('campaign_client_idx').on(t.tenantId, t.clientOrganisationId),
    index('campaign_agency_idx').on(t.tenantId, t.agencyOrganisationId),
    index('campaign_status_idx').on(t.tenantId, t.status),
    check('campaign_name_ck', sql`length(btrim(${t.name})) > 0`),
    check(
      'campaign_agency_not_client_ck',
      sql`${t.agencyOrganisationId} IS DISTINCT FROM ${t.clientOrganisationId}`,
    ),
    check(
      'campaign_cancelled_ck',
      sql`(${t.status} = 'CANCELLED') = (length(btrim(coalesce(${t.cancelReason}, ''))) > 0)`,
    ),
  ],
);

/**
 * A store of a campaign: where the operational state machine runs (06-state-machines.md §5). The
 * store pin and geocoding columns arrive in M3c.
 */
export const campaignLocation = pgTable(
  'campaign_location',
  {
    id: primaryId(),
    tenantId: tenantIdColumn().references(() => tenant.id),
    campaignId: uuid('campaign_id').notNull(),
    briefLineId: uuid('brief_line_id'),
    name: text('name').notNull(),
    address: text('address'),
    city: text('city'),
    county: text('county'),
    startDate: date('start_date', { mode: 'string' }),
    endDate: date('end_date', { mode: 'string' }),
    requestedUnits: integer('requested_units'),
    buyerMembershipId: uuid('buyer_membership_id'),
    status: locationStatus('status').notNull().default('DRAFT'),
    previousStatus: locationStatus('previous_status'),
    holdReason: text('hold_reason'),
    cancelReason: text('cancel_reason'),
    researchRadiusM: integer('research_radius_m'),
    /** The store (WGS84). Geocoded, then confirmed or moved by a person (04-user-flows.md A6–A7). */
    storePoint: geographyPoint('store_point'),
    geocodeStatus: geocodeStatus('geocode_status').notNull().default('PENDING'),
    /** Provider place reference (kept, unlike provider content, per OPD-19). */
    placeId: text('place_id'),
    geocodedAddress: text('geocoded_address'),
    geocodeError: text('geocode_error'),
    pinConfirmedByMembershipId: uuid('pin_confirmed_by_membership_id'),
    pinConfirmedAt: timestamp('pin_confirmed_at', { withTimezone: true }),
    liveAt: timestamp('live_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    ...timestamps(),
    version: versionColumn(),
  },
  (t) => [
    unique('campaign_location_tenant_id_id_uq').on(t.tenantId, t.id),
    foreignKey({
      name: 'campaign_location_campaign_fk',
      columns: [t.tenantId, t.campaignId],
      foreignColumns: [campaign.tenantId, campaign.id],
    }),
    foreignKey({
      name: 'campaign_location_brief_line_fk',
      columns: [t.tenantId, t.briefLineId],
      foreignColumns: [briefLine.tenantId, briefLine.id],
    }),
    foreignKey({
      name: 'campaign_location_buyer_fk',
      columns: [t.tenantId, t.buyerMembershipId],
      foreignColumns: [membership.tenantId, membership.id],
    }),
    foreignKey({
      name: 'campaign_location_pin_confirmed_by_fk',
      columns: [t.tenantId, t.pinConfirmedByMembershipId],
      foreignColumns: [membership.tenantId, membership.id],
    }),
    index('campaign_location_campaign_idx').on(t.tenantId, t.campaignId),
    index('campaign_location_store_point_idx').using('gist', t.storePoint),
    index('campaign_location_status_idx').on(t.tenantId, t.status),
    check('campaign_location_name_ck', sql`length(btrim(${t.name})) > 0`),
    check('campaign_location_units_ck', sql`${t.requestedUnits} IS NULL OR ${t.requestedUnits} > 0`),
    check(
      'campaign_location_radius_ck',
      sql`${t.researchRadiusM} IS NULL OR ${t.researchRadiusM} BETWEEN 50 AND 50000`,
    ),
    check(
      'campaign_location_dates_ck',
      sql`${t.startDate} IS NULL OR ${t.endDate} IS NULL OR ${t.endDate} >= ${t.startDate}`,
    ),
    // ON_HOLD remembers where it resumes to (never another hold or a terminal status).
    check(
      'campaign_location_hold_ck',
      sql`(${t.status} = 'ON_HOLD') = (${t.previousStatus} IS NOT NULL) AND (${t.previousStatus} IS NULL OR ${t.previousStatus} NOT IN ('ON_HOLD', 'COMPLETED', 'CANCELLED'))`,
    ),
    // A pin exists exactly when geocoding found one or a person placed it.
    check(
      'campaign_location_pin_ck',
      sql`(${t.geocodeStatus} IN ('RESOLVED', 'CONFIRMED')) = (${t.storePoint} IS NOT NULL)`,
    ),
    check(
      'campaign_location_pin_confirmed_ck',
      sql`(${t.geocodeStatus} = 'CONFIRMED') = (${t.pinConfirmedAt} IS NOT NULL)`,
    ),
    // Research and everything after it need a confirmed store pin (06-state-machines.md §5).
    check(
      'campaign_location_research_needs_pin_ck',
      sql`${t.status} IN ('DRAFT', 'CANCELLED', 'ON_HOLD') OR ${t.geocodeStatus} = 'CONFIRMED'`,
    ),
    check(
      'campaign_location_cancelled_ck',
      sql`(${t.status} = 'CANCELLED') = (length(btrim(coalesce(${t.cancelReason}, ''))) > 0)`,
    ),
  ],
);

/** Every status change of every state machine (append-only). */
export const statusHistory = pgTable(
  'status_history',
  {
    id: primaryId(),
    tenantId: tenantIdColumn().references(() => tenant.id),
    subjectType: text('subject_type').notNull(),
    subjectId: uuid('subject_id').notNull(),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    action: text('action').notNull(),
    actorType: actorType('actor_type').notNull(),
    actorMembershipId: uuid('actor_membership_id'),
    reason: text('reason'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('status_history_tenant_id_id_uq').on(t.tenantId, t.id),
    foreignKey({
      name: 'status_history_actor_fk',
      columns: [t.tenantId, t.actorMembershipId],
      foreignColumns: [membership.tenantId, membership.id],
    }),
    index('status_history_subject_idx').on(t.tenantId, t.subjectType, t.subjectId, t.occurredAt),
  ],
);

/**
 * Transactional outbox (08-system-architecture.md): events are written in the business transaction
 * and dispatched later by the worker (M3c), so a failing email never rolls back a business action.
 */
export const outboxEvent = pgTable(
  'outbox_event',
  {
    id: primaryId(),
    tenantId: tenantIdColumn().references(() => tenant.id),
    /** Dotted, past tense: `brief.confirmed`, `opportunity.won`. */
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    /** Leased by a worker until then (another worker may take it over afterwards). */
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    /** Retries back off; the dispatcher only claims events whose time has come. */
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    /** Given up after too many attempts (kept for inspection and replay). */
    failedAt: timestamp('failed_at', { withTimezone: true }),
  },
  (t) => [
    unique('outbox_event_tenant_id_id_uq').on(t.tenantId, t.id),
    index('outbox_event_pending_idx')
      .on(t.nextAttemptAt, t.occurredAt)
      .where(sql`${t.dispatchedAt} IS NULL AND ${t.failedAt} IS NULL`),
  ],
);
