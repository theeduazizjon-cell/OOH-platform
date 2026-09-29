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

export function UsersPage() {
  const { session } = useAuth();
  const { data: me } = useMe();
  const queryClient = useQueryClient();
  const [inviting, setInviting] = useState(false);
  const [shownLink, setShownLink] = useState<ShownLink | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Inviting needs the role list, hence roles.read too. The API enforces both regardless.
  const canInvite = hasPermission(me, 'users.invite') && hasPermission(me, 'roles.read');
  const membersKey = ['memberships', session?.tenantId];

  const { data, isLoading, error } = useQuery({
    queryKey: membersKey,
    queryFn: () => api.request<Page<MembershipListItem>>('/memberships?limit=100'),
  });
  const roles = useQuery({
    queryKey: ['roles', session?.tenantId],
    queryFn: () => api.request<Page<RoleListItem>>('/roles'),
    enabled: inviting,
  });

  const refreshMembers = () => queryClient.invalidateQueries({ queryKey: membersKey });

  async function invite(request: InviteMemberRequest) {
    const created = await api.request<InviteMemberResponse>('/memberships', {
      method: 'POST',
      json: request,
    });
    setInviting(false);
    setShownLink({ email: created.membership.email, invitation: created.invitation });
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

  const busy = resend.isPending || cancel.isPending;

  return (
    <div className="max-w-5xl space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold">Users</h1>
        {canInvite && !inviting && (
          <Button
            onClick={() => {
              setShownLink(null);
              setInviting(true);
            }}
          >
            Invite user
          </Button>
        )}
      </div>

      {inviting && (
        <Card className="p-4">
          <h2 className="mb-3 text-base font-semibold">Invite a user</h2>
          {roles.isLoading && <p className="text-sm text-slate-500">Loading roles…</p>}
          {roles.error && <Alert>{roles.error.message}</Alert>}
          {roles.data && (
            <InviteMemberForm roles={roles.data.data} onSubmit={invite} onCancel={() => setInviting(false)} />
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
                {canInvite && (
                  <th className="px-4 py-2">
                    <span className="sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {data.data.map((m) => (
                <tr key={m.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-2 font-medium">{m.displayName}</td>
                  <td className="px-4 py-2">{m.email}</td>
                  <td className="px-4 py-2">{m.kind === 'INTERNAL' ? 'Internal' : 'External'}</td>
                  <td className="px-4 py-2">{memberStatusLabel(m)}</td>
                  <td className="px-4 py-2">{m.roles.map((r) => r.name).join(', ')}</td>
                  {canInvite && (
                    <td className="whitespace-nowrap px-4 py-1 text-right">
                      {m.status === 'INVITED' && (
                        <>
                          <Button
                            variant="ghost"
                            className="h-8 px-2"
                            disabled={busy}
                            onClick={() => resend.mutate(m)}
                            aria-label={`New invitation link for ${m.email}`}
                          >
                            New link
                          </Button>
                          <Button
                            variant="ghost"
                            className="h-8 px-2 text-red-700"
                            disabled={busy}
                            onClick={() => {
                              if (window.confirm(`Cancel the invitation for ${m.email}?`)) cancel.mutate(m);
                            }}
                            aria-label={`Cancel invitation for ${m.email}`}
                          >
                            Cancel
                          </Button>
                        </>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
