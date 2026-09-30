/**
 * CRM (docs/architecture/05-domain-model.md §crm, 01-product-understanding.md §3.3). An organisation
 * is one real-world company, whatever roles it plays (classifications), so a company that is both a
 * client and a supplier is never recorded twice.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { archivedAt, citext, primaryId, tenantIdColumn, timestamps, versionColumn } from './columns';
import { activityType, organisationClassification, pipelineStage, pipelineStageKind } from './config';
import { membership, tenant } from './identity';

export const organisation = pgTable(
  'organisation',
  {
    id: primaryId(),
    tenantId: tenantIdColumn().references(() => tenant.id),
    displayName: text('display_name').notNull(),
    legalName: text('legal_name'),
    /**
     * Normalised display name for duplicate detection and search (lower case, no diacritics or
     * legal forms): see crm_name_key() in migration 0007. Trigram-indexed.
     */
    nameKey: text('name_key')
      .notNull()
      .generatedAlwaysAs(sql`crm_name_key(display_name)`),
    /** Stored normalised by the API (upper case, letters and digits only); unique per tenant. */
    vatNumber: text('vat_number'),
    website: text('website'),
    address: text('address'),
    city: text('city'),
    county: text('county'),
    /** ISO 3166-1 alpha-2. */
    country: text('country').notNull().default('RO'),
    industry: text('industry'),
    notes: text('notes'),
    /** Drives the OWN permission scope (e.g. Sales may edit the companies they own). */
    accountOwnerMembershipId: uuid('account_owner_membership_id'),
    createdByMembershipId: uuid('created_by_membership_id'),
    archivedAt: archivedAt(),
    ...timestamps(),
    version: versionColumn(),
  },
  (t) => [
    unique('organisation_tenant_id_id_uq').on(t.tenantId, t.id),
    // Re-creating an archived company with the same VAT is legitimate (05-domain-model §4).
    uniqueIndex('organisation_tenant_vat_uq')
      .on(t.tenantId, t.vatNumber)
      .where(sql`${t.vatNumber} IS NOT NULL AND ${t.archivedAt} IS NULL`),
    foreignKey({
      name: 'organisation_account_owner_fk',
      columns: [t.tenantId, t.accountOwnerMembershipId],
      foreignColumns: [membership.tenantId, membership.id],
    }),
    foreignKey({
      name: 'organisation_created_by_fk',
      columns: [t.tenantId, t.createdByMembershipId],
      foreignColumns: [membership.tenantId, membership.id],
    }),
    index('organisation_account_owner_idx').on(t.tenantId, t.accountOwnerMembershipId),
    check('organisation_display_name_ck', sql`length(btrim(${t.displayName})) > 0`),
    check('organisation_vat_format_ck', sql`${t.vatNumber} ~ '^[A-Z0-9]{2,20}$'`),
    check('organisation_country_ck', sql`${t.country} ~ '^[A-Z]{2}$'`),
  ],
);

export const organisationClassificationLink = pgTable(
  'organisation_classification_link',
  {
    tenantId: tenantIdColumn(),
    organisationId: uuid('organisation_id').notNull(),
    classificationId: uuid('classification_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      name: 'organisation_classification_link_pk',
      columns: [t.organisationId, t.classificationId],
    }),
    foreignKey({
      name: 'organisation_classification_link_organisation_fk',
      columns: [t.tenantId, t.organisationId],
      foreignColumns: [organisation.tenantId, organisation.id],
    }).onDelete('cascade'),
    // Classifications are disabled, never deleted while in use.
    foreignKey({
      name: 'organisation_classification_link_classification_fk',
      columns: [t.tenantId, t.classificationId],
      foreignColumns: [organisationClassification.tenantId, organisationClassification.id],
    }),
    index('organisation_classification_link_classification_idx').on(t.tenantId, t.classificationId),
  ],
);

/** Marketing consent (GDPR). UNKNOWN until the person states a preference. */
export const contactConsentStatus = pgEnum('contact_consent_status', ['UNKNOWN', 'OPTED_IN', 'OPTED_OUT']);

/**
 * A person at an organisation. Archived (soft delete) or, for GDPR erasure, anonymised in place:
 * personal columns are wiped and `anonymised_at` set, the row stays for referential integrity
 * (05-domain-model.md §4).
 */
export const contact = pgTable(
  'contact',
  {
    id: primaryId(),
    tenantId: tenantIdColumn().references(() => tenant.id),
    organisationId: uuid('organisation_id').notNull(),
    firstName: text('first_name').notNull(),
    lastName: text('last_name'),
    /** Accent-insensitive name for search (see immutable_unaccent in migration 0007). */
    nameKey: text('name_key')
      .notNull()
      .generatedAlwaysAs(sql`lower(immutable_unaccent(btrim(first_name || ' ' || coalesce(last_name, ''))))`),
    position: text('position'),
    phone: text('phone'),
    email: citext('email'),
    linkedin: text('linkedin'),
    isDecisionMaker: boolean('is_decision_maker').notNull().default(false),
    /** At most one live primary contact per organisation. */
    isPrimary: boolean('is_primary').notNull().default(false),
    consentStatus: contactConsentStatus('consent_status').notNull().default('UNKNOWN'),
    /** Where the preference was given ("event form", "email reply"…); required once stated. */
    consentSource: text('consent_source'),
    consentAt: timestamp('consent_at', { withTimezone: true }),
    unsubscribedAt: timestamp('unsubscribed_at', { withTimezone: true }),
    /** Derived, so it can never disagree with the consent columns. */
    newsletterEligible: boolean('newsletter_eligible')
      .notNull()
      .generatedAlwaysAs(
        sql`consent_status = 'OPTED_IN' AND unsubscribed_at IS NULL AND archived_at IS NULL AND anonymised_at IS NULL`,
      ),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdByMembershipId: uuid('created_by_membership_id'),
    anonymisedAt: timestamp('anonymised_at', { withTimezone: true }),
    archivedAt: archivedAt(),
    ...timestamps(),
    version: versionColumn(),
  },
  (t) => [
    unique('contact_tenant_id_id_uq').on(t.tenantId, t.id),
    // Target of opportunity/activity (tenant_id, organisation_id, contact_id): same company guaranteed.
    unique('contact_tenant_organisation_id_uq').on(t.tenantId, t.organisationId, t.id),
    foreignKey({
      name: 'contact_organisation_fk',
      columns: [t.tenantId, t.organisationId],
      foreignColumns: [organisation.tenantId, organisation.id],
    }),
    foreignKey({
      name: 'contact_created_by_fk',
      columns: [t.tenantId, t.createdByMembershipId],
      foreignColumns: [membership.tenantId, membership.id],
    }),
    index('contact_organisation_idx').on(t.tenantId, t.organisationId),
    uniqueIndex('contact_one_primary_per_organisation_uq')
      .on(t.tenantId, t.organisationId)
      .where(sql`${t.isPrimary} AND ${t.archivedAt} IS NULL`),
    uniqueIndex('contact_organisation_email_uq')
      .on(t.tenantId, t.organisationId, t.email)
      .where(sql`${t.email} IS NOT NULL AND ${t.archivedAt} IS NULL`),
    check('contact_first_name_ck', sql`length(btrim(${t.firstName})) > 0`),
    check(
      'contact_consent_stated_ck',
      sql`${t.consentStatus} = 'UNKNOWN' OR (${t.consentAt} IS NOT NULL AND ${t.consentSource} IS NOT NULL)`,
    ),
  ],
);

/**
 * Directed link between two organisations of the tenant: `from` is the agency of / supplier to /
 * parent of `to` (e.g. Agency X AGENCY_OF Carrefour). Drives agency visibility later (OPD-16).
 */
export const organisationRelationshipKind = pgEnum('organisation_relationship_kind', [
  'AGENCY_OF',
  'SUPPLIER_TO',
  'PARENT_OF',
]);

export const organisationRelationship = pgTable(
  'organisation_relationship',
  {
    id: primaryId(),
    tenantId: tenantIdColumn().references(() => tenant.id),
    fromOrganisationId: uuid('from_organisation_id').notNull(),
    toOrganisationId: uuid('to_organisation_id').notNull(),
    kind: organisationRelationshipKind('kind').notNull(),
    createdByMembershipId: uuid('created_by_membership_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('organisation_relationship_tenant_id_id_uq').on(t.tenantId, t.id),
    unique('organisation_relationship_uq').on(t.tenantId, t.fromOrganisationId, t.toOrganisationId, t.kind),
    foreignKey({
      name: 'organisation_relationship_from_fk',
      columns: [t.tenantId, t.fromOrganisationId],
      foreignColumns: [organisation.tenantId, organisation.id],
    }),
    foreignKey({
      name: 'organisation_relationship_to_fk',
      columns: [t.tenantId, t.toOrganisationId],
      foreignColumns: [organisation.tenantId, organisation.id],
    }),
    foreignKey({
      name: 'organisation_relationship_created_by_fk',
      columns: [t.tenantId, t.createdByMembershipId],
      foreignColumns: [membership.tenantId, membership.id],
    }),
    index('organisation_relationship_to_idx').on(t.tenantId, t.toOrganisationId),
    check('organisation_relationship_not_self_ck', sql`${t.fromOrganisationId} <> ${t.toOrganisationId}`),
  ],
);

/**
 * A sales opportunity (06-state-machines.md §2). `stage_kind` copies the stage's kind through a
 * composite FK, so it can't drift, and lets the database enforce the state machine's preconditions:
 * WON needs a value and close date, LOST a reason, and closed_at is set exactly when closed.
 * Amounts are net of VAT in RON or EUR (OPD-11).
 */
export const opportunity = pgTable(
  'opportunity',
  {
    id: primaryId(),
    tenantId: tenantIdColumn().references(() => tenant.id),
    organisationId: uuid('organisation_id').notNull(),
    contactId: uuid('contact_id'),
    /** Drives the OWN permission scope (Sales edit and close their own opportunities). */
    ownerMembershipId: uuid('owner_membership_id').notNull(),
    name: text('name').notNull(),
    estimatedValue: numeric('estimated_value', { precision: 14, scale: 2 }),
    currency: text('currency').notNull().default('RON'),
    expectedCloseDate: date('expected_close_date', { mode: 'string' }),
    probability: integer('probability'),
    pipelineStageId: uuid('pipeline_stage_id').notNull(),
    stageKind: pipelineStageKind('stage_kind').notNull(),
    source: text('source'),
    nextAction: text('next_action'),
    nextFollowUpDate: date('next_follow_up_date', { mode: 'string' }),
    lostReason: text('lost_reason'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdByMembershipId: uuid('created_by_membership_id'),
    archivedAt: archivedAt(),
    ...timestamps(),
    version: versionColumn(),
  },
  (t) => [
    unique('opportunity_tenant_id_id_uq').on(t.tenantId, t.id),
    // Target of activity (tenant_id, organisation_id, opportunity_id): same company guaranteed.
    unique('opportunity_tenant_organisation_id_uq').on(t.tenantId, t.organisationId, t.id),
    foreignKey({
      name: 'opportunity_organisation_fk',
      columns: [t.tenantId, t.organisationId],
      foreignColumns: [organisation.tenantId, organisation.id],
    }),
    foreignKey({
      name: 'opportunity_contact_fk',
      columns: [t.tenantId, t.organisationId, t.contactId],
      foreignColumns: [contact.tenantId, contact.organisationId, contact.id],
    }),
    foreignKey({
      name: 'opportunity_owner_fk',
      columns: [t.tenantId, t.ownerMembershipId],
      foreignColumns: [membership.tenantId, membership.id],
    }),
    foreignKey({
      name: 'opportunity_created_by_fk',
      columns: [t.tenantId, t.createdByMembershipId],
      foreignColumns: [membership.tenantId, membership.id],
    }),
    foreignKey({
      name: 'opportunity_stage_fk',
      columns: [t.tenantId, t.pipelineStageId, t.stageKind],
      foreignColumns: [pipelineStage.tenantId, pipelineStage.id, pipelineStage.kind],
    }),
    index('opportunity_stage_idx').on(t.tenantId, t.pipelineStageId),
    index('opportunity_organisation_idx').on(t.tenantId, t.organisationId),
    index('opportunity_owner_idx').on(t.tenantId, t.ownerMembershipId),
    check('opportunity_name_ck', sql`length(btrim(${t.name})) > 0`),
    check('opportunity_currency_ck', sql`${t.currency} IN ('RON', 'EUR')`),
    check('opportunity_value_ck', sql`${t.estimatedValue} IS NULL OR ${t.estimatedValue} >= 0`),
    check('opportunity_probability_ck', sql`${t.probability} IS NULL OR ${t.probability} BETWEEN 0 AND 100`),
    check(
      'opportunity_won_ck',
      sql`${t.stageKind} <> 'WON' OR (${t.estimatedValue} IS NOT NULL AND ${t.expectedCloseDate} IS NOT NULL)`,
    ),
    check(
      'opportunity_lost_ck',
      sql`${t.stageKind} <> 'LOST' OR length(btrim(coalesce(${t.lostReason}, ''))) > 0`,
    ),
    check('opportunity_closed_at_ck', sql`(${t.stageKind} = 'OPEN') = (${t.closedAt} IS NULL)`),
  ],
);

/**
 * Timeline entry on a company (docs/architecture/05-domain-model.md §crm, Hist): calls, meetings,
 * notes, and system entries such as stage changes. Contact and opportunity, when set, belong to the
 * same company (composite FKs).
 */
export const activity = pgTable(
  'activity',
  {
    id: primaryId(),
    tenantId: tenantIdColumn().references(() => tenant.id),
    organisationId: uuid('organisation_id').notNull(),
    contactId: uuid('contact_id'),
    opportunityId: uuid('opportunity_id'),
    activityTypeId: uuid('activity_type_id').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    subject: text('subject').notNull(),
    body: text('body'),
    /** Null for entries written by the platform (e.g. stage changes). Drives the OWN scope. */
    authorMembershipId: uuid('author_membership_id'),
    ...timestamps(),
    version: versionColumn(),
  },
  (t) => [
    unique('activity_tenant_id_id_uq').on(t.tenantId, t.id),
    foreignKey({
      name: 'activity_organisation_fk',
      columns: [t.tenantId, t.organisationId],
      foreignColumns: [organisation.tenantId, organisation.id],
    }),
    foreignKey({
      name: 'activity_contact_fk',
      columns: [t.tenantId, t.organisationId, t.contactId],
      foreignColumns: [contact.tenantId, contact.organisationId, contact.id],
    }),
    foreignKey({
      name: 'activity_opportunity_fk',
      columns: [t.tenantId, t.organisationId, t.opportunityId],
      foreignColumns: [opportunity.tenantId, opportunity.organisationId, opportunity.id],
    }),
    foreignKey({
      name: 'activity_type_fk',
      columns: [t.tenantId, t.activityTypeId],
      foreignColumns: [activityType.tenantId, activityType.id],
    }),
    foreignKey({
      name: 'activity_author_fk',
      columns: [t.tenantId, t.authorMembershipId],
      foreignColumns: [membership.tenantId, membership.id],
    }),
    index('activity_organisation_time_idx').on(t.tenantId, t.organisationId, t.occurredAt),
    index('activity_opportunity_idx').on(t.tenantId, t.opportunityId),
    check('activity_subject_ck', sql`length(btrim(${t.subject})) > 0`),
  ],
);
