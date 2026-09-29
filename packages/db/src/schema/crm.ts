/**
 * CRM (docs/architecture/05-domain-model.md §crm, 01-product-understanding.md §3.3). An organisation
 * is one real-world company, whatever roles it plays (classifications), so a company that is both a
 * client and a supplier is never recorded twice.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { archivedAt, primaryId, tenantIdColumn, timestamps, versionColumn } from './columns';
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
