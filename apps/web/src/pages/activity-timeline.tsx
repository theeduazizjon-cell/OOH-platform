import type { ActivityItem, ActivityTypeItem, ContactListItem, Page } from '@ooh/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { hasPermission, useMe } from '@/lib/me';

export function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Activity types people can log (system types are written by the platform). */
export function loggableTypes(types: readonly ActivityTypeItem[]): ActivityTypeItem[] {
  return types.filter((t) => t.active && !t.isSystem);
}

/**
 * The timeline of a company, or of one opportunity: newest first, with "Log activity" for people
 * holding activity.create. Platform entries (stage changes) are shown but never editable.
 */
export function ActivityTimeline({
  organisationId,
  opportunityId,
  archived = false,
}: {
  organisationId: string;
  opportunityId?: string;
  archived?: boolean;
}) {
  const { session } = useAuth();
  const { data: me } = useMe();
  const queryClient = useQueryClient();
  const [logging, setLogging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canRead = hasPermission(me, 'activity.read');
  const canLog = hasPermission(me, 'activity.create') && !archived;
  const filter = opportunityId ? `opportunityId=${opportunityId}` : `organisationId=${organisationId}`;
  const key = ['activities', filter];

  const entries = useQuery({
    queryKey: key,
    queryFn: () => api.request<Page<ActivityItem>>(`/activities?${filter}&limit=50`),
    enabled: canRead,
  });
  const types = useQuery({
    queryKey: ['activity-types', session?.tenantId],
    queryFn: () => api.request<ActivityTypeItem[]>('/config/activity-types'),
    enabled: logging,
  });
  const contacts = useQuery({
    queryKey: ['contacts', 'organisation', organisationId],
    queryFn: () => api.request<Page<ContactListItem>>(`/contacts?organisationId=${organisationId}&limit=100`),
    enabled: logging && hasPermission(me, 'contact.read'),
  });
  if (!canRead) return null;

  async function log(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const text = (name: string) => {
      const value = data.get(name);
      return typeof value === 'string' ? value.trim() : '';
    };
    if (!text('subject')) {
      setError('Add a short subject.');
      return;
    }
    setError(null);
    try {
      await api.request<ActivityItem>('/activities', {
        method: 'POST',
        json: {
          organisationId,
          ...(opportunityId ? { opportunityId } : {}),
          ...(text('contactId') ? { contactId: text('contactId') } : {}),
          activityTypeId: text('activityTypeId'),
          subject: text('subject'),
          ...(text('body') ? { body: text('body') } : {}),
          ...(text('occurredAt') ? { occurredAt: new Date(text('occurredAt')).toISOString() } : {}),
        },
      });
      setLogging(false);
      await queryClient.invalidateQueries({ queryKey: ['activities'] });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not reach the server. Try again.');
    }
  }

  return (
    <section className="mt-6 space-y-3 border-t border-slate-200 pt-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">Timeline</h3>
        {canLog && !logging && (
          <Button variant="secondary" className="h-8" onClick={() => setLogging(true)}>
            Log activity
          </Button>
        )}
      </div>
      {logging && (
        <form
          className="space-y-3 rounded-md border border-slate-200 p-3"
          onSubmit={(e) => void log(e)}
          noValidate
        >
          {error && <Alert>{error}</Alert>}
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="activity-type">Type</Label>
              <select
                id="activity-type"
                name="activityTypeId"
                className="h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
              >
                {loggableTypes(types.data ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="activity-contact">With</Label>
              <select
                id="activity-contact"
                name="contactId"
                className="h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
              >
                <option value="">Nobody in particular</option>
                {(contacts.data?.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.firstName} {c.lastName}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="activity-when">When (default: now)</Label>
              <Input id="activity-when" name="occurredAt" type="datetime-local" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="activity-subject">Subject</Label>
            <Input id="activity-subject" name="subject" maxLength={200} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="activity-body">Notes</Label>
            <textarea
              id="activity-body"
              name="body"
              rows={3}
              maxLength={10000}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setLogging(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!types.data}>
              Log
            </Button>
          </div>
        </form>
      )}
      {entries.error && <p className="text-sm text-red-700">{entries.error.message}</p>}
      {entries.data && entries.data.data.length === 0 && (
        <p className="text-sm text-slate-500">Nothing logged yet.</p>
      )}
      {entries.data && entries.data.data.length > 0 && (
        <ol className="space-y-3">
          {entries.data.data.map((a) => (
            <li key={a.id} className="border-l-2 border-slate-200 pl-3 text-sm">
              <p className="text-xs text-slate-500">
                {formatWhen(a.occurredAt)} · {a.type.name}
                {a.author ? ` · ${a.author.displayName}` : ''}
                {a.contact ? ` · with ${a.contact.name}` : ''}
                {!opportunityId && a.opportunity ? ` · ${a.opportunity.name}` : ''}
              </p>
              <p className={a.type.isSystem ? 'text-slate-600' : 'font-medium text-slate-800'}>{a.subject}</p>
              {a.body && <p className="whitespace-pre-line text-slate-600">{a.body}</p>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
