/**
 * Tenant configuration ("nomenclatures", docs/architecture/05-domain-model.md §config). All Cfg:
 * tenant-scoped lookups, soft-disabled with `active = false` rather than deleted, because business
 * rows keep referencing them. Defaults are installed by provisioning; tenants edit them freely.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  integer,
  pgEnum,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
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

/**
 * Sales pipelines (docs/architecture/05-domain-model.md §config). Stages are configurable, their
 * semantics are fixed by `kind` (06-state-machines.md §2). Per OPD-01 the first OPEN stages are the
 * lead stages; there is no separate lead entity.
 */
export const pipeline = pgTable(
  'pipeline',
  {
    id: primaryId(),
    tenantId: tenantIdColumn().references(() => tenant.id),
    name: text('name').notNull(),
    /** New opportunities go here unless another pipeline is chosen. */
    isDefault: boolean('is_default').notNull().default(false),
    active: boolean('active').notNull().default(true),
    ...timestamps(),
    version: versionColumn(),
  },
  (t) => [
    unique('pipeline_tenant_id_id_uq').on(t.tenantId, t.id),
    uniqueIndex('pipeline_one_default_uq')
      .on(t.tenantId)
      .where(sql`${t.isDefault}`),
  ],
);

export const pipelineStageKind = pgEnum('pipeline_stage_kind', ['OPEN', 'WON', 'LOST']);

export const pipelineStage = pgTable(
  'pipeline_stage',
  {
    id: primaryId(),
    tenantId: tenantIdColumn(),
    pipelineId: uuid('pipeline_id').notNull(),
    name: text('name').notNull(),
    /** Fixed once opportunities use the stage (their stage_kind references it). */
    kind: pipelineStageKind('kind').notNull(),
    position: integer('position').notNull(),
    /** Default win probability (%) for opportunities entering the stage. */
    probability: integer('probability'),
    active: boolean('active').notNull().default(true),
    ...timestamps(),
    version: versionColumn(),
  },
  (t) => [
    unique('pipeline_stage_tenant_id_id_uq').on(t.tenantId, t.id),
    // Target of opportunity (tenant_id, pipeline_stage_id, stage_kind): the kind copy can't drift.
    unique('pipeline_stage_tenant_id_kind_uq').on(t.tenantId, t.id, t.kind),
    foreignKey({
      name: 'pipeline_stage_pipeline_fk',
      columns: [t.tenantId, t.pipelineId],
      foreignColumns: [pipeline.tenantId, pipeline.id],
    }),
    // Exactly one WON and one LOST stage per pipeline.
    uniqueIndex('pipeline_stage_one_won_lost_uq')
      .on(t.pipelineId, t.kind)
      .where(sql`${t.kind} <> 'OPEN'`),
    check(
      'pipeline_stage_probability_ck',
      sql`${t.probability} IS NULL OR ${t.probability} BETWEEN 0 AND 100`,
    ),
  ],
);

/** Kinds of timeline activity (call, meeting…). `is_system` types are written by the platform only. */
export const activityType = pgTable(
  'activity_type',
  {
    id: primaryId(),
    tenantId: tenantIdColumn().references(() => tenant.id),
    key: text('key').notNull(),
    name: text('name').notNull(),
    isSystem: boolean('is_system').notNull().default(false),
    active: boolean('active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    ...timestamps(),
    version: versionColumn(),
  },
  (t) => [
    unique('activity_type_tenant_id_id_uq').on(t.tenantId, t.id),
    unique('activity_type_tenant_key_uq').on(t.tenantId, t.key),
    check('activity_type_key_format_ck', sql`${t.key} ~ '^[a-z][a-z0-9_]*$'`),
  ],
);
