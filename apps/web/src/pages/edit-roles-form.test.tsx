import type { MembershipListItem, RoleListItem } from '@ooh/contracts';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import { EditRolesForm } from './edit-roles-form';

const role = (id: string, name: string, extra: Partial<RoleListItem> = {}): RoleListItem => ({
  id,
  key: name.toLowerCase(),
  name,
  description: null,
  isSystem: true,
  isExternal: false,
  active: true,
  ...extra,
});
const ROLES = [role('r1', 'Buyer'), role('r2', 'Viewer'), role('r3', 'Client', { isExternal: true })];

const member: MembershipListItem = {
  id: 'm1',
  userId: 'u1',
  displayName: 'Ana',
  email: 'ana@example.com',
  kind: 'INTERNAL',
  status: 'ACTIVE',
  roles: [{ id: 'r1', key: 'buyer', name: 'Buyer' }],
  invitation: null,
  version: 1,
};

describe('EditRolesForm', () => {
  it('starts from the member’s current roles and submits the new selection', async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    render(<EditRolesForm member={member} roles={ROLES} onSubmit={onSubmit} onCancel={vi.fn()} />);
    expect(screen.getByLabelText('Buyer')).toBeChecked();
    expect(screen.getByLabelText('Viewer')).not.toBeChecked();
    expect(screen.queryByLabelText('Client')).not.toBeInTheDocument();

    await userEvent.click(screen.getByLabelText('Buyer'));
    await userEvent.click(screen.getByLabelText('Viewer'));
    await userEvent.click(screen.getByRole('button', { name: 'Save roles' }));
    expect(onSubmit).toHaveBeenCalledWith(['r2']);
  });

  it('refuses an empty selection and points to suspension instead', async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    render(<EditRolesForm member={member} roles={ROLES} onSubmit={onSubmit} onCancel={vi.fn()} />);
    await userEvent.click(screen.getByLabelText('Buyer'));
    await userEvent.click(screen.getByRole('button', { name: 'Save roles' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('suspend the member instead');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows why the API refused (e.g. the member holds more than the editor)', async () => {
    const onSubmit = () =>
      Promise.reject(
        new ApiError(403, {
          code: 'FORBIDDEN',
          status: 403,
          title: 'Forbidden',
          type: 'x',
          detail: 'This member has permissions you do not have, so you cannot manage them.',
        }),
      );
    render(<EditRolesForm member={member} roles={ROLES} onSubmit={onSubmit} onCancel={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Save roles' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('cannot manage them');
  });
});
