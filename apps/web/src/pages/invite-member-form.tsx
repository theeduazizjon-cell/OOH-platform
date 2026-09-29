import type { InviteMemberRequest, RoleListItem } from '@ooh/contracts';
import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { ApiError } from '@/lib/api';
import { RoleCheckboxes, selectedRoleIds } from './role-checkboxes';

export function errorMessage(error: unknown): string {
  // CONFLICT (already invited/member), FORBIDDEN (would grant more than you hold) and
  // VALIDATION_FAILED all carry a readable detail from the API.
  if (error instanceof ApiError) return error.message;
  return 'Could not reach the server. Check your connection and try again.';
}

export function InviteMemberForm({
  roles,
  onSubmit,
  onCancel,
}: {
  roles: readonly RoleListItem[];
  onSubmit: (request: InviteMemberRequest) => Promise<void>;
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
    const roleIds = selectedRoleIds(data);
    if (!text('email') || !text('displayName')) {
      setError('Enter the person’s email and name.');
      return;
    }
    if (roleIds.length === 0) {
      setError('Choose at least one role.');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({ email: text('email'), displayName: text('displayName'), roleIds });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={(event) => void handleSubmit(event)} noValidate>
      {error && <Alert>{error}</Alert>}
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
      <RoleCheckboxes roles={roles} />
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
