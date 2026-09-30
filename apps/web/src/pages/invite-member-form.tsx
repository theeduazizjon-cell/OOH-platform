import type { InviteMemberRequest, RoleListItem } from '@ooh/contracts';
import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { ApiError } from '@/lib/api';
import { CompanyPicker, type PickedCompany } from './company-picker';
import { type MemberKind, RoleCheckboxes, selectedRoleIds } from './role-checkboxes';

export function errorMessage(error: unknown): string {
  // CONFLICT (already invited/member), FORBIDDEN (would grant more than you hold) and
  // VALIDATION_FAILED all carry a readable detail from the API.
  if (error instanceof ApiError) return error.message;
  return 'Could not reach the server. Check your connection and try again.';
}

/**
 * Invite a colleague (internal roles) or a person representing a company, e.g. a client or agency
 * contact (external roles, tied to that company). `canPickCompany` needs organisation.read.
 */
export function InviteMemberForm({
  roles,
  canPickCompany = false,
  onSubmit,
  onCancel,
}: {
  roles: readonly RoleListItem[];
  canPickCompany?: boolean;
  onSubmit: (request: InviteMemberRequest) => Promise<void>;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<MemberKind>('INTERNAL');
  const [company, setCompany] = useState<PickedCompany | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const text = (name: string) => {
      const value = data.get(name);
      return typeof value === 'string' ? value.trim() : '';
    };
    const roleIds = selectedRoleIds(data);
    if (!text('email') || !text('displayName')) {
      setError('Enter the person’s email and name.');
      return;
    }
    if (kind === 'EXTERNAL' && !company) {
      setError('Choose the company this person represents.');
      return;
    }
    if (roleIds.length === 0) {
      setError('Choose at least one role.');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        email: text('email'),
        displayName: text('displayName'),
        roleIds,
        ...(kind === 'EXTERNAL' && company ? { organisationId: company.id } : {}),
      });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={(event) => void handleSubmit(event)} noValidate>
      {error && <Alert>{error}</Alert>}
      {canPickCompany && (
        <fieldset className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <legend className="sr-only">Who are you inviting?</legend>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="kind"
              checked={kind === 'INTERNAL'}
              onChange={() => setKind('INTERNAL')}
              className="size-4 accent-brand-600"
            />
            A colleague
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="kind"
              checked={kind === 'EXTERNAL'}
              onChange={() => setKind('EXTERNAL')}
              className="size-4 accent-brand-600"
            />
            Someone from a client, agency or supplier
          </label>
        </fieldset>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="invite-email">Email</Label>
          <Input
            id="invite-email"
            name="email"
            type="email"
            autoComplete="off"
            maxLength={254}
            required
            autoFocus
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="invite-name">Name</Label>
          <Input id="invite-name" name="displayName" autoComplete="off" maxLength={120} required />
        </div>
      </div>
      {kind === 'EXTERNAL' && (
        <CompanyPicker
          id="invite-company"
          label="Company they represent"
          value={company}
          onChange={setCompany}
        />
      )}
      {/* Remounted per kind so no role of the other kind stays ticked. */}
      <RoleCheckboxes key={kind} roles={roles} kind={kind} />
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Inviting…' : 'Create invitation'}
        </Button>
      </div>
    </form>
  );
}
