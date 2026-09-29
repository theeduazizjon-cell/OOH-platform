import type { ClassificationItem, DuplicateMatch } from '@ooh/contracts';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import { CompanyForm } from './company-form';

const classification = (id: string, name: string, active = true): ClassificationItem => ({
  id,
  key: name.toLowerCase(),
  name,
  active,
  sortOrder: 0,
  version: 1,
});
const CLASSES = [
  classification('c1', 'Client'),
  classification('c2', 'Agency'),
  classification('c3', 'Old', false),
];

const duplicate = (canForce: boolean, matches: Partial<DuplicateMatch>[]) =>
  new ApiError(409, {
    code: 'DUPLICATE_SUSPECTED',
    status: 409,
    title: 'Conflict',
    type: 'x',
    meta: {
      canForce,
      matches: matches.map((m, i) => ({
        id: `m${i}`,
        displayName: 'Carrefour Romania',
        vatNumber: null,
        city: 'Bucharest',
        reason: 'NAME',
        similarity: 1,
        ...m,
      })),
    },
  });

function renderForm(onSubmit: Parameters<typeof CompanyForm>[0]['onSubmit'], onOpenExisting = vi.fn()) {
  render(
    <CompanyForm
      classifications={CLASSES}
      submitLabel="Create company"
      onSubmit={onSubmit}
      onCancel={vi.fn()}
      onOpenExisting={onOpenExisting}
    />,
  );
  return { onOpenExisting };
}

describe('CompanyForm', () => {
  it('submits the fields, active classifications only, and defaults the country', async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    renderForm(onSubmit);
    expect(screen.queryByLabelText('Old')).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Name'), ' Carrefour Romania ');
    await userEvent.type(screen.getByLabelText('VAT number (CUI)'), 'RO 11588780');
    await userEvent.click(screen.getByLabelText('Client'));
    await userEvent.click(screen.getByLabelText('Agency'));
    await userEvent.click(screen.getByRole('button', { name: 'Create company' }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: 'Carrefour Romania',
        vatNumber: 'RO 11588780',
        country: 'RO',
        legalName: null,
        classificationIds: ['c1', 'c2'],
      }),
      undefined,
    );
  });

  it('on a suspected duplicate, shows the matches and allows creating anyway with a reason', async () => {
    const onSubmit = vi
      .fn<Parameters<typeof CompanyForm>[0]['onSubmit']>()
      .mockRejectedValueOnce(duplicate(true, [{}]))
      .mockResolvedValueOnce(undefined);
    const { onOpenExisting } = renderForm(onSubmit);
    await userEvent.type(screen.getByLabelText('Name'), 'Carrefour');
    await userEvent.click(screen.getByRole('button', { name: 'Create company' }));

    const warning = await screen.findByRole('alert');
    expect(warning).toHaveTextContent('may already exist');
    expect(warning).toHaveTextContent('Carrefour Romania');
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(onOpenExisting).toHaveBeenCalledWith('m0');

    await userEvent.click(screen.getByRole('button', { name: 'Create anyway' }));
    expect(await screen.findByText(/why this is a different company/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/different company because/), 'Separate franchise in Brașov');
    await userEvent.click(screen.getByRole('button', { name: 'Create anyway' }));
    expect(onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({ displayName: 'Carrefour' }), {
      forceReason: 'Separate franchise in Brașov',
    });
  });

  it('never offers an override for an identical VAT number', async () => {
    renderForm(() => Promise.reject(duplicate(false, [{ reason: 'VAT', vatNumber: 'RO11588780' }])));
    await userEvent.type(screen.getByLabelText('Name'), 'Anything');
    await userEvent.click(screen.getByRole('button', { name: 'Create company' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('VAT number already exists');
    expect(screen.queryByRole('button', { name: 'Create anyway' })).not.toBeInTheDocument();
  });

  it('requires a name', async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    renderForm(onSubmit);
    await userEvent.click(screen.getByRole('button', { name: 'Create company' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter the company name');
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
