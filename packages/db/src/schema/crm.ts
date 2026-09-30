/**
 * CRM (docs/architecture/05-domain-model.md §crm, 01-product-understanding.md §3.3). An organisation
 * is one real-world company, whatever roles it plays (classifications), so a company that is both a
 * client and a supplier is never recorded twice.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
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
import { organisationClassification } from './config';
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
