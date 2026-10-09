import {
  CAMPAIGN_TRANSITIONS,
  type CampaignAction,
  type CampaignDetail,
  etagOf,
  IF_MATCH_HEADER,
  LOCATION_TRANSITIONS,
  type LocationAction,
  type LocationItem,
} from '@ooh/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert, Card } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api';
import { hasPermission, useMe } from '@/lib/me';
import {
  CampaignStatusBadge,
  formatDates,
  LocationStatusBadge,
  LOCATION_STATUS_LABELS,
  progressSummary,
} from './campaign-status';
import { LocationForm, type LocationFormValues } from './location-form';
import { PinEditor, PinStatus } from './location-pin';
import { TaskList } from './task-list';

export const CAMPAIGN_CONFLICT_MESSAGE =
  'Someone else changed this in the meantime. The campaign has been reloaded; check it and try again.';

const CAMPAIGN_LABELS: Record<CampaignAction, string> = {
  hold: 'Put on hold',
  resume: 'Resume',
  cancel: 'Cancel campaign',
};
const PAST: Record<LocationAction, string> = {
  'start-research': 'research started',
  hold: 'on hold',
  resume: 'resumed',
  cancel: 'cancelled',
};
const LOCATION_LABELS: Record<LocationAction, string> = {
  'start-research': 'Start research',
  hold: 'Hold',
  resume: 'Resume',
  cancel: 'Cancel',
};

/** Which actions need a reason before they run (06-state-machines.md §4–§5). */
export function reasonRequired(
  kind: 'campaign' | 'location',
  action: LocationAction, // a superset of the campaign actions
): boolean {
  return action === 'cancel' || (kind === 'location' && action === 'hold');
}

const NEW_LOCATION = 'new';

type Pending =
  | { kind: 'campaign'; action: CampaignAction }
  | { kind: 'location'; action: LocationAction; location: LocationItem }
  | null;

/** A campaign (09-screen-map.md): its locations and their statuses, with the umbrella actions. */
export function CampaignPage({ campaignId }: { campaignId: string }) {
  const { data: me } = useMe();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<Pending>(null);
  const [editing, setEditing] = useState<string | null>(null); // a location id, or NEW_LOCATION;
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canManage = hasPermission(me, 'campaign_location.manage');

  const opened = useQuery({
    queryKey: ['campaign', campaignId],
    queryFn: () => api.request<CampaignDetail>(`/campaigns/${campaignId}`),
  });
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['campaigns'] });
    await queryClient.invalidateQueries({ queryKey: ['campaign', campaignId] });
    // Pins and status changes complete or create tasks.
    await queryClient.invalidateQueries({ queryKey: ['tasks'] });
  };

  /** Changes send If-Match; on 412 the campaign reloads and the error explains why. */
  async function send(path: string, method: 'POST' | 'PATCH' | 'PUT', json: unknown, version?: number) {
    try {
      await api.request(path, {
        method,
        json,
        ...(version === undefined ? {} : { headers: { [IF_MATCH_HEADER]: etagOf(version) } }),
      });
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'PRECONDITION_FAILED') {
        await refresh();
        throw new ApiError(caught.status, { ...caught.problem!, detail: CAMPAIGN_CONFLICT_MESSAGE });
      }
      throw caught;
    } finally {
      await refresh();
    }
  }

  async function run(action: () => Promise<void>, done: string) {
    setError(null);
    setNotice(null);
    try {
      await action();
      setPending(null);
      setEditing(null);
      setNotice(done);
    } catch (caught) {
      const live = caught instanceof ApiError ? caught.problem?.meta?.locations : undefined;
      setError(
        Array.isArray(live)
          ? `${caught instanceof ApiError ? caught.message : ''} Live: ${live.map((l: { name: string }) => l.name).join(', ')}.`
          : caught instanceof ApiError
            ? caught.message
            : 'Could not reach the server. Try again.',
      );
    }
  }

  function start(next: NonNullable<Pending>) {
    const c = opened.data!;
    if (reasonRequired(next.kind, next.action)) return setPending(next);
    if (next.kind === 'campaign') {
      void run(
        () => send(`/campaigns/${c.id}/actions/${next.action}`, 'POST', {}, c.version),
        `${c.name}: ${PAST[next.action]}.`,
      );
    } else {
      void run(
        () =>
          send(`/locations/${next.location.id}/actions/${next.action}`, 'POST', {}, next.location.version),
        `${next.location.name}: ${PAST[next.action]}.`,
      );
    }
  }

  const back = (
    <Link to="/app/campaigns" className="text-sm text-brand-700 hover:underline">
      ← Campaigns
    </Link>
  );
  if (opened.isLoading) return <p className="text-sm text-slate-500">Loading…</p>;
  if (!opened.data) {
    return (
      <div className="max-w-6xl space-y-3">
        {back}
        <Alert>{opened.error?.message ?? 'Campaign not found.'}</Alert>
      </div>
    );
  }
  const c = opened.data;
  const open = c.status === 'ACTIVE' || c.status === 'ON_HOLD';
  const campaignActions = c.actions.filter((a) => hasPermission(me, CAMPAIGN_TRANSITIONS[a].permission));

  return (
    <div className="max-w-6xl space-y-4">
      {back}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold">
            {c.name} <CampaignStatusBadge status={c.status} />
          </h1>
          <p className="text-sm text-slate-600">
            {[
              c.code,
              c.client.displayName,
              c.agency && `via ${c.agency.displayName}`,
              `Owner: ${c.owner.displayName}`,
              formatDates(c.startDate, c.endDate),
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
          <p className="text-sm text-slate-600">{progressSummary(c.locations)}</p>
          {c.holdReason && <p className="text-sm text-amber-800">On hold: {c.holdReason}</p>}
          {c.cancelReason && <p className="text-sm text-slate-600">Cancelled: {c.cancelReason}</p>}
        </div>
        <span className="flex flex-wrap gap-2">
          {campaignActions.map((a) => (
            <Button
              key={a}
              variant={a === 'cancel' ? 'ghost' : 'secondary'}
              className={a === 'cancel' ? 'text-red-700' : ''}
              onClick={() => start({ kind: 'campaign', action: a })}
            >
              {CAMPAIGN_LABELS[a]}
            </Button>
          ))}
        </span>
      </div>

      {notice && (
        <p role="status" className="text-sm text-slate-600">
          {notice}
        </p>
      )}
      {error && <Alert>{error}</Alert>}
      {pending && (
        <ReasonForm
          title={
            pending.kind === 'campaign'
              ? `${CAMPAIGN_LABELS[pending.action]}: ${c.name}`
              : `${LOCATION_LABELS[pending.action]}: ${pending.location.name}`
          }
          hint={
            pending.kind === 'campaign' && pending.action === 'cancel'
              ? 'Every open location is cancelled with it.'
              : undefined
          }
          onCancel={() => setPending(null)}
          onConfirm={(reason) =>
            run(
              () =>
                pending.kind === 'campaign'
                  ? send(`/campaigns/${c.id}/actions/${pending.action}`, 'POST', { reason }, c.version)
                  : send(
                      `/locations/${pending.location.id}/actions/${pending.action}`,
                      'POST',
                      { reason },
                      pending.location.version,
                    ),
              pending.kind === 'campaign'
                ? `${c.name}: ${PAST[pending.action]}.`
                : `${pending.location.name}: ${PAST[pending.action]}.`,
            )
          }
        />
      )}
      {c.notes && <Card className="p-3 text-sm whitespace-pre-line text-slate-700">{c.notes}</Card>}

      <Card className="p-4">
        <TaskList
          title="Tasks"
          filter={{ campaignId: c.id }}
          canAdd={false}
          showSubject={false}
          emptyText="No open tasks."
        />
      </Card>

      <Card className="p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold">Locations ({c.locationItems.length})</h2>
          {canManage && open && editing !== NEW_LOCATION && (
            <Button variant="secondary" className="h-8" onClick={() => setEditing(NEW_LOCATION)}>
              Add location
            </Button>
          )}
        </div>
        {editing === NEW_LOCATION && (
          <div className="mb-3 rounded-md border border-slate-200 p-3">
            <LocationForm
              submitLabel="Add location"
              onCancel={() => setEditing(null)}
              onSubmit={(values: LocationFormValues) =>
                run(() => send(`/campaigns/${c.id}/locations`, 'POST', values), `${values.name} added.`)
              }
            />
          </div>
        )}
        {c.locationItems.length === 0 ? (
          <p className="text-sm text-slate-500">No locations yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-2 py-2">Store</th>
                  <th className="px-2 py-2">Dates</th>
                  <th className="px-2 py-2">Units</th>
                  <th className="px-2 py-2">Buyer</th>
                  <th className="px-2 py-2">Status</th>
                  <th className="px-2 py-2">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {c.locationItems.map((l) =>
                  editing === `pin:${l.id}` ? (
                    <tr key={l.id}>
                      <td colSpan={6} className="bg-slate-50 px-2 py-3">
                        <PinEditor
                          location={l}
                          onCancel={() => setEditing(null)}
                          onSave={(pin) =>
                            run(
                              () => send(`/locations/${l.id}/store-point`, 'PUT', pin, l.version),
                              `${l.name}: pin confirmed.`,
                            )
                          }
                        />
                      </td>
                    </tr>
                  ) : editing === l.id ? (
                    <tr key={l.id}>
                      <td colSpan={6} className="px-2 py-3">
                        <LocationForm
                          initial={l}
                          submitLabel="Save location"
                          onCancel={() => setEditing(null)}
                          onSubmit={(values) =>
                            run(
                              () => send(`/locations/${l.id}`, 'PATCH', values, l.version),
                              `${values.name} saved.`,
                            )
                          }
                        />
                      </td>
                    </tr>
                  ) : (
                    <tr key={l.id} className="border-b border-slate-100 align-top last:border-0">
                      <td className="px-2 py-2">
                        <span className="font-medium">{l.name}</span>
                        <span className="block text-xs text-slate-500">
                          {[l.address, l.city, l.county].filter(Boolean).join(', ')}
                        </span>
                        {l.holdReason && (
                          <span className="block text-xs text-amber-800">On hold: {l.holdReason}</span>
                        )}
                        {l.cancelReason && (
                          <span className="block text-xs text-slate-500">{l.cancelReason}</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2">{formatDates(l.startDate, l.endDate)}</td>
                      <td className="px-2 py-2">{l.requestedUnits}</td>
                      <td className="px-2 py-2">{l.buyer?.displayName}</td>
                      <td className="px-2 py-2">
                        <LocationStatusBadge status={l.status} />
                        <PinStatus location={l} />
                        {l.previousStatus && (
                          <span className="block text-xs text-slate-500">
                            resumes to {LOCATION_STATUS_LABELS[l.previousStatus].toLowerCase()}
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1">
                        {canManage && (
                          <span className="flex flex-wrap justify-end gap-1">
                            {l.actions
                              .filter((a) => hasPermission(me, LOCATION_TRANSITIONS[a].permission))
                              .map((a) => (
                                <Button
                                  key={a}
                                  variant="ghost"
                                  className={a === 'cancel' ? 'h-7 px-2 text-red-700' : 'h-7 px-2'}
                                  aria-label={`${LOCATION_LABELS[a]}: ${l.name}`}
                                  onClick={() => start({ kind: 'location', action: a, location: l })}
                                >
                                  {LOCATION_LABELS[a]}
                                </Button>
                              ))}
                            {l.status !== 'CANCELLED' && l.status !== 'COMPLETED' && (
                              <Button
                                variant={l.geocodeStatus === 'CONFIRMED' ? 'ghost' : 'secondary'}
                                className="h-7 px-2"
                                aria-label={`Pin: ${l.name}`}
                                onClick={() => setEditing(`pin:${l.id}`)}
                              >
                                Pin
                              </Button>
                            )}
                            {l.status !== 'CANCELLED' && l.status !== 'COMPLETED' && (
                              <Button
                                variant="ghost"
                                className="h-7 px-2"
                                aria-label={`Edit: ${l.name}`}
                                onClick={() => setEditing(l.id)}
                              >
                                Edit
                              </Button>
                            )}
                          </span>
                        )}
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

export function ReasonForm({
  title,
  hint,
  onConfirm,
  onCancel,
}: {
  title: string;
  hint?: string | undefined;
  onConfirm: (reason: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get('reason');
    const reason = typeof value === 'string' ? value.trim() : '';
    if (reason.length < 3) return setError('Give a short reason (at least 3 characters).');
    setError(null);
    void onConfirm(reason);
  }
  return (
    <form
      aria-label={title}
      className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3"
      onSubmit={submit}
      noValidate
    >
      <h3 className="text-sm font-semibold">{title}</h3>
      {hint && <p className="text-sm text-slate-600">{hint}</p>}
      {error && <Alert>{error}</Alert>}
      <div className="space-y-1.5">
        <Label htmlFor="action-reason">Reason</Label>
        <Input id="action-reason" name="reason" maxLength={500} />
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Back
        </Button>
        <Button type="submit">Confirm</Button>
      </div>
    </form>
  );
}
