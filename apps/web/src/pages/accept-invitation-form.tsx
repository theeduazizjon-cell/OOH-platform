import {
  type AcceptInvitationRequest,
  type InvitationPreview,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '@ooh/contracts';
import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { ApiError } from '@/lib/api';

const MESSAGES: Record<string, string> = {
  INVALID_CREDENTIALS: 'Incorrect password for this account.',
  RATE_LIMITED: 'Too many failed attempts. Please wait 15 minutes and try again.',
  INVITATION_INVALID:
    'This invitation link is no longer valid. Ask your administrator to send you a new one.',
};

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return (error.code && MESSAGES[error.code]) ?? error.message;
  return 'Could not reach the server. Check your connection and try again.';
}

/**
 * New account: choose a name and password. Existing account: confirm its current password, which
 * the API requires so that an invitation link alone can never take over an account.
 */
export function AcceptInvitationForm({
  preview,
  onSubmit,
}: {
  preview: InvitationPreview;
  onSubmit: (body: AcceptInvitationRequest) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const field = (name: string) => {
      const value = data.get(name);
      return typeof value === 'string' ? value : '';
    };
    const password = field('password');

    if (!preview.hasAccount) {
      if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
        setError(`Choose a password of ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} characters.`);
        return;
      }
      if (password !== field('confirmPassword')) {
        setError('The two passwords do not match.');
        return;
      }
    }

    setSubmitting(true);
    setError(null);
    try {
      const displayName = field('displayName').trim();
      await onSubmit(preview.hasAccount || !displayName ? { password } : { password, displayName });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={(event) => void handleSubmit(event)} noValidate>
      {error && <Alert>{error}</Alert>}
      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input id="email" value={preview.email} autoComplete="username" readOnly disabled />
      </div>
      {preview.hasAccount ? (
        <div className="space-y-1.5">
          <Label htmlFor="password">Your current password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            autoFocus
          />
        </div>
      ) : (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="displayName">Your name</Label>
            <Input
              id="displayName"
              name="displayName"
              defaultValue={preview.displayName}
              autoComplete="name"
              maxLength={120}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Choose a password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={PASSWORD_MIN_LENGTH}
              maxLength={PASSWORD_MAX_LENGTH}
              aria-describedby="password-hint"
              required
              autoFocus
            />
            <p id="password-hint" className="text-xs text-slate-500">
              At least {PASSWORD_MIN_LENGTH} characters. A few unrelated words work well.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="confirmPassword">Repeat the password</Label>
            <Input
              id="confirmPassword"
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              required
            />
          </div>
        </>
      )}
      <Button type="submit" className="w-full" disabled={submitting}>
        {submitting ? 'Joining…' : `Join ${preview.tenantName}`}
      </Button>
    </form>
  );
}
