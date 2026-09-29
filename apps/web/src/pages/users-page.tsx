import type {
  InviteMemberRequest,
  InviteMemberResponse,
  IssuedInvitation,
  MembershipListItem,
  Page,
  RoleListItem,
} from '@ooh/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert, Card } from '@/components/ui/card';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { hasPermission, useMe } from '@/lib/me';
import { EditRolesForm } from './edit-roles-form';
import { formatDate, InvitationLink } from './invitation-link';
import { InviteMemberForm } from './invite-member-form';

/** Status column text; an INVITED member whose link lapsed needs a new link. */
export function memberStatusLabel(member: MembershipListItem, now = Date.now()): string {
  switch (member.status) {
    case 'ACTIVE':
      return 'Active';
    case 'SUSPENDED':
      return 'Suspended';
    case 'INVITED':
      if (!member.invitation || new Date(member.invitation.expiresAt).getTime() <= now) {
        return 'Invitation expired';
      }
      return `Invited · expires ${formatDate(member.invitation.expiresAt)}`;
  }
}

interface ShownLink {
  email: string;
  invitation: IssuedInvitation;
}

type Panel = { kind: 'invite' } | { kind: 'roles'; member: MembershipListItem } | null;
type StatusAction = 'suspend' | 'reactivate';

export function UsersPage() {
  const { session } = useAuth();
  const { data: me } = useMe();
  const queryClient = useQueryClient();
  const [panel, setPanel] = useState<Panel>(null);
  const [shownLink, setShownLink] = useState<ShownLink | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // UI convenience only; the API enforces every permission (and who may manage whom) regardless.
  // Invite and edit-roles need the role list, hence roles.read too.
  const can = {
    invite: hasPermission(me, 'users.invite') && hasPermission(me, 'roles.read'),
    editRoles: hasPermission(me, 'users.update') && hasPermission(me, 'roles.read'),
    suspend: hasPermission(me, 'users.suspend'),
  };
  const showActions = can.invite || can.editRoles || can.suspend;
  const membersKey = ['memberships', session?.tenantId];

  const { data, isLoading, error } = useQuery({
    queryKey: membersKey,
    queryFn: () => api.request<Page<MembershipListItem>>('/memberships?limit=100'),
  });
  const roles = useQuery({
    queryKey: ['roles', session?.tenantId],
    queryFn: () => api.request<Page<RoleListItem>>('/roles'),
    enabled: panel !== null,
  });

  const refreshMembers = () => queryClient.invalidateQueries({ queryKey: membersKey });

  function openPanel(next: Panel) {
    setShownLink(null);
    setActionError(null);
    setPanel(next);
  }

  async function invite(request: InviteMemberRequest) {
    const created = await api.request<InviteMemberResponse>('/memberships', {
      method: 'POST',
      json: request,
    });
    setPanel(null);
    setShownLink({ email: created.membership.email, invitation: created.invitation });
    await refreshMembers();
  }

  async function saveRoles(member: MembershipListItem, roleIds: string[]) {
    await api.request<MembershipListItem>(`/memberships/${member.id}/roles`, {
      method: 'PUT',
      json: { roleIds },
    });
    setPanel(null);
    await refreshMembers();
  }

  const resend = useMutation({
    mutationFn: (member: MembershipListItem) =>
      api.request<IssuedInvitation>(`/memberships/${member.id}/actions/resend-invitation`, {
        method: 'POST',
      }),
    onMutate: () => setActionError(null),
    onSuccess: (invitation, member) => {
      setShownLink({ email: member.email, invitation });
      void refreshMembers();
    },
    onError: (e) => setActionError(e.message),
  });

  const cancel = useMutation({
    mutationFn: (member: MembershipListItem) =>
      api.request<void>(`/memberships/${member.id}/actions/cancel-invitation`, { method: 'POST' }),
    onMutate: () => setActionError(null),
    onSuccess: (_, member) => {
      if (shownLink?.email === member.email) setShownLink(null);
      void refreshMembers();
    },
    onError: (e) => setActionError(e.message),
  });

  const changeStatus = useMutation({
    mutationFn: ({ member, action }: { member: MembershipListItem; action: StatusAction }) =>
      api.request<MembershipListItem>(`/memberships/${member.id}/actions/${action}`, { method: 'POST' }),
    onMutate: () => setActionError(null),
    onSuccess: () => void refreshMembers(),
    onError: (e) => setActionError(e.message),
  });

  const busy = resend.isPending || cancel.isPending || changeStatus.isPending;

  function confirmStatus(member: MembershipListItem, action: StatusAction) {
    const question =
      action === 'suspend'
        ? `Suspend ${member.displayName}? They are signed out and can't sign in to this company until reactivated.`
        : `Reactivate ${member.displayName}? They can sign in again with their current roles.`;
    if (window.confirm(question)) changeStatus.mutate({ member, action });
  }

  return (
    <div className="max-w-5xl space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold">Users</h1>
        {can.invite && panel?.kind !== 'invite' && (
          <Button onClick={() => openPanel({ kind: 'invite' })}>Invite user</Button>
        )}
      </div>

      {panel && (
        <Card className="p-4">
          <h2 className="mb-3 text-base font-semibold">
            {panel.kind === 'invite' ? 'Invite a user' : `Roles of ${panel.member.displayName}`}
          </h2>
          {roles.isLoading && <p className="text-sm text-slate-500">Loading roles…</p>}
          {roles.error && <Alert>{roles.error.message}</Alert>}
          {roles.data && panel.kind === 'invite' && (
            <InviteMemberForm roles={roles.data.data} onSubmit={invite} onCancel={() => setPanel(null)} />
          )}
          {roles.data && panel.kind === 'roles' && (
            <EditRolesForm
              key={panel.member.id}
              member={panel.member}
              roles={roles.data.data}
              onSubmit={(roleIds) => saveRoles(panel.member, roleIds)}
              onCancel={() => setPanel(null)}
            />
          )}
        </Card>
      )}

      {shownLink && (
        <InvitationLink
          email={shownLink.email}
          token={shownLink.invitation.token}
          expiresAt={shownLink.invitation.expiresAt}
          onDismiss={() => setShownLink(null)}
        />
      )}
      {actionError && <Alert>{actionError}</Alert>}

      {isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {error && <p className="text-sm text-red-700">{error.message}</p>}
      {data && (
        <Card className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Email</th>
                <th className="px-4 py-2">Type</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Roles</th>
                {showActions && (
                  <th className="px-4 py-2">
                    <span className="sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {data.data.map((m) => {
                const isSelf = m.id === me?.membership.id;
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
                  <tr key={m.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-2 font-medium">
                      {m.displayName}
                      {isSelf && <span className="ml-2 text-xs font-normal text-slate-500">(you)</span>}
                    </td>
                    <td className="px-4 py-2">{m.email}</td>
                    <td className="px-4 py-2">{m.kind === 'INTERNAL' ? 'Internal' : 'External'}</td>
                    <td className="px-4 py-2">{memberStatusLabel(m)}</td>
                    <td className="px-4 py-2">{m.roles.map((r) => r.name).join(', ')}</td>
                    {showActions && (
                      // Your own row has no actions: nobody manages themselves (the API refuses too).
                      <td className="whitespace-nowrap px-4 py-1 text-right">
                        {!isSelf && (
                          <>
                            {can.editRoles &&
                              action('Roles', `Edit roles of ${m.email}`, () =>
                                openPanel({ kind: 'roles', member: m }),
                              )}
                            {m.status === 'INVITED' &&
                              can.invite &&
                              action('New link', `New invitation link for ${m.email}`, () =>
                                resend.mutate(m),
                              )}
                            {m.status === 'INVITED' &&
                              can.invite &&
                              action(
                                'Cancel',
                                `Cancel invitation for ${m.email}`,
                                () => {
                                  if (window.confirm(`Cancel the invitation for ${m.email}?`))
                                    cancel.mutate(m);
                                },
                                true,
                              )}
                            {m.status === 'ACTIVE' &&
                              can.suspend &&
                              action(
                                'Suspend',
                                `Suspend ${m.email}`,
                                () => confirmStatus(m, 'suspend'),
                                true,
                              )}
                            {m.status === 'SUSPENDED' &&
                              can.suspend &&
                              action('Reactivate', `Reactivate ${m.email}`, () =>
                                confirmStatus(m, 'reactivate'),
                              )}
                          </>
                        )}
                      </td>
                    )}
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
