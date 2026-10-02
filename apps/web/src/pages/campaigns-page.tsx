import type { CampaignDetail, CampaignListItem, CampaignStatus, Page } from '@ooh/contracts';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { type FormEvent, useDeferredValue, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert, Card } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { hasPermission, useMe } from '@/lib/me';
import { CampaignStatusBadge, formatDates, progressSummary } from './campaign-status';
import { CompanyPicker, type PickedCompany } from './company-picker';

type View = CampaignStatus | 'all';
const VIEWS: { key: View; label: string }[] = [
  { key: 'ACTIVE', label: 'Active' },
  { key: 'ON_HOLD', label: 'On hold' },
  { key: 'all', label: 'All' },
];

/** Campaigns (docs/architecture/09-screen-map.md): list with status, search and progress. */
export function CampaignsPage() {
  const { session } = useAuth();
  const { data: me } = useMe();
  const navigate = useNavigate();
  const [view, setView] = useState<View>('ACTIVE');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const q = useDeferredValue(search.trim());

  const campaigns = useInfiniteQuery({
    queryKey: ['campaigns', session?.tenantId, view, q],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '50' });
      if (view !== 'all') params.set('status', view);
      if (q) params.set('q', q);
      if (pageParam) params.set('cursor', pageParam);
      return api.request<Page<CampaignListItem>>(`/campaigns?${params.toString()}`);
    },
    getNextPageParam: (last) => last.page.nextCursor,
  });
  const rows = campaigns.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <div className="max-w-6xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Campaigns</h1>
        {hasPermission(me, 'campaign.create') && !creating && (
          <Button onClick={() => setCreating(true)}>New campaign</Button>
        )}
      </div>
      {creating && (
        <NewCampaignForm
          onCancel={() => setCreating(false)}
          onCreated={(id) => void navigate({ to: '/app/campaigns/$campaignId', params: { campaignId: id } })}
        />
      )}

      <div className="flex flex-wrap items-center gap-3">
        <div role="tablist" aria-label="Campaign status" className="flex gap-1 rounded-md bg-slate-100 p-1">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              type="button"
              role="tab"
              aria-selected={view === v.key}
              className={cn(
                'rounded px-3 py-1 text-sm',
                view === v.key ? 'bg-white font-medium shadow-sm' : 'text-slate-600',
              )}
              onClick={() => setView(v.key)}
            >
              {v.label}
            </button>
          ))}
        </div>
        <Input
          aria-label="Search campaigns"
          placeholder="Search by name or code"
          className="max-w-xs"
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
        />
      </div>

      {campaigns.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {campaigns.error && <p className="text-sm text-red-700">{campaigns.error.message}</p>}
      {campaigns.data && (
        <CampaignsTable rows={rows} emptyText={q ? 'No campaign matches.' : 'No campaigns.'} />
      )}
      {campaigns.hasNextPage && (
        <Button
          variant="secondary"
          disabled={campaigns.isFetchingNextPage}
          onClick={() => void campaigns.fetchNextPage()}
        >
          {campaigns.isFetchingNextPage ? 'Loading…' : 'Show more'}
        </Button>
      )}
    </div>
  );
}

export function CampaignsTable({
  rows,
  emptyText,
  showClient = true,
}: {
  rows: readonly CampaignListItem[];
  emptyText: string;
  showClient?: boolean;
}) {
  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500">
          <tr>
            <th className="px-4 py-2">Campaign</th>
            {showClient && <th className="px-4 py-2">Client</th>}
            <th className="px-4 py-2">Dates</th>
            <th className="px-4 py-2">Locations</th>
            <th className="px-4 py-2">Owner</th>
            <th className="px-4 py-2">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={showClient ? 6 : 5} className="px-4 py-6 text-center text-slate-500">
                {emptyText}
              </td>
            </tr>
          )}
          {rows.map((c) => (
            <tr key={c.id} className="border-b border-slate-100 last:border-0">
              <td className="px-4 py-2">
                <Link
                  to="/app/campaigns/$campaignId"
                  params={{ campaignId: c.id }}
                  className="font-medium text-brand-700 hover:underline"
                >
                  {c.name}
                </Link>
                <span className="block text-xs text-slate-500">{c.code}</span>
              </td>
              {showClient && (
                <td className="px-4 py-2">
                  {c.client.displayName}
                  {c.agency && (
                    <span className="block text-xs text-slate-500">via {c.agency.displayName}</span>
                  )}
                </td>
              )}
              <td className="whitespace-nowrap px-4 py-2">{formatDates(c.startDate, c.endDate)}</td>
              <td className="px-4 py-2">{progressSummary(c.locations)}</td>
              <td className="px-4 py-2">{c.owner.displayName}</td>
              <td className="px-4 py-2">
                <CampaignStatusBadge status={c.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function NewCampaignForm({ onCreated, onCancel }: { onCreated: (id: string) => void; onCancel: () => void }) {
  const [client, setClient] = useState<PickedCompany | null>(null);
  const [agency, setAgency] = useState<PickedCompany | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get('name');
    const name = typeof value === 'string' ? value.trim() : '';
    if (!name) return setError('Give the campaign a name.');
    if (!client) return setError('Choose the client.');
    setError(null);
    try {
      const created = await api.request<CampaignDetail>('/campaigns', {
        method: 'POST',
        json: { name, clientOrganisationId: client.id, agencyOrganisationId: agency?.id ?? null },
      });
      onCreated(created.id);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not reach the server. Try again.');
    }
  }

  return (
    <Card className="p-4">
      <h2 className="mb-3 text-base font-semibold">New campaign</h2>
      <form className="space-y-4" onSubmit={(e) => void submit(e)} noValidate>
        {error && <Alert>{error}</Alert>}
        <div className="space-y-1.5">
          <Label htmlFor="campaign-name">Name</Label>
          <Input id="campaign-name" name="name" maxLength={200} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <CompanyPicker id="campaign-client" label="Client" value={client} onChange={setClient} />
          <CompanyPicker
            id="campaign-agency"
            label="Agency (optional)"
            value={agency}
            onChange={setAgency}
            {...(client ? { excludeId: client.id } : {})}
          />
        </div>
        <p className="text-xs text-slate-500">
          Most campaigns start from a confirmed brief (Requests → Create campaign).
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit">Create campaign</Button>
        </div>
      </form>
    </Card>
  );
}
