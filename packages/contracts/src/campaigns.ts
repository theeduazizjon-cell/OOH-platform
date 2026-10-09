import { z } from 'zod';
import { pageQuerySchema } from './pagination';
import {
  CAMPAIGN_STATUSES,
  type GeocodeStatus,
  type CampaignAction,
  type CampaignStatus,
  type LocationAction,
  type LocationStatus,
} from './state-machines/campaign';

/**
 * Campaigns and their locations (docs/architecture/05-domain-model.md §briefs & campaigns,
 * 04-user-flows.md A5). A campaign is an umbrella: its dates and progress derive from its
 * locations, where the operational work happens. Each location has a store pin (geocoded, then
 * confirmed by a person) before research starts.
 */

export interface LocationItem {
  id: string;
  campaignId: string;
  name: string;
  address: string | null;
  city: string | null;
  county: string | null;
  startDate: string | null;
  endDate: string | null;
  requestedUnits: number | null;
  buyer: { membershipId: string; displayName: string } | null;
  status: LocationStatus;
  /** Set while ON_HOLD: the status a resume returns to. */
  previousStatus: LocationStatus | null;
  holdReason: string | null;
  cancelReason: string | null;
  researchRadiusM: number | null;
  briefLineId: string | null;
  /** The store's position (WGS84); set by geocoding, then confirmed or moved by a person. */
  storePoint: { lat: number; lng: number } | null;
  geocodeStatus: GeocodeStatus;
  /** What the geocoder understood the address to be (to compare with the brief's text). */
  geocodedAddress: string | null;
  geocodeError: string | null;
  pinConfirmedAt: string | null;
  version: number;
  actions: LocationAction[];
}

export interface CampaignListItem {
  id: string;
  /** Unique per tenant, e.g. 2026-0007. */
  code: string;
  name: string;
  status: CampaignStatus;
  client: { id: string; displayName: string };
  agency: { id: string; displayName: string } | null;
  opportunity: { id: string; name: string } | null;
  owner: { membershipId: string; displayName: string };
  /** Derived from the locations that aren't cancelled. */
  startDate: string | null;
  endDate: string | null;
  locations: { total: number; byStatus: Partial<Record<LocationStatus, number>> };
  createdAt: string;
  version: number;
}

export interface CampaignDetail extends CampaignListItem {
  notes: string | null;
  holdReason: string | null;
  cancelReason: string | null;
  locationItems: LocationItem[];
  actions: CampaignAction[];
}

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable();
const isoDate = z.iso.date();
const reason = z.string().trim().min(3).max(500);

/** POST /campaigns: a campaign without a brief (locations are added afterwards). */
export const createCampaignRequestSchema = z.object({
  name: z.string().trim().min(1).max(200),
  clientOrganisationId: z.uuid(),
  agencyOrganisationId: z.uuid().nullable().optional(),
  /** The buyer responsible; defaults to the creator. Drives the OWN scope. */
  ownerMembershipId: z.uuid().optional(),
  notes: optionalText(5000).optional(),
});
export type CreateCampaignRequest = z.infer<typeof createCampaignRequestSchema>;

/** PATCH /campaigns/{id} (If-Match). The client never changes; statuses change through actions. */
export const updateCampaignRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    agencyOrganisationId: z.uuid().nullable(),
    ownerMembershipId: z.uuid(),
    notes: optionalText(5000),
  })
  .partial()
  .refine((body) => Object.values(body).some((v) => v !== undefined), 'Nothing to change');
export type UpdateCampaignRequest = z.infer<typeof updateCampaignRequestSchema>;

/** hold (optional reason) / cancel (reason required). */
export const campaignHoldRequestSchema = z.object({ reason: reason.optional() });
export const cancelRequestSchema = z.object({ reason });
export const locationHoldRequestSchema = z.object({ reason });

const locationFields = {
  name: z.string().trim().min(1).max(200),
  address: optionalText(300),
  city: optionalText(100),
  county: optionalText(100),
  startDate: isoDate.nullable(),
  endDate: isoDate.nullable(),
  requestedUnits: z.number().int().min(1).max(10000).nullable(),
  buyerMembershipId: z.uuid().nullable(),
  /** Research search radius around the store, metres. */
  researchRadiusM: z.number().int().min(50).max(50000).nullable(),
};
const datesInOrder = (l: { startDate?: string | null; endDate?: string | null }) =>
  !(l.startDate && l.endDate && l.endDate < l.startDate);

export const createLocationRequestSchema = z
  .object({
    name: locationFields.name,
    address: locationFields.address.optional(),
    city: locationFields.city.optional(),
    county: locationFields.county.optional(),
    startDate: locationFields.startDate.optional(),
    endDate: locationFields.endDate.optional(),
    requestedUnits: locationFields.requestedUnits.optional(),
    buyerMembershipId: locationFields.buyerMembershipId.optional(),
    researchRadiusM: locationFields.researchRadiusM.optional(),
  })
  .refine(datesInOrder, { message: 'The end date is before the start date', path: ['endDate'] });
export type CreateLocationRequest = z.infer<typeof createLocationRequestSchema>;

/** PATCH /locations/{id} (If-Match): not once the location is finished or cancelled. */
export const updateLocationRequestSchema = z
  .object(locationFields)
  .partial()
  .refine((body) => Object.values(body).some((v) => v !== undefined), 'Nothing to change')
  .refine(datesInOrder, { message: 'The end date is before the start date', path: ['endDate'] });
export type UpdateLocationRequest = z.infer<typeof updateLocationRequestSchema>;

/**
 * POST /briefs/{id}/actions/convert (If-Match): a confirmed brief becomes a new campaign, or adds its
 * stores to an existing one of the same client (OPD-07b). One location per brief line.
 */
export const convertBriefRequestSchema = z
  .object({
    campaignId: z.uuid().optional(),
    /** Name of the new campaign; defaults to the brief title. */
    campaignName: z.string().trim().min(1).max(200).optional(),
  })
  .refine((b) => !(b.campaignId && b.campaignName), {
    message: 'Either add to an existing campaign or name a new one',
    path: ['campaignName'],
  });
export type ConvertBriefRequest = z.infer<typeof convertBriefRequestSchema>;

/** PUT /locations/{id}/store-point (If-Match): a person places or accepts the pin. */
export const storePointRequestSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  /** The geocoder's place, when the person accepted its suggestion as is. */
  placeId: z.string().trim().max(300).optional(),
});
export type StorePointRequest = z.infer<typeof storePointRequestSchema>;

export const campaignListQuerySchema = pageQuerySchema.extend({
  status: z.enum(CAMPAIGN_STATUSES).optional(),
  clientOrganisationId: z.uuid().optional(),
  q: z.string().trim().max(100).optional(),
});
export type CampaignListQuery = z.infer<typeof campaignListQuerySchema>;
