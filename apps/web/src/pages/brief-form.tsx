import { BRIEF_CURRENCIES, type BriefDetail } from '@ooh/contracts';
import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { ApiError } from '@/lib/api';
import { CompanyPicker, type PickedCompany } from './company-picker';
import { parseAmount } from './opportunity-form';

export interface BriefFormValues {
  title: string;
  clientOrganisationId: string | null;
  agencyOrganisationId: string | null;
  requestedStart: string | null;
  requestedEnd: string | null;
  datesTbd: boolean;
  deadline: string | null;
  budget: string | null;
  currency: (typeof BRIEF_CURRENCIES)[number];
  specialRequirements: string | null;
}

/** The brief's details: who it is for, when, budget and requirements. */
export function BriefForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: BriefDetail;
  submitLabel: string;
  onSubmit: (values: BriefFormValues) => Promise<void>;
  onCancel?: () => void;
}) {
  const [client, setClient] = useState<PickedCompany | null>(initial?.client ?? null);
  const [agency, setAgency] = useState<PickedCompany | null>(initial?.agency ?? null);
  const [datesTbd, setDatesTbd] = useState(initial?.datesTbd ?? false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const text = (name: string) => {
      const value = data.get(name);
      return typeof value === 'string' ? value.trim() : '';
    };
    const budget = parseAmount(text('budget'));
    const start = datesTbd ? '' : text('requestedStart');
    const end = datesTbd ? '' : text('requestedEnd');
    if (!text('title')) return setError('Give the brief a title.');
    if (budget === undefined) return setError('Enter the budget as a number, e.g. 120000 (net of VAT).');
    if (start && end && end < start) return setError('The end date is before the start date.');
    if (client && agency && client.id === agency.id)
      return setError('The agency and the client are different companies.');
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        title: text('title'),
        clientOrganisationId: client?.id ?? null,
        agencyOrganisationId: agency?.id ?? null,
        requestedStart: start || null,
        requestedEnd: end || null,
        datesTbd,
        deadline: text('deadline') || null,
        budget,
        currency: (text('currency') || 'RON') as BriefFormValues['currency'],
        specialRequirements: text('specialRequirements') || null,
      });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not reach the server. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={(e) => void submit(e)} noValidate>
      {error && <Alert>{error}</Alert>}
      <div className="space-y-1.5">
        <Label htmlFor="brief-title">Title</Label>
        <Input id="brief-title" name="title" maxLength={200} defaultValue={initial?.title ?? ''} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <CompanyPicker id="brief-client" label="Client" value={client} onChange={setClient} />
        <CompanyPicker
          id="brief-agency"
          label="Agency (optional)"
          value={agency}
          onChange={setAgency}
          {...(client ? { excludeId: client.id } : {})}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="brief-start">Campaign start</Label>
          <Input
            id="brief-start"
            name="requestedStart"
            type="date"
            disabled={datesTbd}
            defaultValue={initial?.requestedStart ?? ''}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="brief-end">Campaign end</Label>
          <Input
            id="brief-end"
            name="requestedEnd"
            type="date"
            disabled={datesTbd}
            defaultValue={initial?.requestedEnd ?? ''}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="brief-deadline">Reply needed by</Label>
          <Input id="brief-deadline" name="deadline" type="date" defaultValue={initial?.deadline ?? ''} />
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input type="checkbox" checked={datesTbd} onChange={(e) => setDatesTbd(e.currentTarget.checked)} />
        Dates not known yet
      </label>
      <div className="grid grid-cols-[1fr_auto] gap-2 sm:max-w-sm">
        <div className="space-y-1.5">
          <Label htmlFor="brief-budget">Budget (net of VAT)</Label>
          <Input id="brief-budget" name="budget" inputMode="decimal" defaultValue={initial?.budget ?? ''} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="brief-currency">Currency</Label>
          <select
            id="brief-currency"
            name="currency"
            defaultValue={initial?.currency ?? 'RON'}
            className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm"
          >
            {BRIEF_CURRENCIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="brief-requirements">Special requirements</Label>
        <textarea
          id="brief-requirements"
          name="specialRequirements"
          rows={3}
          maxLength={5000}
          defaultValue={initial?.specialRequirements ?? ''}
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
      </div>
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button variant="secondary" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : submitLabel}
        </Button>
      </div>
    </form>
  );
}
