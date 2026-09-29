import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import { RoleEditor } from './role-editor';

const checkbox = (key: string) => screen.getByText(key).closest('label')!.querySelector('input')!;

describe('RoleEditor', () => {
  it('builds grants from the catalog, with a scope choice where the permission allows several', async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    render(
      <RoleEditor
        initial={{ name: '', description: null, grants: [] }}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    await userEvent.type(screen.getByLabelText('Name'), ' Sales lead ');
    await userEvent.click(checkbox('campaign.read'));
    await userEvent.click(checkbox('opportunity.read'));
    // opportunity.read allows ALL and OWN: narrow it to the member's own records.
    await userEvent.selectOptions(screen.getByLabelText('Scope of opportunity.read'), 'OWN');
    expect(screen.queryByLabelText('Scope of roles.manage')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save role' }));

    expect(onSubmit).toHaveBeenCalledWith({
      name: 'Sales lead',
      description: null,
      grants: [
        { permission: 'campaign.read', scope: 'ALL' },
        { permission: 'opportunity.read', scope: 'OWN' },
      ],
    });
  });

  it('starts from existing grants and requires a name and at least one permission', async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    render(
      <RoleEditor
        initial={{
          name: 'Reader',
          description: 'Reads',
          grants: [{ permission: 'campaign.read', scope: 'ALL' }],
        }}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    expect(checkbox('campaign.read')).toBeChecked();
    await userEvent.click(checkbox('campaign.read'));
    await userEvent.click(screen.getByRole('button', { name: 'Save role' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('at least one permission');
    await userEvent.clear(screen.getByLabelText('Name'));
    await userEvent.click(screen.getByRole('button', { name: 'Save role' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Give the role a name');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('is read-only for system roles', () => {
    render(
      <RoleEditor
        initial={{
          name: 'Viewer',
          description: null,
          grants: [{ permission: 'campaign.read', scope: 'ALL' }],
        }}
        readOnly
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Name')).toBeDisabled();
    expect(checkbox('campaign.read')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save role' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('shows why the API refused (e.g. granting more than you hold)', async () => {
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
    render(
      <RoleEditor
        initial={{ name: 'X', description: null, grants: [{ permission: 'campaign.read', scope: 'ALL' }] }}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save role' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('cannot grant permissions');
  });
});
