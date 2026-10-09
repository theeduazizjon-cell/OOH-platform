import type { TransitionTable } from './index';

/**
 * OOH asset lifecycle (06-state-machines.md §6). Verification is a separate dimension, recorded by
 * people with photo evidence (arrives with files, M4b).
 */
export const ASSET_LIFECYCLE_ACTIONS = ['activate', 'suspend', 'reinstate', 'decommission'] as const;
export type AssetLifecycleAction = (typeof ASSET_LIFECYCLE_ACTIONS)[number];
type Lifecycle = 'PROSPECTIVE' | 'ACTIVE' | 'SUSPENDED' | 'DECOMMISSIONED';

export const ASSET_TRANSITIONS: TransitionTable<Lifecycle, AssetLifecycleAction> = {
  // Guard: terms covering today (owner or supplier known); "≥1 photo" joins with files (M4b).
  activate: {
    action: 'activate',
    from: ['PROSPECTIVE'],
    to: 'ACTIVE',
    permission: 'asset.availability.manage',
  },
  suspend: { action: 'suspend', from: ['ACTIVE'], to: 'SUSPENDED', permission: 'asset.availability.manage' },
  reinstate: {
    action: 'reinstate',
    from: ['SUSPENDED'],
    to: 'ACTIVE',
    permission: 'asset.availability.manage',
  },
  // Guard: no future confirmed bookings (bookings arrive with studies, M6–M7).
  decommission: {
    action: 'decommission',
    from: ['PROSPECTIVE', 'ACTIVE', 'SUSPENDED'],
    to: 'DECOMMISSIONED',
    permission: 'asset.archive',
  },
};
