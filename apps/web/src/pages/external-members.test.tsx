import type {
  AccountOwnerCandidate,
  OrganisationListItem,
  OrganisationRelationshipItem,
  RoleListItem,
} from '@ooh/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { CompanyForm } from './company-form';
import { relationshipLabel } from './company-relationships';
import { InviteMemberForm } from './invite-member-form';

const role = (id: string, name: string, isExternal: boolean): RoleListItem => ({
  id,
  key: name.toLowerCase().replace(/\W+/g, '_'),
  name,
  description: null,
  isSystem: true,
  isExternal,
  active: true,
  memberCount: 0,
  version: 1,
});
const ROLES = [
  role('r-buyer', 'OOH Buyer', false),
  role('r-client', 'End Client', true),
  role('r-agency', 'Agency User', true),
];

const withQuery = (node: ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      {node}
    </QueryClientProvider>,
  );

const company = (id: string, displayName: string): OrganisationListItem => ({
  id,
  displayName,
  legalName: null,
  vatNumber: null,
  city: 'Bucharest',
  county: null,
  country: 'RO',
  classifications: [],
  accountOwner: null,
  archivedAt: null,
  version: 1,
});

afterEach(() => vi.restoreAllMocks());

describe('InviteMemberForm, external members', () => {
  it('switches to external roles and requires the company the person represents', async () => {
    const search = vi.spyOn(api, 'request').mockResolvedValue({
      data: [company('o-carrefour', 'Carrefour Romania')],
      page: { nextCursor: null, hasMore: false },
    });
    const onSubmit = vi.fn(() => Promise.resolve());
    withQuery(<InviteMemberForm roles={ROLES} canPickCompany onSubmit={onSubmit} onCancel={vi.fn()} />);

    // Colleague by default: internal roles only.
    expect(screen.getByLabelText('OOH Buyer')).toBeInTheDocument();
    expect(screen.queryByLabelText('End Client')).not.toBeInTheDocument();

    await userEvent.click(screen.getByLabelText('Someone from a client, agency or supplier'));
    expect(screen.queryByLabelText('OOH Buyer')).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Email'), 'ana@carrefour.ro');
    await userEvent.type(screen.getByLabelText('Name'), 'Ana');
    await userEvent.click(screen.getByLabelText('End Client'));
    await userEvent.click(screen.getByRole('button', { name: 'Create invitation' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose the company');

    await userEvent.type(screen.getByLabelText('Company they represent'), 'carr');
    await userEvent.click(await screen.findByRole('option', { name: /Carrefour Romania/ }));
    expect(search).toHaveBeenCalledWith('/organisations?limit=8&q=carr');
    await userEvent.click(screen.getByRole('button', { name: 'Create invitation' }));
    expect(onSubmit).toHaveBeenCalledWith({
      email: 'ana@carrefour.ro',
      displayName: 'Ana',
      roleIds: ['r-client'],
      organisationId: 'o-carrefour',
    });
  });

  it('without CRM access, only colleagues can be invited', () => {
    withQuery(<InviteMemberForm roles={ROLES} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByLabelText('Someone from a client, agency or supplier')).not.toBeInTheDocument();
  });
});

describe('relationshipLabel', () => {
  const item = (
    kind: OrganisationRelationshipItem['kind'],
    direction: OrganisationRelationshipItem['direction'],
  ) =>
    relationshipLabel({
      id: 'x',
      kind,
      direction,
      other: { id: 'o', displayName: 'Carrefour', archived: false },
      createdAt: '',
    });

  it('reads naturally from either side', () => {
    expect(item('AGENCY_OF', 'OUTGOING')).toBe('Agency of Carrefour');
    expect(item('AGENCY_OF', 'INCOMING')).toBe('Carrefour is its agency');
    expect(item('SUPPLIER_TO', 'INCOMING')).toBe('Carrefour supplies it');
    expect(item('PARENT_OF', 'OUTGOING')).toBe('Parent of Carrefour');
  });
});

describe('CompanyForm account owner', () => {
  const OWNERS: AccountOwnerCandidate[] = [
    { membershipId: 'm-ana', displayName: 'Ana' },
    { membershipId: 'm-radu', displayName: 'Radu' },
  ];

  it('defaults to the creator ("Me") and submits a chosen owner', async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    render(
      <CompanyForm
        classifications={[]}
        accountOwners={OWNERS}
        submitLabel="Create"
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    await userEvent.type(screen.getByLabelText('Name'), 'Dedeman');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(onSubmit).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ accountOwnerMembershipId: expect.anything() as unknown }),
      undefined,
    );

    await userEvent.selectOptions(screen.getByLabelText('Account owner'), 'm-radu');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({ accountOwnerMembershipId: 'm-radu' }),
      undefined,
    );
  });
});
