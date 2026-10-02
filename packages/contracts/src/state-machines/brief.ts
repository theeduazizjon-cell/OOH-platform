import type { TransitionTable } from './index';

/** Brief (06-state-machines.md §3). */
export const BRIEF_STATUSES = ['DRAFT', 'CONFIRMED', 'CONVERTED', 'DISCARDED'] as const;
export type BriefStatus = (typeof BRIEF_STATUSES)[number];
export const BRIEF_ACTIONS = ['confirm', 'reopen', 'convert', 'discard'] as const;
export type BriefAction = (typeof BRIEF_ACTIONS)[number];

export const BRIEF_TRANSITIONS: TransitionTable<BriefStatus, BriefAction> = {
  confirm: { action: 'confirm', from: ['DRAFT'], to: 'CONFIRMED', permission: 'brief.confirm' },
  reopen: { action: 'reopen', from: ['CONFIRMED'], to: 'DRAFT', permission: 'brief.confirm' },
  convert: { action: 'convert', from: ['CONFIRMED'], to: 'CONVERTED', permission: 'brief.convert' },
  discard: { action: 'discard', from: ['DRAFT', 'CONFIRMED'], to: 'DISCARDED', permission: 'brief.discard' },
};
