import type { CampaignListItem, CampaignStatus, LocationStatus } from '@ooh/contracts';
import { cn } from '@/lib/cn';

export const CAMPAIGN_STATUS_LABELS: Record<CampaignStatus, string> = {
  ACTIVE: 'Active',
  ON_HOLD: 'On hold',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

export const LOCATION_STATUS_LABELS: Record<LocationStatus, string> = {
  DRAFT: 'Draft',
  RESEARCH: 'Research',
  AWAITING_APPROVAL: 'Awaiting approval',
  APPROVED: 'Approved',
  IN_PRODUCTION: 'In production',
  READY_FOR_INSTALLATION: 'Ready to install',
  INSTALLING: 'Installing',
  LIVE: 'Live',
  REMOVAL_DUE: 'Removal due',
  REMOVING: 'Removing',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  ON_HOLD: 'On hold',
};

const TONES: Record<string, string> = {
  neutral: 'bg-slate-100 text-slate-700',
  progress: 'bg-brand-50 text-brand-700',
  live: 'bg-emerald-50 text-emerald-800',
  warn: 'bg-amber-50 text-amber-800',
  done: 'bg-slate-100 text-slate-500',
};
const LOCATION_TONE: Record<LocationStatus, keyof typeof TONES> = {
  DRAFT: 'neutral',
  RESEARCH: 'progress',
  AWAITING_APPROVAL: 'progress',
  APPROVED: 'progress',
  IN_PRODUCTION: 'progress',
  READY_FOR_INSTALLATION: 'progress',
  INSTALLING: 'progress',
  LIVE: 'live',
  REMOVAL_DUE: 'warn',
  REMOVING: 'warn',
  COMPLETED: 'done',
  CANCELLED: 'done',
  ON_HOLD: 'warn',
};
const CAMPAIGN_TONE: Record<CampaignStatus, keyof typeof TONES> = {
  ACTIVE: 'progress',
  ON_HOLD: 'warn',
  COMPLETED: 'done',
  CANCELLED: 'done',
};

export function CampaignStatusBadge({ status }: { status: CampaignStatus }) {
  return <Badge tone={CAMPAIGN_TONE[status]}>{CAMPAIGN_STATUS_LABELS[status]}</Badge>;
}

export function LocationStatusBadge({ status }: { status: LocationStatus }) {
  return <Badge tone={LOCATION_TONE[status]}>{LOCATION_STATUS_LABELS[status]}</Badge>;
}

function Badge({ tone, children }: { tone: keyof typeof TONES; children: string }) {
  return (
    <span className={cn('whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium', TONES[tone])}>
      {children}
    </span>
  );
}

/**
 * The campaign's progress in one line, e.g. "2 live · 3 in progress · 1 draft of 7" (the UI's
 * computed campaign status, 06-state-machines.md §4). Cancelled locations don't count.
 */
export function progressSummary(locations: CampaignListItem['locations']): string {
  const by = locations.byStatus;
  const n = (s: LocationStatus) => by[s] ?? 0;
  const cancelled = n('CANCELLED');
  const total = locations.total - cancelled;
  if (total === 0) return cancelled > 0 ? 'All locations cancelled' : 'No locations yet';
  const live = n('LIVE');
  const draft = n('DRAFT');
  const held = n('ON_HOLD');
  const done = n('COMPLETED');
  const inProgress = total - live - draft - held - done;
  return [
    live && `${live} live`,
    inProgress && `${inProgress} in progress`,
    draft && `${draft} draft`,
    held && `${held} on hold`,
    done && `${done} completed`,
  ]
    .filter(Boolean)
    .join(' · ')
    .concat(` of ${total}`);
}

export function formatDates(start: string | null, end: string | null): string {
  if (!start && !end) return '';
  return `${start ?? '…'} → ${end ?? '…'}`;
}
