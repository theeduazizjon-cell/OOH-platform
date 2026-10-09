import { PREVIOUS_STATUS, type TransitionTable } from './index';

/** Campaign (06-state-machines.md §4): an umbrella; `complete` (system) and `reopen` come later. */
export const CAMPAIGN_STATUSES = ['ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];
export const CAMPAIGN_ACTIONS = ['hold', 'resume', 'cancel'] as const;
export type CampaignAction = (typeof CAMPAIGN_ACTIONS)[number];

export const CAMPAIGN_TRANSITIONS: TransitionTable<CampaignStatus, CampaignAction> = {
  hold: { action: 'hold', from: ['ACTIVE'], to: 'ON_HOLD', permission: 'campaign.update' },
  resume: { action: 'resume', from: ['ON_HOLD'], to: 'ACTIVE', permission: 'campaign.update' },
  cancel: { action: 'cancel', from: ['ACTIVE', 'ON_HOLD'], to: 'CANCELLED', permission: 'campaign.cancel' },
};

/**
 * Campaign location (06-state-machines.md §5), the operational state machine. Implemented so far:
 * start-research (pin confirmed), hold, resume and cancel; the other transitions arrive with
 * studies, production and field ops.
 */
export const LOCATION_STATUSES = [
  'DRAFT',
  'RESEARCH',
  'AWAITING_APPROVAL',
  'APPROVED',
  'IN_PRODUCTION',
  'READY_FOR_INSTALLATION',
  'INSTALLING',
  'LIVE',
  'REMOVAL_DUE',
  'REMOVING',
  'COMPLETED',
  'CANCELLED',
  'ON_HOLD',
] as const;
export type LocationStatus = (typeof LOCATION_STATUSES)[number];

/** Before the location goes live: these can still be cancelled. */
export const PRE_LIVE_STATUSES = [
  'DRAFT',
  'RESEARCH',
  'AWAITING_APPROVAL',
  'APPROVED',
  'IN_PRODUCTION',
  'READY_FOR_INSTALLATION',
  'INSTALLING',
] as const satisfies readonly LocationStatus[];
export const TERMINAL_LOCATION_STATUSES = [
  'COMPLETED',
  'CANCELLED',
] as const satisfies readonly LocationStatus[];

export const LOCATION_ACTIONS = ['start-research', 'hold', 'resume', 'cancel'] as const;
export type LocationAction = (typeof LOCATION_ACTIONS)[number];

export const LOCATION_TRANSITIONS: TransitionTable<LocationStatus, LocationAction> = {
  // Guard (API and DB): the store pin is CONFIRMED (04-user-flows.md A7).
  'start-research': {
    action: 'start-research',
    from: ['DRAFT'],
    to: 'RESEARCH',
    permission: 'campaign_location.manage',
  },
  hold: {
    action: 'hold',
    from: LOCATION_STATUSES.filter((s) => s !== 'ON_HOLD' && s !== 'COMPLETED' && s !== 'CANCELLED'),
    to: 'ON_HOLD',
    permission: 'campaign_location.manage',
  },
  resume: {
    action: 'resume',
    from: ['ON_HOLD'],
    to: PREVIOUS_STATUS,
    permission: 'campaign_location.manage',
  },
  // An ON_HOLD location is cancellable when the status it will resume to is pre-LIVE (checked by the API).
  cancel: {
    action: 'cancel',
    from: [...PRE_LIVE_STATUSES, 'ON_HOLD'],
    to: 'CANCELLED',
    permission: 'campaign_location.manage',
  },
};

/** Whether a location can be cancelled (a held one by the status it would resume to). */
export function locationCancellable(status: LocationStatus, previousStatus: LocationStatus | null): boolean {
  const effective = status === 'ON_HOLD' ? previousStatus : status;
  return effective !== null && (PRE_LIVE_STATUSES as readonly LocationStatus[]).includes(effective);
}

/** Store pin geocoding (04-user-flows.md A6–A7). CONFIRMED = a person placed or accepted the pin. */
export const GEOCODE_STATUSES = ['PENDING', 'RESOLVED', 'AMBIGUOUS', 'FAILED', 'CONFIRMED'] as const;
export type GeocodeStatus = (typeof GEOCODE_STATUSES)[number];
