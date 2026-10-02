import type { LocationItem } from '@ooh/contracts';
import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { ApiError } from '@/lib/api';

export interface LocationFormValues {
  name: string;
  address: string | null;
  city: string | null;
  county: string | null;
  startDate: string | null;
  endDate: string | null;
  requestedUnits: number | null;
  researchRadiusM: number | null;
}

/** "" → null, a whole number in range → number, anything else → undefined (invalid). */
export function parseWhole(input: string, min: number, max: number): number | null | undefined {
  const text = input.trim();
  if (!text) return null;
  if (!/^\d+$/.test(text)) return undefined;
  const value = Number(text);
  return value >= min && value <= max ? value : undefined;
}

/** A campaign location's store and dates (new or existing). */
export function LocationForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: LocationItem;
  submitLabel: string;
  onSubmit: (values: LocationFormValues) => Promise<void>;
  onCancel: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const prefix = initial?.id ?? 'new-location';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const text = (name: string) => {
      const value = data.get(name);
      return typeof value === 'string' ? value.trim() : '';
    };
    const units = parseWhole(text('requestedUnits'), 1, 10000);
    const radius = parseWhole(text('researchRadiusM'), 50, 50000);
    if (!text('name')) return setError('Give the store a name.');
    if (units === undefined) return setError('Units is a whole number, at least 1.');
    if (radius === undefined) return setError('The research radius is between 50 and 50 000 metres.');
    if (text('startDate') && text('endDate') && text('endDate') < text('startDate'))
      return setError('The end date is before the start date.');
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        name: text('name'),
        address: text('address') || null,
        city: text('city') || null,
        county: text('county') || null,
        startDate: text('startDate') || null,
        endDate: text('endDate') || null,
        requestedUnits: units,
        researchRadiusM: radius,
      });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not reach the server. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  const field = (
    name: keyof LocationFormValues,
    label: string,
    value: string | number | null,
    type = 'text',
  ) => (
    <div className="space-y-1.5">
      <Label htmlFor={`${prefix}-${name}`}>{label}</Label>
      <Input
        id={`${prefix}-${name}`}
        name={name}
        type={type}
        inputMode={type === 'number' ? 'numeric' : undefined}
        defaultValue={value ?? ''}
      />
    </div>
  );

  return (
    <form className="space-y-3" onSubmit={(e) => void submit(e)} noValidate>
      {error && <Alert>{error}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {field('name', 'Store', initial?.name ?? null)}
        {field('address', 'Address', initial?.address ?? null)}
        {field('city', 'City', initial?.city ?? null)}
        {field('county', 'County', initial?.county ?? null)}
        {field('startDate', 'Start', initial?.startDate ?? null, 'date')}
        {field('endDate', 'End', initial?.endDate ?? null, 'date')}
        {field('requestedUnits', 'Units', initial?.requestedUnits ?? null, 'number')}
        {field('researchRadiusM', 'Research radius (m)', initial?.researchRadiusM ?? null, 'number')}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : submitLabel}
        </Button>
      </div>
    </form>
  );
}
