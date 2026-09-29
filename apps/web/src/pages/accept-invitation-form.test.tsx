import type { InvitationPreview } from '@ooh/contracts';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import { AcceptInvitationForm } from './accept-invitation-form';

const preview = (hasAccount: boolean): InvitationPreview => ({
  email: 'new@example.com',
  displayName: 'Nina New',
  tenantName: 'Demo OOH SRL',
  hasAccount,
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
});

describe('AcceptInvitationForm, new account', () => {
  it('checks length and confirmation before submitting', async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    render(<AcceptInvitationForm preview={preview(false)} onSubmit={onSubmit} />);

    await userEvent.type(screen.getByLabelText('Choose a password'), 'too short');
    await userEvent.type(screen.getByLabelText('Repeat the password'), 'too short');
    await userEvent.click(screen.getByRole('button', { name: 'Join Demo OOH SRL' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('12–128 characters');

    await userEvent.type(screen.getByLabelText('Choose a password'), ' but longer');
    await userEvent.click(screen.getByRole('button', { name: 'Join Demo OOH SRL' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('do not match');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits the password and the (editable, prefilled) name', async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    render(<AcceptInvitationForm preview={preview(false)} onSubmit={onSubmit} />);
    const name = screen.getByLabelText('Your name');
    expect(name).toHaveValue('Nina New');
    await userEvent.clear(name);
    await userEvent.type(name, ' Nina Novak ');
    await userEvent.type(screen.getByLabelText('Choose a password'), 'a long enough passphrase');
    await userEvent.type(screen.getByLabelText('Repeat the password'), 'a long enough passphrase');
    await userEvent.click(screen.getByRole('button', { name: 'Join Demo OOH SRL' }));
    expect(onSubmit).toHaveBeenCalledWith({
      password: 'a long enough passphrase',
      displayName: 'Nina Novak',
    });
  });
});

describe('AcceptInvitationForm, existing account', () => {
  it('asks only for the current password', async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    render(<AcceptInvitationForm preview={preview(true)} onSubmit={onSubmit} />);
    expect(screen.queryByLabelText('Your name')).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Your current password'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Join Demo OOH SRL' }));
    expect(onSubmit).toHaveBeenCalledWith({ password: 'x' });
  });

  it.each([
    ['INVALID_CREDENTIALS', 401, 'Incorrect password'],
    ['INVITATION_INVALID', 404, 'no longer valid'],
    ['RATE_LIMITED', 429, 'Too many failed attempts'],
  ])('explains %s', async (code, status, text) => {
    const onSubmit = () =>
      Promise.reject(new ApiError(status, { code, status, title: code, type: 'x' } as never));
    render(<AcceptInvitationForm preview={preview(true)} onSubmit={onSubmit} />);
    await userEvent.type(screen.getByLabelText('Your current password'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Join Demo OOH SRL' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
  });
});
