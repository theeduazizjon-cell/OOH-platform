import type { MembershipListItem, RoleListItem } from '@ooh/contracts';
import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/card';
import { errorMessage } from './invite-member-form';
import { RoleCheckboxes, selectedRoleIds } from './role-checkboxes';

/**
 * Replaces a member's roles. The API refuses roles granting more than the editor holds, and members
 * who hold more than the editor; its message is shown as is.
 */
export function EditRolesForm({
  member,
  roles,
  onSubmit,
  onCancel,
}: {
  member: MembershipListItem;
  roles: readonly RoleListItem[];
  onSubmit: (roleIds: string[]) => Promise<void>;
  onCancel: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const roleIds = selectedRoleIds(new FormData(event.currentTarget));
    if (roleIds.length === 0) {
      setError('Choose at least one role. To remove access, suspend the member instead.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(roleIds);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={(event) => void handleSubmit(event)} noValidate>
      {error && <Alert>{error}</Alert>}
      <RoleCheckboxes roles={roles} selected={member.roles.map((r) => r.id)} />
      {member.status === 'ACTIVE' && (
        <p className="text-xs text-slate-500">
          {member.displayName}’s open sessions switch to the new permissions on their next action.
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : 'Save roles'}
        </Button>
      </div>
    </form>
  );
}
