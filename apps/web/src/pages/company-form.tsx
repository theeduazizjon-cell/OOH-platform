import type {
  ClassificationItem,
  CreateOrganisationRequest,
  DuplicateMatch,
  OrganisationDetail,
} from '@ooh/contracts';
import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { ApiError } from '@/lib/api';

/** Company fields as the form submits them (the API normalises VAT and country). */
export type CompanyFormValues = Omit<
  CreateOrganisationRequest,
  'force' | 'forceReason' | 'accountOwnerMembershipId'
>;

interface DuplicateState {
  matches: DuplicateMatch[];
  canForce: boolean;
  values: CompanyFormValues;
}

const FIELDS: { name: keyof CompanyFormValues; label: string; maxLength: number; wide?: boolean }[] = [
  { name: 'displayName', label: 'Name', maxLength: 200 },
  { name: 'legalName', label: 'Legal name', maxLength: 200 },
  { name: 'vatNumber', label: 'VAT number (CUI)', maxLength: 30 },
  { name: 'industry', label: 'Industry', maxLength: 100 },
  { name: 'address', label: 'Address', maxLength: 300, wide: true },
  { name: 'city', label: 'City', maxLength: 100 },
  { name: 'county', label: 'County', maxLength: 100 },
  { name: 'country', label: 'Country (2 letters)', maxLength: 2 },
  { name: 'website', label: 'Website', maxLength: 300 },
];

function readValues(form: HTMLFormElement): CompanyFormValues {
  const data = new FormData(form);
  const text = (name: string) => {
    const value = data.get(name);
    return typeof value === 'string' ? value.trim() : '';
  };
  return {
    displayName: text('displayName'),
    legalName: text('legalName') || null,
    vatNumber: text('vatNumber') || null,
    industry: text('industry') || null,
    address: text('address') || null,
    city: text('city') || null,
    county: text('county') || null,
    country: text('country').toUpperCase() || 'RO',
    website: text('website') || null,
    notes: text('notes') || null,
    classificationIds: data.getAll('classificationIds').filter((v): v is string => typeof v === 'string'),
  };
}

/**
 * Create or edit a company. On create, a suspected duplicate (409 DUPLICATE_SUSPECTED) shows the
 * matching companies; a similar name can be overridden with a reason, an identical VAT number can't.
 */
export function CompanyForm({
  initial,
  classifications,
  submitLabel,
  onSubmit,
  onCancel,
  onOpenExisting,
}: {
  initial?: OrganisationDetail;
  classifications: readonly ClassificationItem[];
  submitLabel: string;
  onSubmit: (values: CompanyFormValues, override?: { forceReason: string }) => Promise<void>;
  onCancel: () => void;
  /** Lets the user jump to a matching company instead of creating a duplicate. */
  onOpenExisting?: (id: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<DuplicateState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const selected = new Set(initial?.classifications.map((c) => c.id));
  // Disabled classifications stay visible where a company already has them.
  const offered = classifications.filter((c) => c.active || selected.has(c.id));

  async function submit(values: CompanyFormValues, override?: { forceReason: string }) {
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(values, override);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'DUPLICATE_SUSPECTED') {
        const meta = caught.problem?.meta as { matches: DuplicateMatch[]; canForce: boolean } | undefined;
        setDuplicate({ matches: meta?.matches ?? [], canForce: meta?.canForce ?? false, values });
      } else {
        setError(caught instanceof ApiError ? caught.message : 'Could not reach the server. Try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = readValues(event.currentTarget);
    if (!values.displayName) {
      setError('Enter the company name.');
      return;
    }
    setDuplicate(null);
    void submit(values);
  }

  function handleOverride(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const reason = new FormData(event.currentTarget).get('forceReason');
    const forceReason = typeof reason === 'string' ? reason.trim() : '';
    if (forceReason.length < 5) {
      setError('Explain in a few words why this is a different company.');
      return;
    }
    if (duplicate) void submit(duplicate.values, { forceReason });
  }

  return (
    <div className="space-y-4">
      {error && <Alert>{error}</Alert>}
      <form className="space-y-4" onSubmit={handleSubmit} noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          {FIELDS.map((field) => (
            <div key={field.name} className={field.wide ? 'space-y-1.5 sm:col-span-2' : 'space-y-1.5'}>
              <Label htmlFor={`company-${field.name}`}>{field.label}</Label>
              <Input
                id={`company-${field.name}`}
                name={field.name}
                maxLength={field.maxLength}
                defaultValue={
                  (initial?.[field.name as keyof OrganisationDetail] as string | null | undefined) ??
                  (field.name === 'country' ? 'RO' : '')
                }
                required={field.name === 'displayName'}
              />
            </div>
          ))}
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="company-notes">Notes</Label>
            <textarea
              id="company-notes"
              name="notes"
              maxLength={5000}
              rows={3}
              defaultValue={initial?.notes ?? ''}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-xs"
            />
          </div>
        </div>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-slate-700">Classifications</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {offered.map((c) => (
              <label key={c.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="classificationIds"
                  value={c.id}
                  defaultChecked={selected.has(c.id)}
                  className="size-4 accent-brand-600"
                />
                {c.name}
              </label>
            ))}
          </div>
        </fieldset>
        {!duplicate && (
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onCancel} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Saving…' : submitLabel}
            </Button>
          </div>
        )}
      </form>

      {duplicate && (
        <div role="alert" className="space-y-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
          <p className="font-medium text-amber-900">
            {duplicate.canForce
              ? 'This company may already exist:'
              : 'A company with this VAT number already exists:'}
          </p>
          <ul className="space-y-1">
            {duplicate.matches.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-3">
                <span>
                  <strong>{m.displayName}</strong>
                  {m.vatNumber && <span className="text-slate-600"> · {m.vatNumber}</span>}
                  {m.city && <span className="text-slate-600"> · {m.city}</span>}
                  <span className="text-xs text-slate-500">
                    {' '}
                    ({m.reason === 'VAT' ? 'same VAT number' : 'similar name'})
                  </span>
                </span>
                {onOpenExisting && (
                  <Button variant="secondary" className="h-8" onClick={() => onOpenExisting(m.id)}>
                    Open
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {duplicate.canForce ? (
            <form className="space-y-2" onSubmit={handleOverride} noValidate>
              <Label htmlFor="company-forceReason">It is a different company because…</Label>
              <Input id="company-forceReason" name="forceReason" maxLength={500} />
              <div className="flex justify-end gap-2">
                <Button variant="secondary" onClick={() => setDuplicate(null)} disabled={submitting}>
                  Back to the form
                </Button>
                <Button type="submit" disabled={submitting}>
                  Create anyway
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex justify-end">
              <Button variant="secondary" onClick={() => setDuplicate(null)}>
                Back to the form
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
