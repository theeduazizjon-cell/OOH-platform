/**
 * Tenant configuration ("nomenclatures", docs/architecture/05-domain-model.md §config). All Cfg:
 * tenant-scoped lookups, soft-disabled with `active = false` rather than deleted, because business
 * rows keep referencing them. Defaults are installed by provisioning; tenants edit them freely.
 */
import { sql } from 'drizzle-orm';
import { boolean, check, integer, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { primaryId, tenantIdColumn, timestamps, versionColumn } from './columns';
import { tenant } from './identity';

/** Roles an organisation plays for the tenant (client, agency, supplier…); M:N with organisation. */
export const organisationClassification = pgTable(
  'organisation_classification',
  {
    id: primaryId(),
    tenantId: tenantIdColumn().references(() => tenant.id),
    key: text('key').notNull(),
    name: text('name').notNull(),
    active: boolean('active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    ...timestamps(),
    version: versionColumn(),
  },
  (t) => [
    unique('organisation_classification_tenant_id_id_uq').on(t.tenantId, t.id),
    unique('organisation_classification_tenant_key_uq').on(t.tenantId, t.key),
    check('organisation_classification_key_format_ck', sql`${t.key} ~ '^[a-z][a-z0-9_]*$'`),
  ],
);
