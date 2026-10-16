import {
  ASSET_LIFECYCLES,
  type AssetDetail,
  type AssetLifecycle,
  type AssetListItem,
  type Page,
} from '@ooh/contracts';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useDeferredValue, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert, Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { hasPermission, useMe } from '@/lib/me';
import { AssetForm, type AssetFormValues } from './asset-form';
import {
  addressLine,
  LifecycleBadge,
  LIFECYCLE_LABELS,
  structureSummary,
  useAssetTypes,
  VERIFICATION_LABELS,
} from './asset-status';

const ALL = 'all';

/** POST /assets body from the form (the reason only when a nearby duplicate was confirmed). */
export function createAssetBody(values: AssetFormValues, duplicateReason: string | null) {
  return { ...values, ...(duplicateReason ? { duplicateOverride: { reason: duplicateReason } } : {}) };
}

/** Inventory (09-screen-map.md): one list with type tabs, lifecycle filter and search. */
export function InventoryPage() {
  const { session } = useAuth();
  const { data: me } = useMe();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const types = useAssetTypes();
  const [typeId, setTypeId] = useState<string>(ALL);
  const [lifecycle, setLifecycle] = useState<AssetLifecycle | typeof ALL>(ALL);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const q = useDeferredValue(search.trim());

  const assets = useInfiniteQuery({
    queryKey: ['assets', session?.tenantId, typeId, lifecycle, q],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '50' });
      if (typeId !== ALL) params.set('assetTypeId', typeId);
      if (lifecycle !== ALL) params.set('lifecycle', lifecycle);
      if (q) params.set('q', q);
      if (pageParam) params.set('cursor', pageParam);
      return api.request<Page<AssetListItem>>(`/assets?${params.toString()}`);
    },
    getNextPageParam: (last) => last.page.nextCursor,
  });
  const rows = assets.data?.pages.flatMap((p) => p.data) ?? [];
  const tabs = [{ id: ALL, name: 'All' }, ...(types.data ?? []).filter((t) => t.active)];

  async function create(values: AssetFormValues, duplicateReason: string | null) {
    const created = await api.request<AssetDetail>('/assets', {
      method: 'POST',
      json: createAssetBody(values, duplicateReason),
    });
    await queryClient.invalidateQueries({ queryKey: ['assets'] });
    void navigate({ to: '/app/inventory/$assetId', params: { assetId: created.id } });
  }

  return (
    <div className="max-w-6xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Inventory</h1>
        {hasPermission(me, 'asset.create') && !creating && types.data && (
          <Button onClick={() => setCreating(true)}>New asset</Button>
        )}
      </div>
      {creating && types.data && (
        <Card className="p-4">
          <h2 className="mb-3 text-base font-semibold">New asset</h2>
          <AssetForm
            types={types.data}
            submitLabel="Create asset"
            onSubmit={create}
            onCancel={() => setCreating(false)}
          />
        </Card>
      )}
      {types.error && <Alert>{types.error.message}</Alert>}

      <div
        role="tablist"
        aria-label="Asset type"
        className="flex flex-wrap gap-1 rounded-md bg-slate-100 p-1"
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={typeId === t.id}
            className={cn(
              'rounded px-3 py-1 text-sm',
              typeId === t.id ? 'bg-white font-medium shadow-sm' : 'text-slate-600',
            )}
            onClick={() => setTypeId(t.id)}
          >
            {t.name}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <select
          aria-label="Lifecycle"
          value={lifecycle}
          onChange={(e) => setLifecycle(e.currentTarget.value as AssetLifecycle | typeof ALL)}
          className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm"
        >
          <option value={ALL}>Any status</option>
          {ASSET_LIFECYCLES.map((l) => (
            <option key={l} value={l}>
              {LIFECYCLE_LABELS[l]}
            </option>
          ))}
        </select>
        <Input
          aria-label="Search assets"
          placeholder="Search by code or address"
          className="max-w-xs"
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
        />
      </div>

      {assets.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {assets.error && <p className="text-sm text-red-700">{assets.error.message}</p>}
      {assets.data && (
        <AssetsTable
          rows={rows}
          emptyText={q || lifecycle !== ALL ? 'No asset matches.' : 'No assets yet.'}
        />
      )}
      {assets.hasNextPage && (
        <Button
          variant="secondary"
          disabled={assets.isFetchingNextPage}
          onClick={() => void assets.fetchNextPage()}
        >
          {assets.isFetchingNextPage ? 'Loading…' : 'Show more'}
        </Button>
      )}
    </div>
  );
}

export function AssetsTable({ rows, emptyText }: { rows: readonly AssetListItem[]; emptyText: string }) {
  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500">
          <tr>
            <th className="px-4 py-2">Asset</th>
            <th className="px-4 py-2">Address</th>
            <th className="px-4 py-2">Structure</th>
            <th className="px-4 py-2">Verification</th>
            <th className="px-4 py-2">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={5} className="px-4 py-6 text-center text-slate-500">
                {emptyText}
              </td>
            </tr>
          )}
          {rows.map((a) => (
            <tr key={a.id} className="border-b border-slate-100 last:border-0">
              <td className="px-4 py-2">
                <Link
                  to="/app/inventory/$assetId"
                  params={{ assetId: a.id }}
                  className="font-medium text-brand-700 hover:underline"
                >
                  {a.code}
                </Link>
                <span className="block text-xs text-slate-500">{a.type.name}</span>
              </td>
              <td className="px-4 py-2">
                {addressLine(a) || (
                  <span className="text-slate-500">
                    {a.location.lat.toFixed(5)}, {a.location.lng.toFixed(5)}
                  </span>
                )}
              </td>
              <td className="whitespace-nowrap px-4 py-2">{structureSummary(a)}</td>
              <td className="px-4 py-2">{VERIFICATION_LABELS[a.verificationStatus]}</td>
              <td className="px-4 py-2">
                <LifecycleBadge lifecycle={a.lifecycle} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
