import { INVITATION_ACCEPT_PATH } from '@ooh/contracts';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

export function invitationUrl(token: string, origin = window.location.origin): string {
  return `${origin}${INVITATION_ACCEPT_PATH}/${encodeURIComponent(token)}`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * Shows a freshly issued invitation link. The token is only ever returned once by the API, so this
 * is the one moment it can be copied (OPD-25: the admin shares it until invitation emails exist).
 */
export function InvitationLink({
  email,
  token,
  expiresAt,
  onDismiss,
}: {
  email: string;
  token: string;
  expiresAt: string;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const url = invitationUrl(token);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false); // Clipboard blocked: the field stays selectable for manual copying.
    }
  }

  return (
    <Card className="space-y-3 border-brand-100 bg-brand-50 p-4" role="status">
      <p className="text-sm text-slate-800">
        Invitation ready for <strong>{email}</strong>. Send them this link: it works once and expires on{' '}
        {formatDate(expiresAt)}. It won’t be shown again, but you can create a new one at any time.
      </p>
      <div className="flex gap-2">
        <Input aria-label="Invitation link" value={url} readOnly onFocus={(e) => e.currentTarget.select()} />
        <Button variant="secondary" className="shrink-0" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy link'}
        </Button>
        <Button variant="ghost" className="shrink-0" onClick={onDismiss}>
          Done
        </Button>
      </div>
    </Card>
  );
}
