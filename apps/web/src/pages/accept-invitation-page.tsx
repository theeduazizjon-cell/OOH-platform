import type { InvitationPreview } from '@ooh/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { AcceptInvitationForm } from './accept-invitation-form';

/** Public page behind the invitation link `/invite/<token>`. */
export function AcceptInvitationPage({ token }: { token: string }) {
  const auth = useAuth();
  const navigate = useNavigate();
  const [joinedTenantId, setJoinedTenantId] = useState<string | null>(null);

  const preview = useQuery({
    queryKey: ['invitation-preview', token],
    queryFn: () => api.request<InvitationPreview>(`/auth/invitations/${encodeURIComponent(token)}`),
    enabled: joinedTenantId === null,
    staleTime: Infinity,
  });

  // Navigate once the new session is live, so the /app guard sees it.
  useEffect(() => {
    if (joinedTenantId && auth.status === 'authenticated' && auth.session?.tenantId === joinedTenantId) {
      void navigate({ to: '/app' });
    }
  }, [joinedTenantId, auth.status, auth.session?.tenantId, navigate]);

  const invalid = preview.error instanceof ApiError && preview.error.code === 'INVITATION_INVALID';

  return (
    <main className="flex min-h-full items-center justify-center p-4">
      <Card className="w-full max-w-sm p-6">
        <h1 className="text-xl font-semibold">OOH Platform</h1>
        {preview.isLoading && <p className="mt-2 text-sm text-slate-500">Loading invitation…</p>}
        {invalid && (
          <>
            <p className="mb-4 mt-2 text-sm text-slate-700">
              This invitation link is invalid, has expired or was already used. Ask your administrator to send
              you a new one.
            </p>
            <Link to="/login" search={{}} className="text-sm font-medium text-brand-700 hover:underline">
              Go to sign-in
            </Link>
          </>
        )}
        {preview.error && !invalid && (
          <p className="mt-2 text-sm text-red-700">Could not load the invitation. Please try again.</p>
        )}
        {preview.data && (
          <>
            <p className="mb-6 text-sm text-slate-500">
              You have been invited to join{' '}
              <strong className="text-slate-800">{preview.data.tenantName}</strong>.
              {preview.data.hasAccount && ' Confirm with the password of your existing account.'}
            </p>
            <AcceptInvitationForm
              preview={preview.data}
              onSubmit={async (body) => setJoinedTenantId(await auth.acceptInvitation(token, body))}
            />
          </>
        )}
      </Card>
    </main>
  );
}
