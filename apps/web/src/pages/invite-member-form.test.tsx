import type { RoleListItem } from '@ooh/contracts';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import { InviteMemberForm } from './invite-member-form';

const role = (id: string, name: string, extra: Partial<RoleListItem> = {}): RoleListItem => ({
  id,
  key: name.toLowerCase().replace(/\W+/g, '_'),
  name,
  description: null,
  isSystem: true,
  isExternal: false,
  active: true,
  ...extra,
});

const ROLES = [
  role('r1', 'OOH Buyer'),
  role('r2', 'Viewer'),
  role('r3', 'End Client', { isExternal: true }),
  role('r4', 'Old role', { active: false }),
];

async function fill(email = 'ana@example.com', name = 'Ana') {
  await userEvent.type(screen.getByLabelText('Email'), email);
  await userEvent.type(screen.getByLabelText('Name'), name);
}

describe('InviteMemberForm', () => {
  it('offers only active internal roles', () => {
    render(<InviteMemberForm roles={ROLES} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getAllByRole('checkbox').map((c) => c.getAttribute('value'))).toEqual(['r1', 'r2']);
  });

  it('requires at least one role', async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    render(<InviteMemberForm roles={ROLES} onSubmit={onSubmit} onCancel={vi.fn()} />);
    await fill();
    await userEvent.click(screen.getByRole('button', { name: 'Create invitation' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('at least one role');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits trimmed fields and the chosen roles', async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    render(<InviteMemberForm roles={ROLES} onSubmit={onSubmit} onCancel={vi.fn()} />);
    await fill(' ana@example.com ', ' Ana Pop ');
    await userEvent.click(screen.getByLabelText('Viewer'));
    await userEvent.click(screen.getByLabelText('OOH Buyer'));
    await userEvent.click(screen.getByRole('button', { name: 'Create invitation' }));
    expect(onSubmit).toHaveBeenCalledWith({
      email: 'ana@example.com',
      displayName: 'Ana Pop',
      roleIds: ['r1', 'r2'],
    });
  });

  it('shows the API’s explanation (e.g. already invited, or granting too much)', async () => {
    const onSubmit = () =>
      Promise.reject(
        new ApiError(403, {
          code: 'FORBIDDEN',
          status: 403,
          title: 'Forbidden',
          type: 'x',
          detail: 'You cannot grant permissions you do not have yourself.',
        }),
      );
    render(<InviteMemberForm roles={ROLES} onSubmit={onSubmit} onCancel={vi.fn()} />);
    await fill();
    await userEvent.click(screen.getByLabelText('Viewer'));
    await userEvent.click(screen.getByRole('button', { name: 'Create invitation' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('cannot grant permissions');
  });
});
