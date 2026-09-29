import {
  type CreateRoleRequest,
  etagOf,
  IF_MATCH_HEADER,
  type Page,
  type RoleDetail,
  type RoleListItem,
  type UpdateRoleRequest,
} from '@ooh/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert, Card } from '@/components/ui/card';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { hasPermission, useMe } from '@/lib/me';
import { AdminTabs } from './admin-tabs';
import { RoleEditor, type RoleDraft } from './role-editor';

export const ROLE_CONFLICT_MESSAGE =
  'Someone else changed this role in the meantime. The list now shows the current state; check it and try again.';

/** `null` = the list only; `new` may start from an existing role (duplicate). */
type Panel = { kind: 'new'; draft: RoleDraft } | { kind: 'open'; roleId: string } | null;

const EMPTY_DRAFT: RoleDraft = { name: '', description: null, grants: [] };

export function RolesPage() {
  const { session } = useAuth();
  const { data: me } = useMe();
  const queryClient = useQueryClient();
  const [panel, setPanel] = useState<Panel>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const canManage = hasPermission(me, 'roles.manage');
  const rolesKey = ['roles', session?.tenantId];

  const { data, isLoading, error } = useQuery({
    queryKey: rolesKey,
    queryFn: () => api.request<Page<RoleListItem>>('/roles'),
  });
  const opened = useQuery({
    queryKey: ['role', panel?.kind === 'open' ? panel.roleId : null],
    queryFn: () => api.request<RoleDetail>(`/roles/${(panel as { roleId: string }).roleId}`),
    enabled: panel?.kind === 'open',
  });

  const refreshRoles = async () => {
    await queryClient.invalidateQueries({ queryKey: rolesKey });
    await queryClient.invalidateQueries({ queryKey: ['role'] });
  };

  function open(next: Panel) {
    setActionError(null);
    setPanel(next);
  }

  /** Changes to an existing role send If-Match; on 412 the list reloads and the error explains why. */
  async function roleRequest<T>(
    item: { id: string; version: number },
    init: { method: 'PATCH' | 'DELETE'; json?: UpdateRoleRequest },
  ): Promise<T> {
    try {
      return await api.request<T>(`/roles/${item.id}`, {
        ...init,
        headers: { [IF_MATCH_HEADER]: etagOf(item.version) },
      });
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'PRECONDITION_FAILED') {
        await refreshRoles();
        throw new ApiError(caught.status, { ...caught.problem!, detail: ROLE_CONFLICT_MESSAGE });
      }
      throw caught;
    }
  }

  async function create(draft: CreateRoleRequest) {
    await api.request<RoleDetail>('/roles', { method: 'POST', json: draft });
    setPanel(null);
    await refreshRoles();
  }

  async function save(role: RoleDetail, draft: CreateRoleRequest) {
    await roleRequest<RoleDetail>(role, { method: 'PATCH', json: draft });
    setPanel(null);
    await refreshRoles();
  }

  async function duplicate(item: RoleListItem) {
    setActionError(null);
    try {
      const source = await api.request<RoleDetail>(`/roles/${item.id}`);
      setPanel({
        kind: 'new',
        draft: { name: `Copy of ${source.name}`, description: source.description, grants: source.grants },
      });
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : 'Could not load the role.');
    }
  }

  const setActive = useMutation({
    mutationFn: ({ item, active }: { item: RoleListItem; active: boolean }) =>
      roleRequest<RoleDetail>(item, { method: 'PATCH', json: { active } }),
    onMutate: () => setActionError(null),
    onSuccess: () => void refreshRoles(),
    onError: (e) => setActionError(e.message),
  });

  const remove = useMutation({
    mutationFn: (item: RoleListItem) => roleRequest<void>(item, { method: 'DELETE' }),
    onMutate: () => setActionError(null),
    onSuccess: () => void refreshRoles(),
    onError: (e) => setActionError(e.message),
  });

  const busy = setActive.isPending || remove.isPending;
  const openedRole = panel?.kind === 'open' ? opened.data : undefined;

  return (
    <div className="max-w-5xl space-y-4">
      <AdminTabs />
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold">Roles</h1>
        {canManage && panel?.kind !== 'new' && (
          <Button onClick={() => open({ kind: 'new', draft: EMPTY_DRAFT })}>New role</Button>
        )}
      </div>

      {panel?.kind === 'new' && (
        <Card className="p-4">
          <h2 className="mb-3 text-base font-semibold">New role</h2>
          <RoleEditor
            initial={panel.draft}
            submitLabel="Create role"
            onSubmit={create}
            onCancel={() => setPanel(null)}
          />
        </Card>
      )}
      {panel?.kind === 'open' && (
        <Card className="p-4">
          {opened.isLoading && <p className="text-sm text-slate-500">Loading role…</p>}
          {opened.error && <Alert>{opened.error.message}</Alert>}
          {openedRole && (
            <>
              <h2 className="mb-1 text-base font-semibold">{openedRole.name}</h2>
              {openedRole.isSystem && (
                <p className="mb-3 text-xs text-slate-500">
                  System role: its permissions come from the platform templates. Duplicate it to create a
                  custom role you can change.
                </p>
              )}
              <RoleEditor
                key={`${openedRole.id}:${openedRole.version}`}
                initial={openedRole}
                readOnly={openedRole.isSystem || !canManage}
                onSubmit={(draft) => save(openedRole, draft)}
                onCancel={() => setPanel(null)}
              />
            </>
          )}
        </Card>
      )}
      {actionError && <Alert>{actionError}</Alert>}

      {isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {error && <p className="text-sm text-red-700">{error.message}</p>}
      {data && (
        <Card className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-2">Role</th>
                <th className="px-4 py-2">Type</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Members</th>
                <th className="px-4 py-2">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.data.map((r) => {
                const action = (label: string, ariaLabel: string, onClick: () => void, danger = false) => (
                  <Button
                    variant="ghost"
                    className={danger ? 'h-8 px-2 text-red-700' : 'h-8 px-2'}
                    disabled={busy}
                    onClick={onClick}
                    aria-label={ariaLabel}
                  >
                    {label}
                  </Button>
                );
                return (
                  <tr key={r.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-2">
                      <span className="font-medium">{r.name}</span>
                      {r.description && <span className="block text-xs text-slate-500">{r.description}</span>}
                    </td>
                    <td className="px-4 py-2">
                      {r.isSystem ? 'System' : 'Custom'}
                      {r.isExternal && ' · external'}
                    </td>
                    <td className="px-4 py-2">{r.active ? 'Active' : 'Disabled'}</td>
                    <td className="px-4 py-2">{r.memberCount}</td>
                    <td className="whitespace-nowrap px-4 py-1 text-right">
                      {action(canManage && !r.isSystem ? 'Edit' : 'View', `Open role ${r.name}`, () =>
                        open({ kind: 'open', roleId: r.id }),
                      )}
                      {canManage && action('Duplicate', `Duplicate role ${r.name}`, () => void duplicate(r))}
                      {canManage &&
                        (r.active
                          ? action(
                              'Disable',
                              `Disable role ${r.name}`,
                              () => {
                                if (
                                  window.confirm(
                                    `Disable ${r.name}? Its ${r.memberCount} member(s) lose its permissions until it is enabled again.`,
                                  )
                                )
                                  setActive.mutate({ item: r, active: false });
                              },
                              true,
                            )
                          : action('Enable', `Enable role ${r.name}`, () =>
                              setActive.mutate({ item: r, active: true }),
                            ))}
                      {canManage &&
                        !r.isSystem &&
                        r.memberCount === 0 &&
                        action(
                          'Delete',
                          `Delete role ${r.name}`,
                          () => {
                            if (window.confirm(`Delete the role ${r.name}? This can’t be undone.`))
                              remove.mutate(r);
                          },
                          true,
                        )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
