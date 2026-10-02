import {
  type ContactListItem,
  OPPORTUNITY_CURRENCIES,
  type OpportunityDetail,
  type UpdateOpportunityRequest,
} from '@ooh/contracts';
import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { ApiError } from '@/lib/api';

export type OpportunityFormValues = Required<
  Pick<
    UpdateOpportunityRequest,
    | 'name'
    | 'contactId'
    | 'estimatedValue'
    | 'currency'
    | 'expectedCloseDate'
    | 'probability'
    | 'source'
    | 'nextAction'
    | 'nextFollowUpDate'
  >
>;

/** "12 500,50" or "12500.5" → "12500.50"; null when empty; undefined when not an amount. */
export function parseAmount(input: string): string | null | undefined {
  const compact = input.replace(/\s/g, '').replace(',', '.');
  if (!compact) return null;
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(compact)) return undefined;
  return Number(compact).toFixed(2);
}

/** Opportunity details (the stage changes through the actions, not this form). */
export function OpportunityForm({
  initial,
  contacts,
  readOnly = false,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: OpportunityDetail;
  contacts: readonly ContactListItem[];
  readOnly?: boolean;
  submitLabel: string;
  onSubmit: (values: OpportunityFormValues) => Promise<void>;
  onCancel: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const text = (name: string) => {
      const value = data.get(name);
      return typeof value === 'string' ? value.trim() : '';
    };
    const estimatedValue = parseAmount(text('estimatedValue'));
    const probability = text('probability') ? Number(text('probability')) : null;
    if (!text('name')) {
      setError('Give the opportunity a name.');
      return;
    }
    if (estimatedValue === undefined) {
      setError('Enter the value as a number, e.g. 12500 or 12500.50 (net of VAT).');
      return;
    }
    if (probability !== null && !(Number.isInteger(probability) && probability >= 0 && probability <= 100)) {
      setError('Probability is a whole percentage between 0 and 100.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        name: text('name'),
        contactId: text('contactId') || null,
        estimatedValue,
        currency: (text('currency') || 'RON') as OpportunityFormValues['currency'],
        expectedCloseDate: text('expectedCloseDate') || null,
        probability,
        source: text('source') || null,
        nextAction: text('nextAction') || null,
        nextFollowUpDate: text('nextFollowUpDate') || null,
      });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not reach the server. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  const field = (id: string, label: string, input: React.ReactNode, wide = false) => (
    <div className={wide ? 'space-y-1.5 sm:col-span-2' : 'space-y-1.5'}>
      <Label htmlFor={id}>{label}</Label>
      {input}
    </div>
  );
  const select = 'h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm';

  return (
    <form className="space-y-4" onSubmit={(event) => void handleSubmit(event)} noValidate>
      {error && <Alert>{error}</Alert>}
      <fieldset disabled={readOnly} className="grid gap-4 sm:grid-cols-2">
        {field(
          'opportunity-name',
          'Name',
          <Input id="opportunity-name" name="name" maxLength={200} defaultValue={initial?.name ?? ''} />,
          true,
        )}
        {field(
          'opportunity-contact',
          'Contact',
          <select
            id="opportunity-contact"
            name="contactId"
            defaultValue={initial?.contact?.id ?? ''}
            className={select}
          >
            <option value="">No contact</option>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.firstName} {c.lastName}
              </option>
            ))}
          </select>,
        )}
        {field(
          'opportunity-source',
          'Source',
          <Input
            id="opportunity-source"
            name="source"
            maxLength={200}
            defaultValue={initial?.source ?? ''}
          />,
        )}
        <div className="grid grid-cols-[1fr_auto] gap-2">
          {field(
            'opportunity-value',
            'Estimated value (net of VAT)',
            <Input
              id="opportunity-value"
              name="estimatedValue"
              inputMode="decimal"
              defaultValue={initial?.estimatedValue ?? ''}
            />,
          )}
          {field(
            'opportunity-currency',
            'Currency',
            <select
              id="opportunity-currency"
              name="currency"
              defaultValue={initial?.currency ?? 'RON'}
              className={select}
            >
              {OPPORTUNITY_CURRENCIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>,
          )}
        </div>
        {field(
          'opportunity-close',
          'Expected close date',
          <Input
            id="opportunity-close"
            name="expectedCloseDate"
            type="date"
            defaultValue={initial?.expectedCloseDate ?? ''}
          />,
        )}
        {field(
          'opportunity-probability',
          'Probability (%)',
          <Input
            id="opportunity-probability"
            name="probability"
            type="number"
            min={0}
            max={100}
            defaultValue={initial?.probability ?? ''}
          />,
        )}
        {field(
          'opportunity-followup',
          'Next follow-up',
          <Input
            id="opportunity-followup"
            name="nextFollowUpDate"
            type="date"
            defaultValue={initial?.nextFollowUpDate ?? ''}
          />,
        )}
        {field(
          'opportunity-next',
          'Next action',
          <Input
            id="opportunity-next"
            name="nextAction"
            maxLength={500}
            defaultValue={initial?.nextAction ?? ''}
          />,
          true,
        )}
      </fieldset>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={submitting}>
          {readOnly ? 'Close' : 'Cancel'}
        </Button>
        {!readOnly && (
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Saving…' : submitLabel}
          </Button>
        )}
      </div>
    </form>
  );
}
