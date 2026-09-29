import {
  type CreateRoleRequest,
  type PermissionCatalogItem,
  permissionCatalog,
  type PermissionKey,
  type PermissionScope,
  type RoleGrant,
} from '@ooh/contracts';
import { type FormEvent, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { errorMessage } from './invite-member-form';

const SCOPE_LABELS: Record<PermissionScope, string> = {
  ALL: 'All records',
  OWN: 'Own records',
  ASSIGNED: 'Assigned to them',
  ORGANISATION: 'Their organisation',
};

/** Catalog grouped by module, in catalog order. */
function groupByModule(catalog: readonly PermissionCatalogItem[]): [string, PermissionCatalogItem[]][] {
  const groups = new Map<string, PermissionCatalogItem[]>();
  for (const item of catalog) groups.set(item.module, [...(groups.get(item.module) ?? []), item]);
  return [...groups];
}

export interface RoleDraft {
  name: string;
  description: string | null;
  grants: RoleGrant[];
}

/**
 * Permission picker for a role. Read-only for system roles (their definition comes from the
 * templates) and when the viewer can't manage roles. The API re-validates everything, including
 * that nobody grants more than they hold.
 */
export function RoleEditor({
  initial,
  readOnly = false,
  submitLabel = 'Save role',
  onSubmit,
  onCancel,
}: {
  initial: RoleDraft;
  readOnly?: boolean;
  submitLabel?: string;
  onSubmit: (draft: CreateRoleRequest) => Promise<void>;
  onCancel: () => void;
}) {
  const catalog = useMemo(() => permissionCatalog(), []);
  const groups = useMemo(() => groupByModule(catalog), [catalog]);
  const [grants, setGrants] = useState<Map<PermissionKey, PermissionScope>>(
    () => new Map(initial.grants.map((g) => [g.permission, g.scope])),
  );
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function toggle(item: PermissionCatalogItem, checked: boolean) {
    setGrants((current) => {
      const next = new Map(current);
      if (checked) next.set(item.key, item.scopes[0]!);
      else next.delete(item.key);
      return next;
    });
  }

  function setScope(key: PermissionKey, scope: PermissionScope) {
    setGrants((current) => new Map(current).set(key, scope));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const text = (field: string) => {
      const value = data.get(field);
      return typeof value === 'string' ? value.trim() : '';
    };
    if (!text('name')) {
      setError('Give the role a name.');
      return;
    }
    if (grants.size === 0) {
      setError('Choose at least one permission.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        name: text('name'),
        description: text('description') || null,
        grants: [...grants].map(([permission, scope]) => ({ permission, scope })),
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
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="role-name">Name</Label>
          <Input
            id="role-name"
            name="name"
            defaultValue={initial.name}
            maxLength={80}
            required
            disabled={readOnly}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="role-description">Description</Label>
          <Input
            id="role-description"
            name="description"
            defaultValue={initial.description ?? ''}
            maxLength={500}
            disabled={readOnly}
          />
        </div>
      </div>
      <div className="max-h-[28rem] space-y-4 overflow-y-auto rounded-md border border-slate-200 p-3">
        {groups.map(([module, items]) => (
          <fieldset key={module} className="space-y-1.5">
            <legend className="text-xs font-semibold uppercase tracking-wide text-slate-500">{module}</legend>
            {items.map((item) => {
              const scope = grants.get(item.key);
              return (
                <div key={item.key} className="flex items-center justify-between gap-3 text-sm">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      className="size-4 accent-brand-600"
                      checked={scope !== undefined}
                      disabled={readOnly}
                      onChange={(e) => toggle(item, e.currentTarget.checked)}
                    />
                    <span>
                      {item.description} <span className="text-xs text-slate-400">{item.key}</span>
                    </span>
                  </label>
                  {scope !== undefined && item.scopes.length > 1 && (
                    <select
                      aria-label={`Scope of ${item.key}`}
                      className="h-8 rounded-md border border-slate-300 bg-white px-2 text-xs"
                      value={scope}
                      disabled={readOnly}
                      onChange={(e) => setScope(item.key, e.currentTarget.value as PermissionScope)}
                    >
                      {item.scopes.map((s) => (
                        <option key={s} value={s}>
                          {SCOPE_LABELS[s]}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              );
            })}
          </fieldset>
        ))}
      </div>
      <p className="text-xs text-slate-500">
        {grants.size} permission(s) selected. You can only grant permissions you hold yourself.
      </p>
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
