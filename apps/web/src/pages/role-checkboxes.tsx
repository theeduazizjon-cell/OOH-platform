import type { RoleListItem } from '@ooh/contracts';

export type MemberKind = 'INTERNAL' | 'EXTERNAL';

/**
 * Roles a member can be given: active, and internal roles for staff or external roles for people
 * representing a company (the API refuses mixing them).
 */
export function assignableRoles(
  roles: readonly RoleListItem[],
  kind: MemberKind = 'INTERNAL',
): RoleListItem[] {
  return roles.filter((r) => r.active && r.isExternal === (kind === 'EXTERNAL'));
}

/** Role picker for the invite and edit-roles forms. Submits as repeated `roleIds` form fields. */
export function RoleCheckboxes({
  roles,
  selected = [],
  kind = 'INTERNAL',
}: {
  roles: readonly RoleListItem[];
  selected?: readonly string[];
  kind?: MemberKind;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium text-slate-700">Roles</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {assignableRoles(roles, kind).map((r) => (
          <label key={r.id} className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              name="roleIds"
              value={r.id}
              defaultChecked={selected.includes(r.id)}
              className="mt-0.5 size-4 accent-brand-600"
            />
            <span>
              <span className="font-medium text-slate-800">{r.name}</span>
              {r.description && <span className="block text-xs text-slate-500">{r.description}</span>}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function selectedRoleIds(data: FormData): string[] {
  return data.getAll('roleIds').filter((v): v is string => typeof v === 'string');
}
