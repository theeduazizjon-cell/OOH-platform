import type { OpportunityListItem, Page } from '@ooh/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { hasPermission, useMe } from '@/lib/me';
import { OpportunityPanel, type OpportunityTarget } from './opportunity-panel';
import { formatMoney } from './pipeline';

/** The Opportunities section of a company (open first, then closed). */
export function CompanyOpportunities({
  organisation,
  archived,
}: {
  organisation: { id: string; displayName: string };
  archived: boolean;
}) {
  const { data: me } = useMe();
  const [target, setTarget] = useState<OpportunityTarget | null>(null);
  const canRead = hasPermission(me, 'opportunity.read');
  const opportunities = useQuery({
    queryKey: ['opportunities', 'organisation', organisation.id],
    queryFn: () =>
      api.request<Page<OpportunityListItem>>(`/opportunities?organisationId=${organisation.id}&limit=100`),
    enabled: canRead,
  });
  if (!canRead) return null;
  const rows = [...(opportunities.data?.data ?? [])].sort(
    (a, b) => Number(a.stage.kind !== 'OPEN') - Number(b.stage.kind !== 'OPEN'),
  );

  return (
    <section className="mt-6 space-y-3 border-t border-slate-200 pt-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">Opportunities</h3>
        {hasPermission(me, 'opportunity.create') && !archived && target?.kind !== 'new' && (
          <Button
            variant="secondary"
            className="h-8"
            onClick={() => setTarget({ kind: 'new', organisation: { ...organisation } })}
          >
            New opportunity
          </Button>
        )}
      </div>
      {target && (
        <OpportunityPanel key={JSON.stringify(target)} target={target} onClose={() => setTarget(null)} />
      )}
      {opportunities.error && <p className="text-sm text-red-700">{opportunities.error.message}</p>}
      {opportunities.data && rows.length === 0 && (
        <p className="text-sm text-slate-500">No opportunities yet.</p>
      )}
      {rows.length > 0 && (
        <ul className="divide-y divide-slate-100 rounded-md border border-slate-200 text-sm">
          {rows.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <button
                type="button"
                className="font-medium text-brand-700 hover:underline"
                onClick={() => setTarget({ kind: 'open', id: o.id })}
              >
                {o.name}
              </button>
              <span className="text-xs text-slate-500">
                {[o.stage.name, formatMoney(o.estimatedValue, o.currency), o.owner.displayName]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
