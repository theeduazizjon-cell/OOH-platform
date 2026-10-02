import type { BriefDetail, CampaignListItem, Page } from '@ooh/contracts';
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { api } from '@/lib/api';
import { hasPermission, useMe } from '@/lib/me';

/** The convert body: a new campaign (name) or an existing one of the same client (OPD-07b). */
export function convertBody(
  target: 'new' | 'existing',
  name: string,
  campaignId: string,
): { body: { campaignName?: string; campaignId?: string } } | { error: string } {
  if (target === 'existing') return campaignId ? { body: { campaignId } } : { error: 'Choose the campaign.' };
  return name.trim() ? { body: { campaignName: name.trim() } } : { error: 'Give the campaign a name.' };
}

/** "Create campaign" for a confirmed brief: one location per store, in a new or an open campaign. */
export function ConvertForm({
  brief,
  clientId,
  onConvert,
  onCancel,
}: {
  brief: BriefDetail;
  clientId: string;
  onConvert: (body: { campaignName?: string; campaignId?: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const { data: me } = useMe();
  const [target, setTarget] = useState<'new' | 'existing'>('new');
  const [error, setError] = useState<string | null>(null);
  const existing = useQuery({
    queryKey: ['campaigns', 'client', clientId],
    queryFn: () =>
      api.request<Page<CampaignListItem>>(`/campaigns?clientOrganisationId=${clientId}&limit=100`),
    enabled: hasPermission(me, 'campaign.read'),
  });
  const open = (existing.data?.data ?? []).filter((c) => c.status === 'ACTIVE' || c.status === 'ON_HOLD');

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const text = (name: string) => {
      const value = data.get(name);
      return typeof value === 'string' ? value : '';
    };
    const result = convertBody(target, text('campaignName'), text('campaignId'));
    if ('error' in result) return setError(result.error);
    setError(null);
    void onConvert(result.body);
  }

  return (
    <form
      aria-label="Create campaign"
      className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3"
      onSubmit={submit}
      noValidate
    >
      <h3 className="text-sm font-semibold">Create campaign</h3>
      <p className="text-sm text-slate-600">
        Each of the {brief.lines.length} stores becomes a location in draft, ready for research.
      </p>
      {error && <Alert>{error}</Alert>}
      <label className="flex items-center gap-2 text-sm">
        <input type="radio" name="target" checked={target === 'new'} onChange={() => setTarget('new')} />A new
        campaign
      </label>
      {target === 'new' && (
        <div className="space-y-1.5 pl-6">
          <Label htmlFor="convert-name">Campaign name</Label>
          <Input id="convert-name" name="campaignName" maxLength={200} defaultValue={brief.title} />
        </div>
      )}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="radio"
          name="target"
          checked={target === 'existing'}
          disabled={open.length === 0}
          onChange={() => setTarget('existing')}
        />
        Add to a running campaign of {brief.client?.displayName}
        {open.length === 0 && <span className="text-slate-500">(none)</span>}
      </label>
      {target === 'existing' && (
        <div className="space-y-1.5 pl-6">
          <Label htmlFor="convert-campaign">Campaign</Label>
          <select
            id="convert-campaign"
            name="campaignId"
            className="h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
            defaultValue=""
          >
            <option value="">Choose…</option>
            {open.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} · {c.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Back
        </Button>
        <Button type="submit">Create campaign</Button>
      </div>
    </form>
  );
}
