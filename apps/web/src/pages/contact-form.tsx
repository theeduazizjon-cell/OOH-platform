import {
  CONTACT_CONSENT_STATUSES,
  type ContactConsentStatus,
  type ContactDetail,
  type CreateContactRequest,
} from '@ooh/contracts';
import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { ApiError } from '@/lib/api';

export type ContactFormValues = Omit<CreateContactRequest, 'organisationId' | 'consentAt'>;

const CONSENT_LABELS: Record<ContactConsentStatus, string> = {
  UNKNOWN: 'Not stated',
  OPTED_IN: 'Agreed to marketing',
  OPTED_OUT: 'Refused marketing',
};

const TEXT_FIELDS: {
  name: 'firstName' | 'lastName' | 'position' | 'email' | 'phone' | 'linkedin';
  label: string;
  type?: string;
  maxLength: number;
}[] = [
  { name: 'firstName', label: 'First name', maxLength: 100 },
  { name: 'lastName', label: 'Last name', maxLength: 100 },
  { name: 'position', label: 'Position', maxLength: 150 },
  { name: 'email', label: 'Email', type: 'email', maxLength: 254 },
  { name: 'phone', label: 'Phone', type: 'tel', maxLength: 50 },
  { name: 'linkedin', label: 'LinkedIn', maxLength: 300 },
];

export function parseTags(value: string): string[] {
  return [
    ...new Set(
      value
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  ];
}

/** Contact details and marketing consent (GDPR: a stated preference needs its source). */
export function ContactForm({
  initial,
  readOnly = false,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: ContactDetail;
  readOnly?: boolean;
  submitLabel: string;
  onSubmit: (values: ContactFormValues) => Promise<void>;
  onCancel: () => void;
}) {
  const [consent, setConsent] = useState<ContactConsentStatus>(initial?.consentStatus ?? 'UNKNOWN');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const text = (name: string) => {
      const value = data.get(name);
      return typeof value === 'string' ? value.trim() : '';
    };
    if (!text('firstName')) {
      setError('Enter the first name.');
      return;
    }
    if (consent !== 'UNKNOWN' && text('consentSource').length < 2) {
      setError('Say where the marketing preference was given (e.g. "trade fair form").');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        firstName: text('firstName'),
        lastName: text('lastName') || null,
        position: text('position') || null,
        email: text('email') || null,
        phone: text('phone') || null,
        linkedin: text('linkedin') || null,
        tags: parseTags(text('tags')),
        isPrimary: data.get('isPrimary') === 'on',
        isDecisionMaker: data.get('isDecisionMaker') === 'on',
        consentStatus: consent,
        consentSource: consent === 'UNKNOWN' ? null : text('consentSource'),
      });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not reach the server. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={(event) => void handleSubmit(event)} noValidate>
      {error && <Alert>{error}</Alert>}
      <fieldset disabled={readOnly} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          {TEXT_FIELDS.map((field) => (
            <div key={field.name} className="space-y-1.5">
              <Label htmlFor={`contact-${field.name}`}>{field.label}</Label>
              <Input
                id={`contact-${field.name}`}
                name={field.name}
                type={field.type ?? 'text'}
                maxLength={field.maxLength}
                defaultValue={initial?.[field.name] ?? ''}
                required={field.name === 'firstName'}
              />
            </div>
          ))}
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="contact-tags">Tags (comma-separated)</Label>
            <Input id="contact-tags" name="tags" defaultValue={initial?.tags.join(', ') ?? ''} />
          </div>
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              name="isPrimary"
              defaultChecked={initial?.isPrimary}
              className="size-4 accent-brand-600"
            />
            Primary contact of the company
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              name="isDecisionMaker"
              defaultChecked={initial?.isDecisionMaker}
              className="size-4 accent-brand-600"
            />
            Decision maker
          </label>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="contact-consent">Marketing consent</Label>
            <select
              id="contact-consent"
              className="h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
              value={consent}
              onChange={(e) => setConsent(e.currentTarget.value as ContactConsentStatus)}
            >
              {CONTACT_CONSENT_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {CONSENT_LABELS[status]}
                </option>
              ))}
            </select>
          </div>
          {consent !== 'UNKNOWN' && (
            <div className="space-y-1.5">
              <Label htmlFor="contact-consentSource">Where was it given?</Label>
              <Input
                id="contact-consentSource"
                name="consentSource"
                maxLength={200}
                defaultValue={initial?.consentSource ?? ''}
              />
            </div>
          )}
        </div>
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

export { CONSENT_LABELS };
