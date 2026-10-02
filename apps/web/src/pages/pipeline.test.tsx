import type { ActivityTypeItem, OpportunityListItem, PipelineItem } from '@ooh/contracts';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { loggableTypes } from './activity-timeline';
import { OpportunityForm, parseAmount } from './opportunity-form';
import { ActionForm } from './opportunity-panel';
import { groupByStage, missingToWin, openStages, totalsByCurrency } from './pipeline';

const stage = (id: string, kind: 'OPEN' | 'WON' | 'LOST', position: number, active = true) => ({
  id,
  name: id,
  kind,
  position,
  probability: null,
  active,
  version: 1,
});
const pipeline: PipelineItem = {
  id: 'p1',
  name: 'Sales',
  isDefault: true,
  active: true,
  version: 1,
  stages: [
    stage('won', 'WON', 5),
    stage('offer', 'OPEN', 2),
    stage('lead', 'OPEN', 1),
    stage('retired', 'OPEN', 3, false),
    stage('lost', 'LOST', 6),
  ],
};
const opp = (id: string, stageId: string, value: string | null, currency: 'RON' | 'EUR' = 'RON') =>
  ({
    id,
    name: id,
    organisation: { id: 'o1', displayName: 'Carrefour' },
    contact: null,
    owner: { membershipId: 'm1', displayName: 'Ana' },
    stage: { id: stageId, name: stageId, kind: 'OPEN', pipelineId: 'p1' },
    estimatedValue: value,
    currency,
    expectedCloseDate: null,
    probability: null,
    nextFollowUpDate: null,
    closedAt: null,
    version: 1,
  }) satisfies OpportunityListItem;

describe('pipeline helpers', () => {
  it('shows only active OPEN stages as columns, in position order', () => {
    expect(openStages(pipeline).map((s) => s.id)).toEqual(['lead', 'offer']);
    expect(openStages(undefined)).toEqual([]);
  });

  it('groups opportunities per stage, keeping empty columns', () => {
    const columns = groupByStage(openStages(pipeline), [opp('a', 'offer', null), opp('b', 'gone', null)]);
    expect([...columns.keys()]).toEqual(['lead', 'offer']);
    expect(columns.get('lead')).toEqual([]);
    expect(columns.get('offer')?.map((o) => o.id)).toEqual(['a']);
  });

  it('never adds RON and EUR together', () => {
    const total = totalsByCurrency([
      opp('a', 'lead', '1000'),
      opp('b', 'lead', '500.5'),
      opp('c', 'lead', '20', 'EUR'),
    ]);
    expect(total).toContain('RON');
    expect(total).toContain('EUR');
    expect(total.split(' + ')).toHaveLength(2);
    expect(totalsByCurrency([opp('a', 'lead', null)])).toBe('');
  });

  it('knows what a win still needs', () => {
    expect(missingToWin({ estimatedValue: null, expectedCloseDate: '2026-10-01' })).toEqual({
      value: true,
      closeDate: false,
    });
  });

  it('parses amounts as the API expects them', () => {
    expect(parseAmount('12 500,5')).toBe('12500.50');
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('12.345')).toBeUndefined();
    expect(parseAmount('abc')).toBeUndefined();
  });

  it('only offers non-system, active activity types for logging', () => {
    const types: ActivityTypeItem[] = [
      { id: '1', key: 'call', name: 'Call', isSystem: false, active: true, sortOrder: 0, version: 1 },
      {
        id: '2',
        key: 'stage_change',
        name: 'Stage change',
        isSystem: true,
        active: true,
        sortOrder: 0,
        version: 1,
      },
      { id: '3', key: 'fax', name: 'Fax', isSystem: false, active: false, sortOrder: 0, version: 1 },
    ];
    expect(loggableTypes(types).map((t) => t.key)).toEqual(['call']);
  });
});

describe('OpportunityForm', () => {
  it('submits normalised values and refuses a malformed amount', async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    render(<OpportunityForm contacts={[]} submitLabel="Create" onSubmit={onSubmit} onCancel={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Name'), ' Spring campaign ');
    await userEvent.type(screen.getByLabelText('Estimated value (net of VAT)'), '12,3,4');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/Enter the value as a number/)).toBeInTheDocument();

    await userEvent.clear(screen.getByLabelText('Estimated value (net of VAT)'));
    await userEvent.type(screen.getByLabelText('Estimated value (net of VAT)'), '12 500');
    await userEvent.selectOptions(screen.getByLabelText('Currency'), 'EUR');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(onSubmit).toHaveBeenCalledWith({
      name: 'Spring campaign',
      contactId: null,
      estimatedValue: '12500.00',
      currency: 'EUR',
      expectedCloseDate: null,
      probability: null,
      source: null,
      nextAction: null,
      nextFollowUpDate: null,
    });
  });
});

describe('ActionForm', () => {
  it('asks only for what a win is missing', async () => {
    const onRun = vi.fn(() => Promise.resolve());
    render(
      <ActionForm
        step="win"
        opportunity={{ name: 'Deal', estimatedValue: null, expectedCloseDate: '2026-10-01' }}
        onRun={onRun}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText('Close date')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Mark as won' }));
    expect(onRun).not.toHaveBeenCalled();
    expect(screen.getByText(/needs its value/)).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Value (net of VAT)'), '9000');
    await userEvent.click(screen.getByRole('button', { name: 'Mark as won' }));
    expect(onRun).toHaveBeenCalledWith('/actions/win', { estimatedValue: '9000.00' }, 'Deal is won.');
  });

  it('confirms a win directly when value and date are set', async () => {
    const onRun = vi.fn(() => Promise.resolve());
    render(
      <ActionForm
        step="win"
        opportunity={{ name: 'Deal', estimatedValue: '10.00', expectedCloseDate: '2026-10-01' }}
        onRun={onRun}
        onCancel={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Mark as won' }));
    expect(onRun).toHaveBeenCalledWith('/actions/win', {}, 'Deal is won.');
  });

  it('requires a reason to lose or reopen', async () => {
    const onRun = vi.fn(() => Promise.resolve());
    const { unmount } = render(
      <ActionForm
        step="lose"
        opportunity={{ name: 'Deal', estimatedValue: null, expectedCloseDate: null }}
        onRun={onRun}
        onCancel={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Mark as lost' }));
    expect(onRun).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText('Why was it lost?'), 'Budget cut');
    await userEvent.click(screen.getByRole('button', { name: 'Mark as lost' }));
    expect(onRun).toHaveBeenCalledWith('/actions/lose', { lostReason: 'Budget cut' }, 'Deal is lost.');
    unmount();

    render(
      <ActionForm
        step="reopen"
        opportunity={{ name: 'Deal', estimatedValue: null, expectedCloseDate: null }}
        onRun={onRun}
        onCancel={vi.fn()}
      />,
    );
    await userEvent.type(screen.getByLabelText('Why reopen it?'), 'Client came back');
    await userEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    expect(onRun).toHaveBeenLastCalledWith(
      '/actions/reopen',
      { reason: 'Client came back' },
      'Deal is open again.',
    );
  });
});
