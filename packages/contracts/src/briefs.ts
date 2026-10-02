import { z } from 'zod';
import { pageQuerySchema } from './pagination';
import { BRIEF_STATUSES, type BriefAction, type BriefStatus } from './state-machines/brief';

/**
 * Briefs (docs/architecture/05-domain-model.md §briefs & campaigns, 04-user-flows.md A2'–A4): a client
 * request with its store lines, reviewed by a buyer before it becomes a campaign. AI provenance fields
 * are reserved now so email intake (M13) needs no migration.
 */

export const BRIEF_SOURCES = ['MANUAL', 'OPPORTUNITY', 'EMAIL', 'PORTAL', 'API'] as const;
export type BriefSource = (typeof BRIEF_SOURCES)[number];
export const BRIEF_CURRENCIES = ['RON', 'EUR'] as const;

export interface BriefLineItem {
  id: string;
  position: number;
  storeName: string;
  address: string | null;
  city: string | null;
  county: string | null;
  requestedUnits: number | null;
  dimension: string | null;
  startDate: string | null;
  endDate: string | null;
  notes: string | null;
}

export interface BriefListItem {
  id: string;
  title: string;
  status: BriefStatus;
  source: BriefSource;
  client: { id: string; displayName: string } | null;
  agency: { id: string; displayName: string } | null;
  opportunity: { id: string; name: string } | null;
  owner: { membershipId: string; displayName: string };
  requestedStart: string | null;
  requestedEnd: string | null;
  deadline: string | null;
  lineCount: number;
  aiGenerated: boolean;
  createdAt: string;
  version: number;
}

export interface BriefDetail extends BriefListItem {
  datesTbd: boolean;
  budget: string | null;
  currency: (typeof BRIEF_CURRENCIES)[number];
  specialRequirements: string | null;
  discardReason: string | null;
  confirmedAt: string | null;
  /** Per field: AI, HUMAN or AI_EDITED (empty for manual briefs). */
  fieldProvenance: Record<string, 'AI' | 'HUMAN' | 'AI_EDITED'>;
  lines: BriefLineItem[];
  /** Actions the brief's status allows (the API still checks permissions and guards). */
  actions: BriefAction[];
}

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable();
const isoDate = z.iso.date();
const money = z
  .string()
  .trim()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, 'Use an amount like 12500 or 12500.50');

export const briefLineInputSchema = z
  .object({
    storeName: z.string().trim().min(1).max(200),
    address: optionalText(300).optional(),
    city: optionalText(100).optional(),
    county: optionalText(100).optional(),
    requestedUnits: z.number().int().min(1).max(10000).nullable().optional(),
    dimension: optionalText(100).optional(),
    startDate: isoDate.nullable().optional(),
    endDate: isoDate.nullable().optional(),
    notes: optionalText(2000).optional(),
  })
  .refine((l) => !(l.startDate && l.endDate && l.endDate < l.startDate), {
    message: 'The end date is before the start date',
    path: ['endDate'],
  });
export type BriefLineInput = z.infer<typeof briefLineInputSchema>;
const lines = z.array(briefLineInputSchema).max(500);

const briefFields = {
  title: z.string().trim().min(1).max(200),
  clientOrganisationId: z.uuid().nullable(),
  agencyOrganisationId: z.uuid().nullable(),
  ownerMembershipId: z.uuid(),
  requestedStart: isoDate.nullable(),
  requestedEnd: isoDate.nullable(),
  /** Dates not known yet: confirm is allowed without them. */
  datesTbd: z.boolean(),
  deadline: isoDate.nullable(),
  budget: money.nullable(),
  currency: z.enum(BRIEF_CURRENCIES),
  specialRequirements: optionalText(5000),
};

const datesInOrder = (b: { requestedStart?: string | null; requestedEnd?: string | null }) =>
  !(b.requestedStart && b.requestedEnd && b.requestedEnd < b.requestedStart);

/** POST /briefs (MANUAL). Lines can be given up front (Sales create but don't edit briefs). */
export const createBriefRequestSchema = z
  .object({
    title: briefFields.title,
    clientOrganisationId: briefFields.clientOrganisationId.optional(),
    agencyOrganisationId: briefFields.agencyOrganisationId.optional(),
    /** Defaults to the creator. Drives the OWN scope. */
    ownerMembershipId: briefFields.ownerMembershipId.optional(),
    requestedStart: briefFields.requestedStart.optional(),
    requestedEnd: briefFields.requestedEnd.optional(),
    datesTbd: briefFields.datesTbd.default(false),
    deadline: briefFields.deadline.optional(),
    budget: briefFields.budget.optional(),
    currency: briefFields.currency.default('RON'),
    specialRequirements: briefFields.specialRequirements.optional(),
    lines: lines.default([]),
  })
  .refine(datesInOrder, { message: 'The end date is before the start date', path: ['requestedEnd'] });
export type CreateBriefRequest = z.infer<typeof createBriefRequestSchema>;

/** PATCH /briefs/{id} (If-Match): drafts only. */
export const updateBriefRequestSchema = z
  .object(briefFields)
  .partial()
  .refine((body) => Object.values(body).some((v) => v !== undefined), 'Nothing to change')
  .refine(datesInOrder, { message: 'The end date is before the start date', path: ['requestedEnd'] });
export type UpdateBriefRequest = z.infer<typeof updateBriefRequestSchema>;

/** PUT /briefs/{id}/lines (If-Match on the brief): replaces all lines of a draft, in order. */
export const putBriefLinesRequestSchema = z.object({ lines });
export type PutBriefLinesRequest = z.infer<typeof putBriefLinesRequestSchema>;

export const discardBriefRequestSchema = z.object({ reason: z.string().trim().min(3).max(500) });

export const briefListQuerySchema = pageQuerySchema.extend({
  status: z.enum(BRIEF_STATUSES).optional(),
  clientOrganisationId: z.uuid().optional(),
  opportunityId: z.uuid().optional(),
  q: z.string().trim().max(100).optional(),
});
export type BriefListQuery = z.infer<typeof briefListQuerySchema>;

/** What `confirm` requires (04-user-flows.md A4); the API answers 422 listing the missing ones. */
export function briefConfirmProblems(brief: {
  clientOrganisationId: string | null;
  requestedStart: string | null;
  requestedEnd: string | null;
  datesTbd: boolean;
  lines: readonly { address: string | null; city: string | null }[];
}): { path: string; message: string }[] {
  return [
    ...(brief.clientOrganisationId ? [] : [{ path: 'clientOrganisationId', message: 'Choose the client' }]),
    ...(brief.lines.some((l) => l.address || l.city)
      ? []
      : [{ path: 'lines', message: 'Add at least one store with an address or a city' }]),
    ...(brief.datesTbd || (brief.requestedStart && brief.requestedEnd)
      ? []
      : [{ path: 'requestedStart', message: 'Give the campaign dates, or mark them as not known yet' }]),
  ];
}
