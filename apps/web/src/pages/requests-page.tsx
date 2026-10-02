import type { BriefDetail, BriefListItem, BriefStatus, Page } from '@ooh/contracts';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useDeferredValue, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { hasPermission, useMe } from '@/lib/me';
import { BriefForm } from './brief-form';

export const BRIEF_STATUS_LABELS: Record<BriefStatus, string> = {
  DRAFT: 'Draft',
  CONFIRMED: 'Confirmed',
  CONVERTED: 'Converted',
  DISCARDED: 'Discarded',
};
const STATUS_STYLES: Record<BriefStatus, string> = {
  DRAFT: 'bg-amber-50 text-amber-800',
  CONFIRMED: 'bg-brand-50 text-brand-700',
  CONVERTED: 'bg-emerald-50 text-emerald-800',
  DISCARDED: 'bg-slate-100 text-slate-500',
};

export function BriefStatusBadge({ status }: { status: BriefStatus }) {
  return (
    <span className={cn('rounded px-1.5 py-0.5 text-xs font-medium', STATUS_STYLES[status])}>
      {BRIEF_STATUS_LABELS[status]}
    </span>
  );
}

type View = 'DRAFT' | 'CONFIRMED' | 'all';
const VIEWS: { key: View; label: string }[] = [
  { key: 'DRAFT', label: 'To review' },
  { key: 'CONFIRMED', label: 'Confirmed' },
  { key: 'all', label: 'All' },
];

/** Requests inbox (docs/architecture/09-screen-map.md): draft briefs to review, confirmed ones, all. */
export function RequestsPage() {
  const { session } = useAuth();
  const { data: me } = useMe();
  const navigate = useNavigate();
  const [view, setView] = useState<View>('DRAFT');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const q = useDeferredValue(search.trim());

  const briefs = useInfiniteQuery({
    queryKey: ['briefs', session?.tenantId, view, q],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '50' });
      if (view !== 'all') params.set('status', view);
      if (q) params.set('q', q);
      if (pageParam) params.set('cursor', pageParam);
      return api.request<Page<BriefListItem>>(`/briefs?${params.toString()}`);
    },
    getNextPageParam: (last) => last.page.nextCursor,
  });
  const rows = briefs.data?.pages.flatMap((p) => p.data) ?? [];
  const dates = (b: BriefListItem) =>
    b.requestedStart || b.requestedEnd ? `${b.requestedStart ?? '…'} → ${b.requestedEnd ?? '…'}` : '';

  return (
    <div className="max-w-6xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Requests</h1>
        {hasPermission(me, 'brief.create') && !creating && (
          <Button onClick={() => setCreating(true)}>New brief</Button>
        )}
      </div>

      {creating && (
        <Card className="p-4">
          <h2 className="mb-3 text-base font-semibold">New brief</h2>
          <BriefForm
            submitLabel="Create brief"
            onSubmit={async (values) => {
              const created = await api.request<BriefDetail>('/briefs', { method: 'POST', json: values });
              await navigate({ to: '/app/requests/$briefId', params: { briefId: created.id } });
            }}
            onCancel={() => setCreating(false)}
          />
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <div role="tablist" aria-label="Requests" className="flex gap-1 rounded-md bg-slate-100 p-1">
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
          aria-label="Search briefs"
          placeholder="Search by title"
          className="max-w-xs"
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
        />
      </div>

      {briefs.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {briefs.error && <p className="text-sm text-red-700">{briefs.error.message}</p>}
      {briefs.data && (
        <Card className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-2">Brief</th>
                <th className="px-4 py-2">Client</th>
                <th className="px-4 py-2">Stores</th>
                <th className="px-4 py-2">Dates</th>
                <th className="px-4 py-2">Owner</th>
                <th className="px-4 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-slate-500">
                    {view === 'DRAFT' ? 'Nothing to review.' : 'No briefs.'}
                  </td>
                </tr>
              )}
              {rows.map((b) => (
                <tr key={b.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-2">
                    <Link
                      to="/app/requests/$briefId"
                      params={{ briefId: b.id }}
                      className="font-medium text-brand-700 hover:underline"
                    >
                      {b.title}
                    </Link>
                    {b.opportunity && (
                      <span className="block text-xs text-slate-500">
                        From opportunity {b.opportunity.name}
                      </span>
                    )}
                    {b.aiGenerated && <span className="ml-2 text-xs text-violet-700">AI draft</span>}
                  </td>
                  <td className="px-4 py-2">
                    {b.client?.displayName}
                    {b.agency && (
                      <span className="block text-xs text-slate-500">via {b.agency.displayName}</span>
                    )}
                  </td>
                  <td className="px-4 py-2">{b.lineCount}</td>
                  <td className="whitespace-nowrap px-4 py-2">{dates(b)}</td>
                  <td className="px-4 py-2">{b.owner.displayName}</td>
                  <td className="px-4 py-2">
                    <BriefStatusBadge status={b.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {briefs.hasNextPage && (
        <Button
          variant="secondary"
          disabled={briefs.isFetchingNextPage}
          onClick={() => void briefs.fetchNextPage()}
        >
          {briefs.isFetchingNextPage ? 'Loading…' : 'Show more'}
        </Button>
      )}
    </div>
  );
}
