/**
 * CRM contract: organisations (companies) and their classifications.
 * Design: docs/architecture/01-product-understanding.md §3.3, 05-domain-model.md §crm, 10-api.md.
 */
import { z } from 'zod';
import { pageQuerySchema } from './pagination';

/** Installed into every tenant by provisioning; tenants rename, reorder, disable or add their own. */
export const DEFAULT_ORGANISATION_CLASSIFICATIONS = [
  { key: 'prospect', name: 'Prospect' },
  { key: 'client', name: 'Client' },
  { key: 'agency', name: 'Agency' },
  { key: 'ooh_supplier', name: 'OOH supplier' },
  { key: 'print_supplier', name: 'Print supplier' },
  { key: 'support_owner', name: 'Support owner' },
  { key: 'subcontractor', name: 'Subcontractor' },
  { key: 'partner', name: 'Partner' },
] as const;

/**
 * Duplicate detection on the normalised name (crm_name_key): suspected when the trigram similarity
 * reaches NAME_SIMILARITY, or one name contains the other (strict word similarity ≥ NAME_CONTAINMENT),
 * e.g. "Carrefour" vs "Carrefour Romania SA". Calibrated in the M2a PR; a match is a warning the user
 * can override with a reason, while an identical VAT number is always refused.
 */
export const DUPLICATE_NAME_SIMILARITY = 0.7;
export const DUPLICATE_NAME_CONTAINMENT = 0.9;

/** Upper case, letters and digits only: "ro 123.456" → "RO123456". */
export function normaliseVatNumber(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// ── classifications ──────────────────────────────────────────────────────────

export interface ClassificationItem {
  id: string;
  key: string;
  name: string;
  active: boolean;
  sortOrder: number;
  version: number;
}

export const createClassificationRequestSchema = z.object({
  name: z.string().trim().min(1).max(60),
  sortOrder: z.number().int().min(0).max(1000).optional(),
});
export type CreateClassificationRequest = z.infer<typeof createClassificationRequestSchema>;

export const updateClassificationRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    sortOrder: z.number().int().min(0).max(1000).optional(),
    active: z.boolean().optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), 'Nothing to change');
export type UpdateClassificationRequest = z.infer<typeof updateClassificationRequestSchema>;

// ── organisations ────────────────────────────────────────────────────────────

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullable();

const organisationFields = {
  displayName: z.string().trim().min(1).max(200),
  legalName: optionalText(200),
  vatNumber: z
    .string()
    .transform(normaliseVatNumber)
    .refine((v) => v === '' || /^[A-Z0-9]{2,20}$/.test(v), 'VAT number must be 2–20 letters or digits')
    .transform((v) => v || null)
    .nullable(),
  website: optionalText(300),
  address: optionalText(300),
  city: optionalText(100),
  county: optionalText(100),
  country: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, 'Use a two-letter country code'),
  industry: optionalText(100),
  notes: optionalText(5000),
  classificationIds: z
    .array(z.uuid())
    .max(20)
    .refine((ids) => new Set(ids).size === ids.length, 'Classification ids must be unique'),
  /** Defaults to the creator. Drives OWN-scoped permissions. */
  accountOwnerMembershipId: z.uuid().nullable(),
};

export const createOrganisationRequestSchema = z
  .object({
    displayName: organisationFields.displayName,
    legalName: organisationFields.legalName.optional(),
    vatNumber: organisationFields.vatNumber.optional(),
    website: organisationFields.website.optional(),
    address: organisationFields.address.optional(),
    city: organisationFields.city.optional(),
    county: organisationFields.county.optional(),
    country: organisationFields.country.default('RO'),
    industry: organisationFields.industry.optional(),
    notes: organisationFields.notes.optional(),
    classificationIds: organisationFields.classificationIds.default([]),
    accountOwnerMembershipId: organisationFields.accountOwnerMembershipId.optional(),
    /** Create despite a suspected (name) duplicate. Identical VAT numbers are always refused. */
    force: z.boolean().default(false),
    forceReason: z.string().trim().min(5).max(500).optional(),
  })
  .refine((body) => !body.force || body.forceReason, {
    path: ['forceReason'],
    message: 'Explain why this is not a duplicate',
  });
export type CreateOrganisationRequest = z.infer<typeof createOrganisationRequestSchema>;

/** PATCH /organisations/{id} (If-Match required): any subset of the fields. */
export const updateOrganisationRequestSchema = z
  .object(organisationFields)
  .partial()
  .refine((body) => Object.values(body).some((v) => v !== undefined), 'Nothing to change');
export type UpdateOrganisationRequest = z.infer<typeof updateOrganisationRequestSchema>;

export const organisationListQuerySchema = pageQuerySchema.extend({
  /** Search in names and VAT number (accent- and legal-form-insensitive). */
  q: z.string().trim().max(100).optional(),
  classificationId: z.uuid().optional(),
  includeArchived: z.stringbool().default(false),
});
export type OrganisationListQuery = z.infer<typeof organisationListQuerySchema>;

export interface OrganisationListItem {
  id: string;
  displayName: string;
  legalName: string | null;
  vatNumber: string | null;
  city: string | null;
  county: string | null;
  country: string;
  classifications: { id: string; key: string; name: string }[];
  accountOwner: { membershipId: string; displayName: string } | null;
  archivedAt: string | null;
  version: number;
}

export interface OrganisationDetail extends OrganisationListItem {
  website: string | null;
  address: string | null;
  industry: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `meta.matches` of a 409 DUPLICATE_SUSPECTED on POST /organisations. */
export interface DuplicateMatch {
  id: string;
  displayName: string;
  vatNumber: string | null;
  city: string | null;
  /** VAT: same VAT number (also ignoring an RO prefix); NAME: similar normalised name. */
  reason: 'VAT' | 'NAME';
  similarity: number;
}
