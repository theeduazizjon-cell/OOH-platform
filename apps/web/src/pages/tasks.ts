import type { TaskAction, TaskItem, TaskStatus } from '@ooh/contracts';

export type DueGroup = 'overdue' | 'today' | 'week' | 'later' | 'none' | 'closed';

export const DUE_GROUP_LABELS: Record<DueGroup, string> = {
  overdue: 'Overdue',
  today: 'Today',
  week: 'Next 7 days',
  later: 'Later',
  none: 'No due date',
  closed: 'Closed',
};
const ORDER: DueGroup[] = ['overdue', 'today', 'week', 'later', 'none', 'closed'];

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** Where an open task sits relative to `now` (local days); closed tasks are grouped apart. */
export function dueGroup(task: Pick<TaskItem, 'status' | 'dueAt'>, now: Date): DueGroup {
  if (task.status === 'DONE' || task.status === 'CANCELLED') return 'closed';
  if (!task.dueAt) return 'none';
  const due = new Date(task.dueAt);
  if (due < now) return 'overdue';
  const today = startOfDay(now);
  const days = (startOfDay(due).getTime() - today.getTime()) / 86_400_000;
  if (days < 1) return 'today';
  return days <= 7 ? 'week' : 'later';
}

/** Non-empty groups in reading order, keeping the API's due-date order inside each group. */
export function groupTasks(tasks: readonly TaskItem[], now: Date): { group: DueGroup; tasks: TaskItem[] }[] {
  const groups = new Map<DueGroup, TaskItem[]>();
  for (const t of tasks) {
    const g = dueGroup(t, now);
    groups.set(g, [...(groups.get(g) ?? []), t]);
  }
  return ORDER.filter((g) => groups.has(g)).map((group) => ({ group, tasks: groups.get(group)! }));
}

/** The actions a task offers in its status (mirrors the API's state machine). */
export function taskActions(status: TaskStatus): TaskAction[] {
  switch (status) {
    case 'OPEN':
      return ['start', 'complete', 'cancel'];
    case 'IN_PROGRESS':
      return ['complete', 'cancel'];
    default:
      return ['reopen'];
  }
}

export const ACTION_LABELS: Record<TaskAction, string> = {
  start: 'Start',
  complete: 'Done',
  cancel: 'Cancel task',
  reopen: 'Reopen',
};

export function formatDue(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** ISO instant → the value of a `datetime-local` input (local time), and back. */
export function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fromLocalInput(value: string): string | null {
  return value ? new Date(value).toISOString() : null;
}
