import { z } from 'zod';
import { pageQuerySchema } from './pagination';
import type { AssetLifecycleAction } from './state-machines/asset';

/**
 * OOH inventory (docs/architecture/05-domain-model.md §1.3, §inventory; 06-state-machines.md §6).
 * Asset → mount position → advertising face; the face is the booking unit (OPD-02).
 */

export const ASSET_KINDS = ['POLE', 'BILLBOARD', 'PRISM', 'MESH', 'WALL', 'OTHER'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];
export const ASSET_LIFECYCLES = ['PROSPECTIVE', 'ACTIVE', 'SUSPENDED', 'DECOMMISSIONED'] as const;
export type AssetLifecycle = (typeof ASSET_LIFECYCLES)[number];
export const ASSET_VERIFICATIONS = ['NOT_VERIFIED', 'TO_BE_VERIFIED', 'FIELD_VERIFIED'] as const;
export type AssetVerification = (typeof ASSET_VERIFICATIONS)[number];
export const ASSET_ACQUISITIONS = ['DIRECT', 'SUBLEASED'] as const;
export const COST_UNITS = ['MONTH', 'DAY', 'CAMPAIGN'] as const;
export const FACE_CODES = ['A', 'B', 'C', 'D'] as const;

/** Duplicate check radius for new or moved assets of the same kind (05-domain-model §1.4). */
export const DUPLICATE_RADIUS_M = 10;

export interface AttributeSpec {
  type: 'string' | 'number' | 'integer' | 'boolean';
  label: string;
  required?: boolean;
  enum?: readonly string[];
}

export interface AssetTypeTemplate {
  key: string;
  name: string;
  kind: AssetKind;
  codePrefix: string;
  defaultMountPositions: number;
  maxMountPositions: number | null;
  facesPerMount: number;
  facesBookedTogether: boolean;
  attributeSchema: Record<string, AttributeSpec>;
}

/** Provisioned for every new company; tenants then own and edit them. */
export const DEFAULT_ASSET_TYPES: readonly AssetTypeTemplate[] = [
  {
    key: 'pole',
    name: 'Flag pole',
    kind: 'POLE',
    codePrefix: 'POLE',
    defaultMountPositions: 2,
    maxMountPositions: 2,
    facesPerMount: 2,
    facesBookedTogether: true,
    attributeSchema: {
      material: { type: 'string', label: 'Material', enum: ['metal', 'concrete', 'wood'] },
      poleHeightM: { type: 'number', label: 'Pole height (m)' },
    },
  },
  {
    key: 'billboard',
    name: 'Billboard',
    kind: 'BILLBOARD',
    codePrefix: 'BB',
    defaultMountPositions: 1,
    maxMountPositions: 1,
    facesPerMount: 2,
    facesBookedTogether: false,
    attributeSchema: {
      structure: { type: 'string', label: 'Structure', enum: ['single', 'back-to-back', 'v-shape'] },
    },
  },
  {
    key: 'prism',
    name: 'Prismavision',
    kind: 'PRISM',
    codePrefix: 'PRISM',
    defaultMountPositions: 1,
    maxMountPositions: 1,
    facesPerMount: 3,
    facesBookedTogether: false,
    attributeSchema: { rotationSeconds: { type: 'integer', label: 'Rotation (s)' } },
  },
  {
    key: 'mesh',
    name: 'Mesh',
    kind: 'MESH',
    codePrefix: 'MESH',
    defaultMountPositions: 1,
    maxMountPositions: 1,
    facesPerMount: 1,
    facesBookedTogether: false,
    attributeSchema: { areaM2: { type: 'number', label: 'Surface (m²)' } },
  },
  {
    key: 'wall',
    name: 'Wall',
    kind: 'WALL',
    codePrefix: 'WALL',
    defaultMountPositions: 1,
    maxMountPositions: null,
    facesPerMount: 1,
    facesBookedTogether: false,
    attributeSchema: { permitRef: { type: 'string', label: 'Permit reference' } },
  },
  {
    key: 'other',
    name: 'Other',
    kind: 'OTHER',
    codePrefix: 'OOH',
    defaultMountPositions: 1,
    maxMountPositions: null,
    facesPerMount: 1,
    facesBookedTogether: false,
    attributeSchema: {},
  },
];

export const DEFAULT_DIMENSION_PRESETS = [
  { name: '0.8 × 2 m', widthM: '0.80', heightM: '2.00' },
  { name: '0.8 × 1.4 m', widthM: '0.80', heightM: '1.40' },
  { name: '0.8 × 1.2 m', widthM: '0.80', heightM: '1.20' },
  { name: '4 × 3 m', widthM: '4.00', heightM: '3.00' },
  { name: '12 × 3 m', widthM: '12.00', heightM: '3.00' },
] as const;

/** Values of `attributes` against the type's schema; returns problems (empty = valid). */
export function attributeProblems(
  schema: Record<string, AttributeSpec>,
  values: Record<string, unknown>,
): { path: string; message: string }[] {
  const problems: { path: string; message: string }[] = [];
  for (const key of Object.keys(values)) {
    if (!(key in schema))
      problems.push({ path: `attributes.${key}`, message: 'Not an attribute of this type' });
  }
  for (const [key, spec] of Object.entries(schema)) {
    const value = values[key];
    const path = `attributes.${key}`;
    if (value === undefined || value === null || value === '') {
      if (spec.required) problems.push({ path, message: `${spec.label} is required` });
      continue;
    }
    const ok =
      spec.type === 'boolean'
        ? typeof value === 'boolean'
        : spec.type === 'string'
          ? typeof value === 'string'
          : typeof value === 'number' &&
            Number.isFinite(value) &&
            (spec.type === 'number' || Number.isInteger(value));
    if (!ok)
      problems.push({
        path,
        message: `${spec.label} must be ${spec.type === 'integer' ? 'a whole number' : `a ${spec.type}`}`,
      });
    else if (spec.enum && typeof value === 'string' && !spec.enum.includes(value))
      problems.push({ path, message: `${spec.label} is one of ${spec.enum.join(', ')}` });
  }
  return problems;
}

// ── API shapes ───────────────────────────────────────────────────────────────

export interface AssetTypeItem extends AssetTypeTemplate {
  id: string;
  active: boolean;
  version: number;
}

export interface DimensionPresetItem {
  id: string;
  name: string;
  widthM: string;
  heightM: string;
  active: boolean;
}

export interface FaceItem {
  id: string;
  faceCode: (typeof FACE_CODES)[number];
  facingBearing: number | null;
  visibleTrafficDirection: string | null;
  widthM: string | null;
  heightM: string | null;
  dimensionPresetId: string | null;
  illuminated: boolean;
  version: number;
}

export interface MountItem {
  id: string;
  positionNo: number;
  orientationBearing: number | null;
  heightM: string | null;
  notes: string | null;
  version: number;
  faces: FaceItem[];
}

export interface TermsItem {
  id: string;
  acquisition: (typeof ASSET_ACQUISITIONS)[number];
  owner: { id: string; displayName: string } | null;
  supplier: { id: string; displayName: string } | null;
  costAmount: string | null;
  costUnit: (typeof COST_UNITS)[number] | null;
  currency: 'RON' | 'EUR';
  validFrom: string;
  /** Last day included; null = open-ended. */
  validTo: string | null;
  contractRef: string | null;
  version: number;
}

export interface BlockItem {
  id: string;
  faceId: string | null;
  from: string;
  /** Last day included. */
  to: string;
  reason: string;
  releasedAt: string | null;
}

export type AssetAction = AssetLifecycleAction;

export interface AssetListItem {
  id: string;
  code: string;
  type: { id: string; name: string; kind: AssetKind };
  location: { lat: number; lng: number };
  address: string | null;
  city: string | null;
  county: string | null;
  lifecycle: AssetLifecycle;
  verificationStatus: AssetVerification;
  mountCount: number;
  faceCount: number;
  /** Metres from the `near` point of the query, when one was given. */
  distanceM: number | null;
  version: number;
}

export interface AssetDetail extends AssetListItem {
  attributes: Record<string, string | number | boolean>;
  notes: string | null;
  suspendReason: string | null;
  lastVerifiedAt: string | null;
  streetViewRef: { panoId: string; heading: number; pitch: number; fov: number } | null;
  mounts: MountItem[];
  /** Only for holders of asset.terms.read (null otherwise). */
  terms: TermsItem[] | null;
  blocks: BlockItem[];
  actions: AssetAction[];
}

/** 409 DUPLICATE_SUSPECTED meta: same-kind assets within DUPLICATE_RADIUS_M. */
export interface NearbyAsset {
  id: string;
  code: string;
  distanceM: number;
  lifecycle: AssetLifecycle;
}

// ── requests ─────────────────────────────────────────────────────────────────

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable();
const isoDate = z.iso.date();
const lat = z.number().min(-90).max(90);
const lng = z.number().min(-180).max(180);
const bearing = z.number().int().min(0).max(359);
const metres = z
  .string()
  .trim()
  .regex(/^\d{1,4}(\.\d{1,2})?$/, 'Use metres like 0.8 or 12');
const attributes = z.record(z.string(), z.union([z.string().max(200), z.number(), z.boolean()]));
const streetViewRef = z.object({
  panoId: z.string().min(1).max(200),
  heading: z.number().min(0).max(360),
  pitch: z.number().min(-90).max(90),
  fov: z.number().min(10).max(120),
});
/** Creating or moving onto a spot within DUPLICATE_RADIUS_M of a same-kind asset needs a reason. */
const duplicateOverride = z.object({ reason: z.string().trim().min(3).max(500) });

/** POST /assets: mounts and faces come from the type template. */
export const createAssetRequestSchema = z.object({
  assetTypeId: z.uuid(),
  lat,
  lng,
  address: optionalText(300).optional(),
  city: optionalText(100).optional(),
  county: optionalText(100).optional(),
  attributes: attributes.default({}),
  notes: optionalText(5000).optional(),
  streetViewRef: streetViewRef.nullable().optional(),
  duplicateOverride: duplicateOverride.optional(),
});
export type CreateAssetRequest = z.infer<typeof createAssetRequestSchema>;

/** PATCH /assets/{id} (If-Match). Moving the asset re-runs the duplicate check. */
export const updateAssetRequestSchema = z
  .object({
    lat,
    lng,
    address: optionalText(300),
    city: optionalText(100),
    county: optionalText(100),
    attributes,
    notes: optionalText(5000),
    streetViewRef: streetViewRef.nullable(),
    duplicateOverride,
  })
  .partial()
  .refine((b) => (b.lat === undefined) === (b.lng === undefined), {
    message: 'Give both lat and lng to move the asset',
    path: ['lat'],
  })
  .refine(
    (b) => Object.entries(b).some(([k, v]) => k !== 'duplicateOverride' && v !== undefined),
    'Nothing to change',
  );
export type UpdateAssetRequest = z.infer<typeof updateAssetRequestSchema>;

export const mountRequestSchema = z.object({
  orientationBearing: bearing.nullable().optional(),
  heightM: metres.nullable().optional(),
  notes: optionalText(2000).optional(),
});
export type MountRequest = z.infer<typeof mountRequestSchema>;

/** PATCH /faces/{id} (If-Match). A preset copies its size onto the face. */
export const updateFaceRequestSchema = z
  .object({
    facingBearing: bearing.nullable(),
    visibleTrafficDirection: optionalText(200),
    widthM: metres.nullable(),
    heightM: metres.nullable(),
    dimensionPresetId: z.uuid().nullable(),
    illuminated: z.boolean(),
  })
  .partial()
  .refine((b) => Object.values(b).some((v) => v !== undefined), 'Nothing to change');
export type UpdateFaceRequest = z.infer<typeof updateFaceRequestSchema>;

/** POST /assets/{id}/terms: a new period; it must not overlap an existing one. */
export const createTermsRequestSchema = z
  .object({
    acquisition: z.enum(ASSET_ACQUISITIONS),
    ownerOrganisationId: z.uuid().nullable().optional(),
    supplierOrganisationId: z.uuid().nullable().optional(),
    costAmount: z
      .string()
      .trim()
      .regex(/^\d{1,12}(\.\d{1,2})?$/, 'Use an amount like 1200 or 1200.50')
      .nullable()
      .optional(),
    costUnit: z.enum(COST_UNITS).nullable().optional(),
    currency: z.enum(['RON', 'EUR']).default('RON'),
    validFrom: isoDate,
    validTo: isoDate.nullable().optional(),
    contractRef: optionalText(200).optional(),
  })
  .refine((t) => t.acquisition !== 'SUBLEASED' || t.supplierOrganisationId, {
    message: 'A subleased asset needs its supplier',
    path: ['supplierOrganisationId'],
  })
  .refine((t) => !t.costAmount === !t.costUnit, {
    message: 'Give the cost and its unit together',
    path: ['costUnit'],
  })
  .refine((t) => !t.validTo || t.validTo >= t.validFrom, {
    message: 'The end is before the start',
    path: ['validTo'],
  });
export type CreateTermsRequest = z.infer<typeof createTermsRequestSchema>;

/** POST /terms/{id}/actions/close (If-Match): the period ends on `validTo` (included). */
export const closeTermsRequestSchema = z.object({ validTo: isoDate });

export const createBlockRequestSchema = z
  .object({
    faceId: z.uuid().optional(),
    from: isoDate,
    to: isoDate,
    reason: z.string().trim().min(3).max(500),
  })
  .refine((b) => b.to >= b.from, { message: 'The end is before the start', path: ['to'] });
export type CreateBlockRequest = z.infer<typeof createBlockRequestSchema>;

export const assetReasonSchema = z.object({ reason: z.string().trim().min(3).max(500) });

export const assetListQuerySchema = pageQuerySchema.extend({
  q: z.string().trim().max(100).optional(),
  assetTypeId: z.uuid().optional(),
  lifecycle: z.enum(ASSET_LIFECYCLES).optional(),
  /** Research: assets around a point (e.g. a confirmed store pin), nearest first. */
  nearLat: z.coerce.number().min(-90).max(90).optional(),
  nearLng: z.coerce.number().min(-180).max(180).optional(),
  radiusM: z.coerce.number().int().min(10).max(50_000).default(3000),
});
export type AssetListQuery = z.infer<typeof assetListQuerySchema>;
