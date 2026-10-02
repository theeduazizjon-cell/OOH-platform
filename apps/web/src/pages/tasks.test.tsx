import type { ActivityItem, OpportunityListItem, TaskItem } from '@ooh/contracts';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { companySummary } from './company-page';
import { taskQuery } from './task-list';
import { TaskForm } from './task-form';
import { dueGroup, fromLocalInput, groupTasks, taskActions, toLocalInput } from './tasks';

const NOW = new Date(2026, 9, 3, 12, 0); // 3 Oct 2026, 12:00 local

const task = (id: string, dueAt: Date | null, status: TaskItem['status'] = 'OPEN'): TaskItem => ({
  id,
  title: id,
  notes: null,
  status,
  priority: 'NORMAL',
  source: 'USER',
  dueAt: dueAt?.toISOString() ?? null,
  completedAt: status === 'DONE' ? NOW.toISOString() : null,
  assignee: null,
  organisation: null,
  subject: null,
  createdBy: null,
  createdAt: NOW.toISOString(),
  version: 1,
});

describe('task grouping', () => {
  it('places tasks by due date relative to now', () => {
    expect(dueGroup(task('a', new Date(2026, 9, 3, 9)), NOW)).toBe('overdue');
    expect(dueGroup(task('b', new Date(2026, 9, 3, 18)), NOW)).toBe('today');
    expect(dueGroup(task('c', new Date(2026, 9, 10, 9)), NOW)).toBe('week');
    expect(dueGroup(task('d', new Date(2026, 9, 11, 9)), NOW)).toBe('later');
    expect(dueGroup(task('e', null), NOW)).toBe('none');
    expect(dueGroup(task('f', new Date(2020, 0, 1), 'DONE'), NOW)).toBe('closed');
  });

  it('keeps the API order inside groups and drops empty groups', () => {
    const groups = groupTasks(
      [
        task('t1', new Date(2026, 9, 3, 15)),
        task('o1', new Date(2026, 9, 1)),
        task('n1', null),
        task('t2', new Date(2026, 9, 3, 16)),
      ],
      NOW,
    );
    expect(groups.map((g) => [g.group, g.tasks.map((t) => t.id)])).toEqual([
      ['overdue', ['o1']],
      ['today', ['t1', 't2']],
      ['none', ['n1']],
    ]);
  });

  it('offers the actions the state machine allows', () => {
    expect(taskActions('OPEN')).toEqual(['start', 'complete', 'cancel']);
    expect(taskActions('IN_PROGRESS')).toEqual(['complete', 'cancel']);
    expect(taskActions('DONE')).toEqual(['reopen']);
    expect(taskActions('CANCELLED')).toEqual(['reopen']);
  });

  it('round-trips datetime-local values and builds list queries', () => {
    const iso = new Date(2026, 9, 3, 9, 30).toISOString();
    expect(fromLocalInput(toLocalInput(iso))).toBe(iso);
    expect(fromLocalInput('')).toBeNull();
    expect(taskQuery({ organisationId: 'o1' })).toBe('state=open&limit=100&organisationId=o1');
    expect(taskQuery({ state: 'closed', assignee: 'me' }, 20)).toBe('state=closed&limit=20&assignee=me');
  });
});

describe('TaskForm', () => {
  const assignees = [
    { membershipId: 'm1', displayName: 'Ana', kind: 'INTERNAL' as const },
    { membershipId: 'm2', displayName: 'Install team', kind: 'EXTERNAL' as const },
  ];

  it('requires a title, then submits the values with the chosen assignee', async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    render(
      <TaskForm
        assignees={assignees}
        defaultAssigneeId="m1"
        submitLabel="Add task"
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Add task' }));
    expect(screen.getByText('Give the task a title.')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Install team (external)' })).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Task'), ' Call the client ');
    await userEvent.selectOptions(screen.getByLabelText('Priority'), 'HIGH');
    await userEvent.selectOptions(screen.getByLabelText('Assigned to'), 'm2');
    await userEvent.click(screen.getByRole('button', { name: 'Add task' }));
    expect(onSubmit).toHaveBeenCalledWith({
      title: 'Call the client',
      notes: null,
      dueAt: null,
      priority: 'HIGH',
      assigneeMembershipId: 'm2',
    });
  });

  it('keeps the current assignee when the user cannot pick one', async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    const existing = { ...task('x', null), assignee: { membershipId: 'me', displayName: 'Me' } };
    render(<TaskForm initial={existing} submitLabel="Save task" onSubmit={onSubmit} onCancel={vi.fn()} />);
    expect(screen.queryByLabelText('Assigned to')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save task' }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ assigneeMembershipId: 'me', title: 'x' }),
    );
  });
});

describe('companySummary', () => {
  const opp = (kind: 'OPEN' | 'WON', value: string, currency: 'RON' | 'EUR' = 'RON') =>
    ({ stage: { kind }, estimatedValue: value, currency }) as OpportunityListItem;

  it('counts open opportunities with per-currency value, and picks the next task and latest activity', () => {
    const summary = companySummary({
      opportunities: [opp('OPEN', '1000'), opp('OPEN', '50', 'EUR'), opp('WON', '9000')],
      tasks: [task('first', null), task('second', null)],
      activities: [{ subject: 'Latest' } as ActivityItem],
    });
    expect(summary.openOpportunities).toBe(2);
    expect(summary.won).toBe(1);
    expect(summary.pipelineValue).toContain('RON');
    expect(summary.pipelineValue).toContain('EUR');
    expect(summary.pipelineValue).not.toContain('9');
    expect(summary.nextTask?.id).toBe('first');
    expect(summary.lastActivity?.subject).toBe('Latest');
    expect(companySummary({ opportunities: [], tasks: [], activities: [] })).toMatchObject({
      openOpportunities: 0,
      pipelineValue: '',
      nextTask: null,
      lastActivity: null,
    });
  });
});
