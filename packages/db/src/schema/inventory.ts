/**
 * OOH inventory (docs/architecture/05-domain-model.md §1.3 and §inventory): asset types and
 * dimension presets (configuration), then asset → mount position → advertising face, plus the
 * asset's commercial terms and manual availability blocks. Faces are the booking unit (OPD-02).
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
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
import { geographyPoint, primaryId, tenantIdColumn, timestamps, versionColumn } from './columns';
import { organisation } from './crm';
import { membership, tenant } from './identity';

/** PostgreSQL `daterange` as its text form, e.g. `[2026-01-01,2027-01-01)` (upper bound exclusive). */
export const dateRange = customType<{ data: string; driverData: string }>({ dataType: () => 'daterange' });

export const assetKind = pgEnum('asset_kind', ['POLE', 'BILLBOARD', 'PRISM', 'MESH', 'WALL', 'OTHER']);
export const assetLifecycle = pgEnum('asset_lifecycle', [
  'PROSPECTIVE',
  'ACTIVE',
  'SUSPENDED',
  'DECOMMISSIONED',
]);
export const assetVerification = pgEnum('asset_verification', [
  'NOT_VERIFIED',
  'TO_BE_VERIFIED',
  'FIELD_VERIFIED',
]);
export const assetAcquisition = pgEnum('asset_acquisition', ['DIRECT', 'SUBLEASED']);
export const costUnit = pgEnum('cost_unit', ['MONTH', 'DAY', 'CAMPAIGN']);

/** Attribute rule of an asset type (a small, documented subset of JSON Schema). */
export interface AttributeSpec {
  readonly type: 'string' | 'number' | 'integer' | 'boolean';
  readonly label: string;
  readonly required?: boolean;
  readonly enum?: readonly string[];
}

/** An asset type is a template (configuration): new kinds of structure are added without code. */
export const assetType = pgTable(
  'asset_type',
  {
    id: primaryId(),
    tenantId: tenantIdColumn().references(() => tenant.id),
    key: text('key').notNull(),
    name: text('name').notNull(),
    kind: assetKind('kind').notNull(),
    /** Asset codes are `{prefix}-{000001}` per tenant and prefix. */
    codePrefix: text('code_prefix').notNull(),
    /** New assets get this many mount positions… */
    defaultMountPositions: integer('default_mount_positions').notNull().default(1),
    /** …at most this many (a pole has 2), enforced by a trigger; null = no limit. */
    maxMountPositions: integer('max_mount_positions'),
    /** Faces each new mount position gets (A, B, …). */
    facesPerMount: integer('faces_per_mount').notNull().default(1),
    /** Flags: selecting a mount books all its faces in one action (OPD-02). */
    facesBookedTogether: boolean('faces_booked_together').notNull().default(false),
    attributeSchema: jsonb('attribute_schema')
      .$type<Record<string, AttributeSpec>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    active: boolean('active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    ...timestamps(),
    version: versionColumn(),
  },
  (t) => [
    unique('asset_type_tenant_id_id_uq').on(t.tenantId, t.id),
    unique('asset_type_tenant_key_uq').on(t.tenantId, t.key),
    check('asset_type_key_format_ck', sql`${t.key} ~ '^[a-z][a-z0-9_]*$'`),
    check('asset_type_prefix_ck', sql`${t.codePrefix} ~ '^[A-Z][A-Z0-9]{1,9}$'`),
    check(
      'asset_type_mounts_ck',
      sql`${t.defaultMountPositions} >= 0 AND ${t.facesPerMount} BETWEEN 1 AND 4 AND (${t.maxMountPositions} IS NULL OR ${t.maxMountPositions} >= greatest(${t.defaultMountPositions}, 1))`,
    ),
  ],
);

/** Face sizes offered when describing a face; copied onto the face as values. */
export const dimensionPreset = pgTable(
  'dimension_preset',
  {
    id: primaryId(),
    tenantId: tenantIdColumn().references(() => tenant.id),
    name: text('name').notNull(),
    widthM: numeric('width_m', { precision: 6, scale: 2 }).notNull(),
    heightM: numeric('height_m', { precision: 6, scale: 2 }).notNull(),
    active: boolean('active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    ...timestamps(),
    version: versionColumn(),
  },
  (t) => [
    unique('dimension_preset_tenant_id_id_uq').on(t.tenantId, t.id),
    unique('dimension_preset_tenant_name_uq').on(t.tenantId, t.name),
    check('dimension_preset_size_ck', sql`${t.widthM} > 0 AND ${t.heightM} > 0`),
  ],
);

/** One physical structure at one place (a pole, a billboard…). */
export const oohAsset = pgTable(
  'ooh_asset',
  {
    id: primaryId(),
    tenantId: tenantIdColumn().references(() => tenant.id),
    code: text('code').notNull(),
    assetTypeId: uuid('asset_type_id').notNull(),
    location: geographyPoint('location').notNull(),
    address: text('address'),
    city: text('city'),
    county: text('county'),
    lifecycle: assetLifecycle('lifecycle').notNull().default('PROSPECTIVE'),
    verificationStatus: assetVerification('verification_status').notNull().default('NOT_VERIFIED'),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
    /** Street View reference (pano id, heading, pitch, fov), not imagery (OPD-19). */
    streetViewRef: jsonb('street_view_ref').$type<{
      panoId: string;
      heading: number;
      pitch: number;
      fov: number;
    }>(),
    attributes: jsonb('attributes')
      .$type<Record<string, string | number | boolean>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    notes: text('notes'),
    suspendReason: text('suspend_reason'),
    createdByMembershipId: uuid('created_by_membership_id'),
    ...timestamps(),
    version: versionColumn(),
  },
  (t) => [
    unique('ooh_asset_tenant_id_id_uq').on(t.tenantId, t.id),
    unique('ooh_asset_code_uq').on(t.tenantId, t.code),
    foreignKey({
      name: 'ooh_asset_type_fk',
      columns: [t.tenantId, t.assetTypeId],
      foreignColumns: [assetType.tenantId, assetType.id],
    }),
    foreignKey({
      name: 'ooh_asset_created_by_fk',
      columns: [t.tenantId, t.createdByMembershipId],
      foreignColumns: [membership.tenantId, membership.id],
    }),
    index('ooh_asset_location_idx').using('gist', t.location),
    index('ooh_asset_type_idx').on(t.tenantId, t.assetTypeId),
    index('ooh_asset_lifecycle_idx').on(t.tenantId, t.lifecycle),
    check(
      'ooh_asset_suspended_ck',
      sql`(${t.lifecycle} = 'SUSPENDED') = (length(btrim(coalesce(${t.suspendReason}, ''))) > 0)`,
    ),
    check(
      'ooh_asset_verified_ck',
      sql`${t.verificationStatus} <> 'FIELD_VERIFIED' OR ${t.lastVerifiedAt} IS NOT NULL`,
    ),
  ],
);

/** A physical slot on the asset (a flag bracket); its faces are the printable surfaces. */
export const mountPosition = pgTable(
  'mount_position',
  {
    id: primaryId(),
    tenantId: tenantIdColumn().references(() => tenant.id),
    assetId: uuid('asset_id').notNull(),
    positionNo: integer('position_no').notNull(),
    /** Compass bearing the mount points to, degrees 0–359. */
    orientationBearing: integer('orientation_bearing'),
    heightM: numeric('height_m', { precision: 5, scale: 2 }),
    notes: text('notes'),
    ...timestamps(),
    version: versionColumn(),
  },
  (t) => [
    unique('mount_position_tenant_id_id_uq').on(t.tenantId, t.id),
    unique('mount_position_no_uq').on(t.assetId, t.positionNo),
    foreignKey({
      name: 'mount_position_asset_fk',
      columns: [t.tenantId, t.assetId],
      foreignColumns: [oohAsset.tenantId, oohAsset.id],
    }),
    check('mount_position_no_ck', sql`${t.positionNo} >= 1`),
    check(
      'mount_position_bearing_ck',
      sql`${t.orientationBearing} IS NULL OR ${t.orientationBearing} BETWEEN 0 AND 359`,
    ),
  ],
);

/** The printable surface: what gets booked (OPD-02). */
export const advertisingFace = pgTable(
  'advertising_face',
  {
    id: primaryId(),
    tenantId: tenantIdColumn().references(() => tenant.id),
    mountPositionId: uuid('mount_position_id').notNull(),
    faceCode: text('face_code').notNull(),
    facingBearing: integer('facing_bearing'),
    /** Which traffic sees it, e.g. "towards the city centre". */
    visibleTrafficDirection: text('visible_traffic_direction'),
    widthM: numeric('width_m', { precision: 6, scale: 2 }),
    heightM: numeric('height_m', { precision: 6, scale: 2 }),
    /** The preset the size came from (values are copied, so preset edits never rewrite history). */
    dimensionPresetId: uuid('dimension_preset_id'),
    illuminated: boolean('illuminated').notNull().default(false),
    ...timestamps(),
    version: versionColumn(),
  },
  (t) => [
    unique('advertising_face_tenant_id_id_uq').on(t.tenantId, t.id),
    unique('advertising_face_code_uq').on(t.mountPositionId, t.faceCode),
    foreignKey({
      name: 'advertising_face_mount_fk',
      columns: [t.tenantId, t.mountPositionId],
      foreignColumns: [mountPosition.tenantId, mountPosition.id],
    }),
    foreignKey({
      name: 'advertising_face_preset_fk',
      columns: [t.tenantId, t.dimensionPresetId],
      foreignColumns: [dimensionPreset.tenantId, dimensionPreset.id],
    }),
    check('advertising_face_code_ck', sql`${t.faceCode} IN ('A', 'B', 'C', 'D')`),
    check(
      'advertising_face_bearing_ck',
      sql`${t.facingBearing} IS NULL OR ${t.facingBearing} BETWEEN 0 AND 359`,
    ),
    check(
      'advertising_face_size_ck',
      sql`(${t.widthM} IS NULL OR ${t.widthM} > 0) AND (${t.heightM} IS NULL OR ${t.heightM} > 0)`,
    ),
  ],
);

/**
 * Who owns or supplies the asset and what it costs, per validity period (history kept). Periods of
 * one asset never overlap (exclusion constraint, migration 0026).
 */
export const assetTerms = pgTable(
  'asset_terms',
  {
    id: primaryId(),
    tenantId: tenantIdColumn().references(() => tenant.id),
    assetId: uuid('asset_id').notNull(),
    acquisition: assetAcquisition('acquisition').notNull(),
    ownerOrganisationId: uuid('owner_organisation_id'),
    supplierOrganisationId: uuid('supplier_organisation_id'),
    costAmount: numeric('cost_amount', { precision: 14, scale: 2 }),
    costUnit: costUnit('cost_unit'),
    currency: text('currency').notNull().default('RON'),
    validPeriod: dateRange('valid_period').notNull(),
    contractRef: text('contract_ref'),
    createdByMembershipId: uuid('created_by_membership_id'),
    ...timestamps(),
    version: versionColumn(),
  },
  (t) => [
    unique('asset_terms_tenant_id_id_uq').on(t.tenantId, t.id),
    foreignKey({
      name: 'asset_terms_asset_fk',
      columns: [t.tenantId, t.assetId],
      foreignColumns: [oohAsset.tenantId, oohAsset.id],
    }),
    foreignKey({
      name: 'asset_terms_owner_fk',
      columns: [t.tenantId, t.ownerOrganisationId],
      foreignColumns: [organisation.tenantId, organisation.id],
    }),
    foreignKey({
      name: 'asset_terms_supplier_fk',
      columns: [t.tenantId, t.supplierOrganisationId],
      foreignColumns: [organisation.tenantId, organisation.id],
    }),
    foreignKey({
      name: 'asset_terms_created_by_fk',
      columns: [t.tenantId, t.createdByMembershipId],
      foreignColumns: [membership.tenantId, membership.id],
    }),
    index('asset_terms_supplier_idx').on(t.tenantId, t.supplierOrganisationId),
    check(
      'asset_terms_subleased_ck',
      sql`${t.acquisition} <> 'SUBLEASED' OR ${t.supplierOrganisationId} IS NOT NULL`,
    ),
    check(
      'asset_terms_cost_ck',
      sql`(${t.costAmount} IS NULL) = (${t.costUnit} IS NULL) AND (${t.costAmount} IS NULL OR ${t.costAmount} >= 0)`,
    ),
    check('asset_terms_currency_ck', sql`${t.currency} IN ('RON', 'EUR')`),
    check(
      'asset_terms_period_ck',
      sql`NOT isempty(${t.validPeriod}) AND lower_inf(${t.validPeriod}) = false`,
    ),
  ],
);

/** A manual unavailability window for a whole asset or one face (reason required). */
export const assetBlock = pgTable(
  'asset_block',
  {
    id: primaryId(),
    tenantId: tenantIdColumn().references(() => tenant.id),
    assetId: uuid('asset_id').notNull(),
    faceId: uuid('face_id'),
    period: dateRange('period').notNull(),
    reason: text('reason').notNull(),
    createdByMembershipId: uuid('created_by_membership_id'),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    unique('asset_block_tenant_id_id_uq').on(t.tenantId, t.id),
    foreignKey({
      name: 'asset_block_asset_fk',
      columns: [t.tenantId, t.assetId],
      foreignColumns: [oohAsset.tenantId, oohAsset.id],
    }),
    foreignKey({
      name: 'asset_block_face_fk',
      columns: [t.tenantId, t.faceId],
      foreignColumns: [advertisingFace.tenantId, advertisingFace.id],
    }),
    foreignKey({
      name: 'asset_block_created_by_fk',
      columns: [t.tenantId, t.createdByMembershipId],
      foreignColumns: [membership.tenantId, membership.id],
    }),
    index('asset_block_asset_idx').on(t.tenantId, t.assetId),
    check('asset_block_reason_ck', sql`length(btrim(${t.reason})) > 0`),
    check(
      'asset_block_period_ck',
      sql`NOT isempty(${t.period}) AND NOT lower_inf(${t.period}) AND NOT upper_inf(${t.period})`,
    ),
  ],
);
