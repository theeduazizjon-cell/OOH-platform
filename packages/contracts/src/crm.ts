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

// ── contacts ─────────────────────────────────────────────────────────────────

export const CONTACT_CONSENT_STATUSES = ['UNKNOWN', 'OPTED_IN', 'OPTED_OUT'] as const;
export type ContactConsentStatus = (typeof CONTACT_CONSENT_STATUSES)[number];

const contactFields = {
  firstName: z.string().trim().min(1).max(100),
  lastName: optionalText(100),
  position: optionalText(150),
  phone: optionalText(50),
  email: z
    .string()
    .trim()
    .transform((v) => v || null)
    .pipe(z.email().max(254).nullable())
    .nullable(),
  linkedin: optionalText(300),
  isDecisionMaker: z.boolean(),
  isPrimary: z.boolean(),
  tags: z
    .array(z.string().trim().min(1).max(40))
    .max(20)
    .transform((tags) => [...new Set(tags)]),
};

/**
 * Stating a marketing preference (GDPR): where it was given is mandatory once known, the time
 * defaults to now.
 */
const consentFields = {
  consentStatus: z.enum(CONTACT_CONSENT_STATUSES),
  consentSource: z.string().trim().min(2).max(200).nullable(),
  consentAt: z.iso.datetime({ offset: true }).nullable(),
};

const requireConsentSource = <T extends { consentStatus?: string; consentSource?: string | null }>(body: T) =>
  !body.consentStatus || body.consentStatus === 'UNKNOWN' || Boolean(body.consentSource);

export const createContactRequestSchema = z
  .object({
    organisationId: z.uuid(),
    firstName: contactFields.firstName,
    lastName: contactFields.lastName.optional(),
    position: contactFields.position.optional(),
    phone: contactFields.phone.optional(),
    email: contactFields.email.optional(),
    linkedin: contactFields.linkedin.optional(),
    isDecisionMaker: contactFields.isDecisionMaker.default(false),
    isPrimary: contactFields.isPrimary.default(false),
    tags: contactFields.tags.default([]),
    consentStatus: consentFields.consentStatus.default('UNKNOWN'),
    consentSource: consentFields.consentSource.optional(),
    consentAt: consentFields.consentAt.optional(),
  })
  .refine(requireConsentSource, { path: ['consentSource'], message: 'Say where the consent was given' });
export type CreateContactRequest = z.infer<typeof createContactRequestSchema>;

/** PATCH /contacts/{id} (If-Match required). The organisation of a contact doesn't change. */
export const updateContactRequestSchema = z
  .object({ ...contactFields, ...consentFields })
  .partial()
  .refine((body) => Object.values(body).some((v) => v !== undefined), 'Nothing to change')
  .refine(requireConsentSource, { path: ['consentSource'], message: 'Say where the consent was given' });
export type UpdateContactRequest = z.infer<typeof updateContactRequestSchema>;

export const contactListQuerySchema = pageQuerySchema.extend({
  organisationId: z.uuid().optional(),
  /** Name (accent-insensitive) or email. */
  q: z.string().trim().max(100).optional(),
  includeArchived: z.stringbool().default(false),
});
export type ContactListQuery = z.infer<typeof contactListQuerySchema>;

export interface ContactListItem {
  id: string;
  organisation: { id: string; displayName: string };
  firstName: string;
  lastName: string | null;
  position: string | null;
  email: string | null;
  phone: string | null;
  isPrimary: boolean;
  isDecisionMaker: boolean;
  consentStatus: ContactConsentStatus;
  newsletterEligible: boolean;
  tags: string[];
  archivedAt: string | null;
  anonymisedAt: string | null;
  version: number;
}

export interface ContactDetail extends ContactListItem {
  linkedin: string | null;
  consentSource: string | null;
  consentAt: string | null;
  unsubscribedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── relationships ────────────────────────────────────────────────────────────

export const ORGANISATION_RELATIONSHIP_KINDS = ['AGENCY_OF', 'SUPPLIER_TO', 'PARENT_OF'] as const;
export type OrganisationRelationshipKind = (typeof ORGANISATION_RELATIONSHIP_KINDS)[number];

/** POST /organisations/{id}/relationships: {id} is the "from" side ({id} is AGENCY_OF the other). */
export const createRelationshipRequestSchema = z.object({
  kind: z.enum(ORGANISATION_RELATIONSHIP_KINDS),
  toOrganisationId: z.uuid(),
});
export type CreateRelationshipRequest = z.infer<typeof createRelationshipRequestSchema>;

/** A relationship as seen from one organisation: `direction` says which side it is on. */
export interface OrganisationRelationshipItem {
  id: string;
  kind: OrganisationRelationshipKind;
  /** OUTGOING: this organisation is the agency/supplier/parent; INCOMING: the other one is. */
  direction: 'OUTGOING' | 'INCOMING';
  other: { id: string; displayName: string; archived: boolean };
  createdAt: string;
}

/** GET /organisations/account-owners: members who can own accounts (active, internal). */
export interface AccountOwnerCandidate {
  membershipId: string;
  displayName: string;
}
