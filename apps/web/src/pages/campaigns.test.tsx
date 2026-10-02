import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ReasonForm, reasonRequired } from './campaign-page';
import { formatDates, progressSummary } from './campaign-status';
import { convertBody } from './convert-form';
import { LocationForm, parseWhole } from './location-form';

describe('campaign progress', () => {
  it('summarises locations, ignoring cancelled ones', () => {
    expect(
      progressSummary({ total: 7, byStatus: { LIVE: 2, RESEARCH: 2, APPROVED: 1, DRAFT: 1, CANCELLED: 1 } }),
    ).toBe('2 live · 3 in progress · 1 draft of 6');
    expect(progressSummary({ total: 2, byStatus: { ON_HOLD: 1, COMPLETED: 1 } })).toBe(
      '1 on hold · 1 completed of 2',
    );
    expect(progressSummary({ total: 0, byStatus: {} })).toBe('No locations yet');
    expect(progressSummary({ total: 2, byStatus: { CANCELLED: 2 } })).toBe('All locations cancelled');
  });

  it('formats date ranges', () => {
    expect(formatDates('2027-03-01', '2027-05-31')).toBe('2027-03-01 → 2027-05-31');
    expect(formatDates(null, '2027-05-31')).toBe('… → 2027-05-31');
    expect(formatDates(null, null)).toBe('');
  });

  it('asks for a reason to cancel anything and to hold a location', () => {
    expect(reasonRequired('campaign', 'cancel')).toBe(true);
    expect(reasonRequired('campaign', 'hold')).toBe(false);
    expect(reasonRequired('location', 'hold')).toBe(true);
    expect(reasonRequired('location', 'resume')).toBe(false);
  });
});

describe('convert body', () => {
  it('names a new campaign or picks an existing one', () => {
    expect(convertBody('new', '  Openings ', '')).toEqual({ body: { campaignName: 'Openings' } });
    expect(convertBody('new', ' ', '')).toEqual({ error: 'Give the campaign a name.' });
    expect(convertBody('existing', 'ignored', 'c1')).toEqual({ body: { campaignId: 'c1' } });
    expect(convertBody('existing', '', '')).toEqual({ error: 'Choose the campaign.' });
  });
});

describe('LocationForm', () => {
  it('parses whole numbers in range', () => {
    expect(parseWhole('', 1, 10)).toBeNull();
    expect(parseWhole(' 7 ', 1, 10)).toBe(7);
    expect(parseWhole('0', 1, 10)).toBeUndefined();
    expect(parseWhole('2.5', 1, 10)).toBeUndefined();
  });

  it('validates, then submits a store', async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    render(<LocationForm submitLabel="Add location" onSubmit={onSubmit} onCancel={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Store'), 'Carrefour Sinaia');
    await userEvent.type(screen.getByLabelText('Research radius (m)'), '10');
    await userEvent.click(screen.getByRole('button', { name: 'Add location' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/between 50 and 50 000 metres/)).toBeInTheDocument();

    await userEvent.clear(screen.getByLabelText('Research radius (m)'));
    await userEvent.type(screen.getByLabelText('City'), 'Sinaia');
    await userEvent.type(screen.getByLabelText('Units'), '7');
    await userEvent.click(screen.getByRole('button', { name: 'Add location' }));
    expect(onSubmit).toHaveBeenCalledWith({
      name: 'Carrefour Sinaia',
      address: null,
      city: 'Sinaia',
      county: null,
      startDate: null,
      endDate: null,
      requestedUnits: 7,
      researchRadiusM: null,
    });
  });
});

describe('ReasonForm', () => {
  it('requires a reason before confirming', async () => {
    const onConfirm = vi.fn(() => Promise.resolve());
    render(
      <ReasonForm
        title="Cancel campaign"
        hint="Every open location is cancelled with it."
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText('Every open location is cancelled with it.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onConfirm).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText('Reason'), 'Budget cut');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onConfirm).toHaveBeenCalledWith('Budget cut');
  });
});
