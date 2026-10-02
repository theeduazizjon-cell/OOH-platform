import type { BriefDetail, BriefLineItem } from '@ooh/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BriefForm } from './brief-form';
import { emptyRow, rowFromLine, rowsToLines, sameLines } from './brief-lines';
import { BriefLinesEditor } from './brief-lines-editor';
import { confirmChecklist } from './brief-page';

/** The form's company pickers query the API. */
const withQueries = (node: ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      {node}
    </QueryClientProvider>,
  );

const line = (over: Partial<BriefLineItem> = {}): BriefLineItem => ({
  id: 'l1',
  position: 1,
  storeName: 'Carrefour Sinaia',
  address: null,
  city: 'Sinaia',
  county: null,
  requestedUnits: 7,
  dimension: null,
  startDate: null,
  endDate: null,
  notes: null,
  ...over,
});

const brief = (over: Partial<BriefDetail> = {}): BriefDetail => ({
  id: 'b1',
  title: 'Openings',
  status: 'DRAFT',
  source: 'MANUAL',
  client: null,
  agency: null,
  opportunity: null,
  owner: { membershipId: 'm1', displayName: 'Ana' },
  requestedStart: null,
  requestedEnd: null,
  deadline: null,
  lineCount: 0,
  aiGenerated: false,
  createdAt: '2026-10-03T00:00:00Z',
  version: 1,
  datesTbd: false,
  budget: null,
  currency: 'RON',
  specialRequirements: null,
  discardReason: null,
  confirmedAt: null,
  fieldProvenance: {},
  lines: [],
  actions: ['confirm', 'discard'],
  ...over,
});

describe('brief lines', () => {
  it('ignores blank rows, trims, and reports the first problem per store', () => {
    const ok = { ...emptyRow(), storeName: ' Sinaia ', city: 'Sinaia', requestedUnits: '7' };
    const badUnits = { ...emptyRow(), storeName: 'Brașov', requestedUnits: '2.5' };
    const noName = { ...emptyRow(), city: 'Cluj' };
    const badDates = { ...emptyRow(), storeName: 'Iași', startDate: '2027-03-10', endDate: '2027-03-01' };
    const result = rowsToLines([ok, emptyRow(), badUnits, noName, badDates]);
    expect(result.lines).toEqual([
      expect.objectContaining({ storeName: 'Sinaia', city: 'Sinaia', requestedUnits: 7, address: null }),
    ]);
    expect(result.errors).toEqual([
      'Store 2: units is a whole number.',
      'Store 3: give the store a name.',
      'Store 4: the end date is before the start date.',
    ]);
  });

  it('knows when the rows equal the saved lines', () => {
    const saved = [line()];
    expect(sameLines(saved.map(rowFromLine), saved)).toBe(true);
    expect(sameLines([{ ...rowFromLine(saved[0]!), city: 'Bușteni' }], saved)).toBe(false);
    expect(sameLines([...saved.map(rowFromLine), emptyRow()], saved)).toBe(true);
  });

  it('lists what blocks confirm', () => {
    expect(confirmChecklist(brief())).toHaveLength(3);
    expect(
      confirmChecklist(
        brief({ client: { id: 'c', displayName: 'Carrefour' }, datesTbd: true, lines: [line()] }),
      ),
    ).toEqual([]);
    expect(
      confirmChecklist(
        brief({ client: { id: 'c', displayName: 'C' }, datesTbd: true, lines: [line({ city: null })] }),
      ),
    ).toEqual(['Add at least one store with an address or a city']);
  });
});

describe('BriefLinesEditor', () => {
  it('adds a store and saves the whole list', async () => {
    const onSave = vi.fn(() => Promise.resolve());
    render(<BriefLinesEditor lines={[line()]} editable onSave={onSave} />);
    expect(screen.getByRole('button', { name: 'Stores saved' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Add store' }));
    await userEvent.type(screen.getByLabelText('Store, store 2'), 'Carrefour Brașov');
    await userEvent.type(screen.getByLabelText('City, store 2'), 'Brașov');
    await userEvent.click(screen.getByRole('button', { name: 'Save stores' }));
    expect(onSave).toHaveBeenCalledWith([
      expect.objectContaining({ storeName: 'Carrefour Sinaia' }),
      expect.objectContaining({ storeName: 'Carrefour Brașov', city: 'Brașov' }),
    ]);
  });

  it('shows problems instead of saving, and is read-only when not editable', async () => {
    const onSave = vi.fn(() => Promise.resolve());
    const { unmount } = render(<BriefLinesEditor lines={[]} editable onSave={onSave} />);
    await userEvent.type(screen.getByLabelText('Units, store 1'), '3');
    await userEvent.click(screen.getByRole('button', { name: 'Save stores' }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText('Store 1: give the store a name.')).toBeInTheDocument();
    unmount();

    render(<BriefLinesEditor lines={[line()]} editable={false} onSave={onSave} />);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText('Carrefour Sinaia')).toBeInTheDocument();
  });
});

describe('BriefForm', () => {
  it('submits normalised details; "dates not known yet" clears the dates', async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    withQueries(
      <BriefForm
        initial={brief({ requestedStart: '2027-03-01' })}
        submitLabel="Save details"
        onSubmit={onSubmit}
      />,
    );
    await userEvent.type(screen.getByLabelText('Budget (net of VAT)'), '120 000');
    await userEvent.click(screen.getByLabelText('Dates not known yet'));
    expect(screen.getByLabelText('Campaign start')).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Save details' }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Openings',
        budget: '120000.00',
        datesTbd: true,
        requestedStart: null,
        requestedEnd: null,
        clientOrganisationId: null,
      }),
    );
  });

  it('rejects dates in the wrong order', async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    withQueries(<BriefForm submitLabel="Create brief" onSubmit={onSubmit} />);
    await userEvent.type(screen.getByLabelText('Title'), 'X');
    await userEvent.type(screen.getByLabelText('Campaign start'), '2027-03-10');
    await userEvent.type(screen.getByLabelText('Campaign end'), '2027-03-01');
    await userEvent.click(screen.getByRole('button', { name: 'Create brief' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText('The end date is before the start date.')).toBeInTheDocument();
  });
});
