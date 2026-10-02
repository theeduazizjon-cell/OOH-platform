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
import { primaryId, tenantIdColumn, timestamps, versionColumn } from './columns';
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
  },
  (t) => [
    unique('outbox_event_tenant_id_id_uq').on(t.tenantId, t.id),
    index('outbox_event_pending_idx')
      .on(t.occurredAt)
      .where(sql`${t.dispatchedAt} IS NULL`),
  ],
);
