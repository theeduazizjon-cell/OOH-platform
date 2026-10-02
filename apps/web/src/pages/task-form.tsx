import {
  TASK_PRIORITIES,
  type TaskAssigneeCandidate,
  type TaskItem,
  type TaskPriority,
} from '@ooh/contracts';
import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { ApiError } from '@/lib/api';
import { fromLocalInput, toLocalInput } from './tasks';

export interface TaskFormValues {
  title: string;
  notes: string | null;
  dueAt: string | null;
  priority: TaskPriority;
  assigneeMembershipId: string | null;
}

const PRIORITY_LABELS: Record<TaskPriority, string> = { LOW: 'Low', NORMAL: 'Normal', HIGH: 'High' };

/** Title, notes, due date, priority and assignee of a task (new or open). */
export function TaskForm({
  initial,
  assignees,
  defaultAssigneeId,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: TaskItem;
  /** Undefined when the user can't list assignees: the field then keeps its current value. */
  assignees?: readonly TaskAssigneeCandidate[];
  defaultAssigneeId?: string;
  submitLabel: string;
  onSubmit: (values: TaskFormValues) => Promise<void>;
  onCancel: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const prefix = initial?.id ?? 'new-task';
  const currentAssignee = initial ? (initial.assignee?.membershipId ?? '') : (defaultAssigneeId ?? '');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const text = (name: string) => {
      const value = data.get(name);
      return typeof value === 'string' ? value.trim() : '';
    };
    if (!text('title')) return setError('Give the task a title.');
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        title: text('title'),
        notes: text('notes') || null,
        dueAt: fromLocalInput(text('dueAt')),
        priority: (text('priority') || 'NORMAL') as TaskPriority,
        assigneeMembershipId: assignees ? text('assignee') || null : currentAssignee || null,
      });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not reach the server. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  const select = 'h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm';
  return (
    <form className="space-y-3" onSubmit={(e) => void submit(e)} noValidate>
      {error && <Alert>{error}</Alert>}
      <div className="space-y-1.5">
        <Label htmlFor={`${prefix}-title`}>Task</Label>
        <Input id={`${prefix}-title`} name="title" maxLength={200} defaultValue={initial?.title ?? ''} />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor={`${prefix}-due`}>Due</Label>
          <Input
            id={`${prefix}-due`}
            name="dueAt"
            type="datetime-local"
            defaultValue={toLocalInput(initial?.dueAt ?? null)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${prefix}-priority`}>Priority</Label>
          <select
            id={`${prefix}-priority`}
            name="priority"
            className={select}
            defaultValue={initial?.priority ?? 'NORMAL'}
          >
            {TASK_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABELS[p]}
              </option>
            ))}
          </select>
        </div>
        {assignees && (
          <div className="space-y-1.5">
            <Label htmlFor={`${prefix}-assignee`}>Assigned to</Label>
            <select
              id={`${prefix}-assignee`}
              name="assignee"
              className={select}
              defaultValue={currentAssignee}
            >
              <option value="">Nobody yet</option>
              {assignees.map((a) => (
                <option key={a.membershipId} value={a.membershipId}>
                  {a.displayName}
                  {a.kind === 'EXTERNAL' ? ' (external)' : ''}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${prefix}-notes`}>Notes</Label>
        <textarea
          id={`${prefix}-notes`}
          name="notes"
          rows={2}
          maxLength={5000}
          defaultValue={initial?.notes ?? ''}
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : submitLabel}
        </Button>
      </div>
    </form>
  );
}
