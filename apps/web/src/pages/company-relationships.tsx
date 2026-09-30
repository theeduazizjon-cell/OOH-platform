import {
  ORGANISATION_RELATIONSHIP_KINDS,
  type OrganisationRelationshipItem,
  type OrganisationRelationshipKind,
} from '@ooh/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/card';
import { Label } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api';
import { hasPermission, useMe } from '@/lib/me';
import { CompanyPicker, type PickedCompany } from './company-picker';

/** "This company is … <other>" when adding, from this company's point of view. */
const OUTGOING_PHRASE: Record<OrganisationRelationshipKind, string> = {
  AGENCY_OF: 'the agency of',
  SUPPLIER_TO: 'a supplier to',
  PARENT_OF: 'the parent company of',
};

/** A relationship as read on this company's page. */
export function relationshipLabel(item: OrganisationRelationshipItem): string {
  const other = item.other.displayName;
  if (item.direction === 'OUTGOING') {
    return {
      AGENCY_OF: `Agency of ${other}`,
      SUPPLIER_TO: `Supplier to ${other}`,
      PARENT_OF: `Parent of ${other}`,
    }[item.kind];
  }
  return {
    AGENCY_OF: `${other} is its agency`,
    SUPPLIER_TO: `${other} supplies it`,
    PARENT_OF: `${other} is its parent company`,
  }[item.kind];
}

/** Relationships section of a company: agency ↔ client, supplier, parent. */
export function CompanyRelationships({
  organisationId,
  archived,
}: {
  organisationId: string;
  archived: boolean;
}) {
  const { data: me } = useMe();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<OrganisationRelationshipKind>('AGENCY_OF');
  const [other, setOther] = useState<PickedCompany | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canEdit = hasPermission(me, 'organisation.update') && !archived;
  const key = ['relationships', organisationId];

  const list = useQuery({
    queryKey: key,
    queryFn: () =>
      api.request<OrganisationRelationshipItem[]>(`/organisations/${organisationId}/relationships`),
  });

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      await queryClient.invalidateQueries({ queryKey: key });
      return true;
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not reach the server. Try again.');
      return false;
    }
  }

  async function add() {
    if (!other) {
      setError('Choose the other company.');
      return;
    }
    const ok = await run(() =>
      api.request(`/organisations/${organisationId}/relationships`, {
        method: 'POST',
        json: { kind, toOrganisationId: other.id },
      }),
    );
    if (ok) {
      setAdding(false);
      setOther(null);
    }
  }

  return (
    <section className="mt-6 space-y-3 border-t border-slate-200 pt-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">Relationships</h3>
        {canEdit && !adding && (
          <Button variant="secondary" className="h-8" onClick={() => setAdding(true)}>
            Add relationship
          </Button>
        )}
      </div>
      {error && <Alert>{error}</Alert>}
      {adding && (
        <div className="space-y-3 rounded-md border border-slate-200 p-3">
          <div className="space-y-1.5">
            <Label htmlFor="relationship-kind">This company is…</Label>
            <select
              id="relationship-kind"
              className="h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
              value={kind}
              onChange={(e) => setKind(e.currentTarget.value as OrganisationRelationshipKind)}
            >
              {ORGANISATION_RELATIONSHIP_KINDS.map((k) => (
                <option key={k} value={k}>
                  {OUTGOING_PHRASE[k]}
                </option>
              ))}
            </select>
          </div>
          <CompanyPicker
            id="relationship-other"
            label="Other company"
            value={other}
            onChange={setOther}
            excludeId={organisationId}
          />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button onClick={() => void add()}>Add</Button>
          </div>
        </div>
      )}
      {list.data && list.data.length === 0 && <p className="text-sm text-slate-500">No relationships yet.</p>}
      {list.data && list.data.length > 0 && (
        <ul className="space-y-1 text-sm">
          {list.data.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3">
              <span>
                {relationshipLabel(r)}
                {r.other.archived && <span className="text-xs text-slate-500"> (archived)</span>}
              </span>
              {/* Removable from the company it starts from (the API's rule). */}
              {canEdit && r.direction === 'OUTGOING' && (
                <Button
                  variant="ghost"
                  className="h-7 px-2 text-red-700"
                  aria-label={`Remove: ${relationshipLabel(r)}`}
                  onClick={() =>
                    void run(() =>
                      api.request(`/organisations/${organisationId}/relationships/${r.id}`, {
                        method: 'DELETE',
                      }),
                    )
                  }
                >
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
