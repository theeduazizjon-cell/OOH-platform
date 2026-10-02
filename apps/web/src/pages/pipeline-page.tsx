import type { OpportunityListItem, Page, PipelineItem } from '@ooh/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { hasPermission, useMe } from '@/lib/me';
import { CrmTabs } from './crm-tabs';
import { OpportunityPanel, type OpportunityTarget } from './opportunity-panel';
import { formatMoney, groupByStage, openStages, totalsByCurrency } from './pipeline';

/** CRM → Pipeline (docs/architecture/09-screen-map.md): open opportunities per stage, plus outcomes. */
export function PipelinePage() {
  const { session } = useAuth();
  const { data: me } = useMe();
  const [pipelineId, setPipelineId] = useState('');
  const [mine, setMine] = useState(false);
  const [target, setTarget] = useState<OpportunityTarget | null>(null);

  const pipelines = useQuery({
    queryKey: ['pipelines', session?.tenantId],
    queryFn: () => api.request<PipelineItem[]>('/config/pipelines'),
    enabled: hasPermission(me, 'config.read'),
  });
  const active = (pipelines.data ?? []).filter((p) => p.active);
  const pipeline = active.find((p) => p.id === pipelineId) ?? active.find((p) => p.isDefault) ?? active[0];
  const ownerId = mine ? me?.membership.id : undefined;

  const list = (status: 'OPEN' | 'WON' | 'LOST', limit: number) => ({
    queryKey: ['opportunities', pipeline?.id, status, ownerId],
    queryFn: () => {
      const params = new URLSearchParams({ pipelineId: pipeline!.id, status, limit: String(limit) });
      if (ownerId) params.set('ownerMembershipId', ownerId);
      return api.request<Page<OpportunityListItem>>(`/opportunities?${params.toString()}`);
    },
    enabled: Boolean(pipeline),
  });
  const open = useQuery(list('OPEN', 100));
  const won = useQuery(list('WON', 20));
  const lost = useQuery(list('LOST', 20));

  const stages = openStages(pipeline);
  const columns = groupByStage(stages, open.data?.data ?? []);

  return (
    <div className="max-w-7xl space-y-4">
      <CrmTabs />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Pipeline</h1>
        <div className="flex flex-wrap items-center gap-3">
          {active.length > 1 && (
            <select
              aria-label="Pipeline"
              className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm"
              value={pipeline?.id ?? ''}
              onChange={(e) => setPipelineId(e.currentTarget.value)}
            >
              {active.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={mine} onChange={(e) => setMine(e.currentTarget.checked)} />
            Only mine
          </label>
          {hasPermission(me, 'opportunity.create') && target?.kind !== 'new' && (
            <Button
              onClick={() => setTarget({ kind: 'new', ...(pipeline ? { pipelineId: pipeline.id } : {}) })}
            >
              New opportunity
            </Button>
          )}
        </div>
      </div>

      {target && (
        <OpportunityPanel key={JSON.stringify(target)} target={target} onClose={() => setTarget(null)} />
      )}

      {pipelines.error && <p className="text-sm text-red-700">{pipelines.error.message}</p>}
      {open.error && <p className="text-sm text-red-700">{open.error.message}</p>}
      {(pipelines.isLoading || open.isLoading) && <p className="text-sm text-slate-500">Loading…</p>}
      {pipelines.data && !pipeline && (
        <p className="text-sm text-slate-500">No active pipeline is configured.</p>
      )}

      {open.data && (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {stages.map((stage) => {
            const cards = columns.get(stage.id) ?? [];
            return (
              <section
                key={stage.id}
                aria-label={stage.name}
                className="w-64 shrink-0 space-y-2 rounded-md bg-slate-100 p-2"
              >
                <header className="px-1">
                  <h2 className="text-sm font-semibold">
                    {stage.name} <span className="font-normal text-slate-500">({cards.length})</span>
                  </h2>
                  <p className="text-xs text-slate-500">{totalsByCurrency(cards)}</p>
                </header>
                {cards.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    className="block w-full rounded-md border border-slate-200 bg-white p-2 text-left text-sm shadow-sm hover:border-brand-600"
                    onClick={() => setTarget({ kind: 'open', id: o.id })}
                  >
                    <span className="block font-medium">{o.name}</span>
                    <span className="block text-xs text-slate-500">{o.organisation.displayName}</span>
                    <span className="block text-xs text-slate-500">
                      {[formatMoney(o.estimatedValue, o.currency), o.expectedCloseDate, o.owner.displayName]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </button>
                ))}
              </section>
            );
          })}
        </div>
      )}
      {open.data?.page.nextCursor && (
        <p className="text-xs text-slate-500">Showing the first 100 open opportunities.</p>
      )}

      {pipeline && (
        <div className="grid gap-3 md:grid-cols-2">
          {[
            { label: 'Recently won', query: won },
            { label: 'Recently lost', query: lost },
          ].map(({ label, query }) => (
            <Card key={label} className="p-3">
              <h2 className="mb-2 text-sm font-semibold">{label}</h2>
              {query.data?.data.length === 0 && <p className="text-sm text-slate-500">None.</p>}
              <ul className="space-y-1 text-sm">
                {query.data?.data.map((o) => (
                  <li key={o.id}>
                    <button
                      type="button"
                      className="text-brand-700 hover:underline"
                      onClick={() => setTarget({ kind: 'open', id: o.id })}
                    >
                      {o.name}
                    </button>
                    <span className="text-xs text-slate-500">
                      {' '}
                      · {o.organisation.displayName}
                      {o.estimatedValue && ` · ${formatMoney(o.estimatedValue, o.currency)}`}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
