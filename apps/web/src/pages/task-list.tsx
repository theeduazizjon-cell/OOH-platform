import {
  etagOf,
  IF_MATCH_HEADER,
  type Page,
  type TaskAction,
  type TaskAssigneeCandidate,
  type TaskItem,
} from '@ooh/contracts';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/card';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { hasPermission, useMe } from '@/lib/me';
import { cn } from '@/lib/cn';
import { TaskForm, type TaskFormValues } from './task-form';
import { ACTION_LABELS, DUE_GROUP_LABELS, dueGroup, formatDue, groupTasks, taskActions } from './tasks';

export const TASK_CONFLICT_MESSAGE =
  'Someone else changed this task in the meantime. The list now shows the current state; check it and try again.';

export interface TaskFilter {
  state?: 'open' | 'closed' | 'all';
  assignee?: 'me' | 'unassigned';
  organisationId?: string;
  opportunityId?: string;
  campaignId?: string;
}

/** The task list query string for a filter (shared by the list and the 360° summary). */
export function taskQuery(filter: TaskFilter, limit = 100): string {
  const params = new URLSearchParams({ state: filter.state ?? 'open', limit: String(limit) });
  if (filter.assignee) params.set('assignee', filter.assignee);
  if (filter.organisationId) params.set('organisationId', filter.organisationId);
  if (filter.opportunityId) params.set('opportunityId', filter.opportunityId);
  if (filter.campaignId) params.set('campaignId', filter.campaignId);
  return params.toString();
}

/**
 * Tasks grouped by due date, with their actions (If-Match; a 412 reloads and explains), inline edit
 * and "New task". A company or opportunity filter also becomes the subject of new tasks.
 */
export function TaskList({
  filter,
  title,
  canAdd = true,
  emptyText = 'No tasks.',
  showSubject = true,
}: {
  filter: TaskFilter;
  title?: string;
  canAdd?: boolean;
  emptyText?: string;
  showSubject?: boolean;
}) {
  const { session } = useAuth();
  const { data: me } = useMe();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canCreate = hasPermission(me, 'task.create');
  const canUpdate = hasPermission(me, 'task.update');

  const tasks = useQuery({
    queryKey: ['tasks', taskQuery(filter)],
    queryFn: () => api.request<Page<TaskItem>>(`/tasks?${taskQuery(filter)}`),
    enabled: hasPermission(me, 'task.read'),
  });
  const assignees = useQuery({
    queryKey: ['task-assignees', session?.tenantId],
    queryFn: () => api.request<TaskAssigneeCandidate[]>('/tasks/assignees'),
    enabled: canCreate && (adding || editing !== null),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['tasks'] });

  /** Changes send If-Match; on 412 the list reloads and the error explains why. */
  async function change(task: TaskItem, path: string, json?: unknown) {
    try {
      await api.request<TaskItem>(`/tasks/${task.id}${path}`, {
        method: path ? 'POST' : 'PATCH',
        ...(json === undefined ? {} : { json }),
        headers: { [IF_MATCH_HEADER]: etagOf(task.version) },
      });
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'PRECONDITION_FAILED') {
        await refresh();
        throw new ApiError(caught.status, { ...caught.problem!, detail: TASK_CONFLICT_MESSAGE });
      }
      throw caught;
    }
    await refresh();
  }

  async function act(task: TaskItem, action: TaskAction) {
    setError(null);
    try {
      await change(task, `/actions/${action}`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not reach the server. Try again.');
    }
  }

  async function create(values: TaskFormValues) {
    await api.request<TaskItem>('/tasks', {
      method: 'POST',
      json: {
        title: values.title,
        ...(values.notes ? { notes: values.notes } : {}),
        ...(values.dueAt ? { dueAt: values.dueAt } : {}),
        priority: values.priority,
        assigneeMembershipId: values.assigneeMembershipId,
        ...(filter.opportunityId
          ? { opportunityId: filter.opportunityId }
          : filter.organisationId
            ? { organisationId: filter.organisationId }
            : {}),
      },
    });
    setAdding(false);
    await refresh();
  }

  if (!hasPermission(me, 'task.read')) return null;
  const now = new Date();
  const groups = groupTasks(tasks.data?.data ?? [], now);

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        {title && <h3 className="text-sm font-semibold">{title}</h3>}
        {canAdd && canCreate && !adding && (
          <Button variant="secondary" className="ml-auto h-8" onClick={() => setAdding(true)}>
            New task
          </Button>
        )}
      </div>
      {adding && (
        <div className="rounded-md border border-slate-200 p-3">
          <TaskForm
            assignees={assignees.data}
            defaultAssigneeId={me?.membership.id}
            submitLabel="Add task"
            onSubmit={create}
            onCancel={() => setAdding(false)}
          />
        </div>
      )}
      {error && <Alert>{error}</Alert>}
      {tasks.error && <p className="text-sm text-red-700">{tasks.error.message}</p>}
      {tasks.data && groups.length === 0 && <p className="text-sm text-slate-500">{emptyText}</p>}
      {groups.map(({ group, tasks: items }) => (
        <div key={group} className="space-y-1">
          <h4
            className={cn(
              'text-xs font-semibold uppercase',
              group === 'overdue' ? 'text-red-700' : 'text-slate-500',
            )}
          >
            {DUE_GROUP_LABELS[group]} ({items.length})
          </h4>
          <ul className="divide-y divide-slate-100 rounded-md border border-slate-200 bg-white">
            {items.map((t) => (
              <li key={t.id} className="px-3 py-2 text-sm">
                {editing === t.id ? (
                  <TaskForm
                    initial={t}
                    assignees={canCreate ? assignees.data : undefined}
                    submitLabel="Save task"
                    onSubmit={async (values) => {
                      await change(t, '', values);
                      setEditing(null);
                    }}
                    onCancel={() => setEditing(null)}
                  />
                ) : (
                  <TaskRow
                    task={t}
                    overdue={dueGroup(t, now) === 'overdue'}
                    showSubject={showSubject}
                    canUpdate={canUpdate}
                    onEdit={() => setEditing(t.id)}
                    onAction={(action) => void act(t, action)}
                  />
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {tasks.data?.page.hasMore && (
        <p className="text-xs text-slate-500">
          Showing the first 100 tasks; narrow the view to see the rest.
        </p>
      )}
    </section>
  );
}

function TaskRow({
  task: t,
  overdue,
  showSubject,
  canUpdate,
  onEdit,
  onAction,
}: {
  task: TaskItem;
  overdue: boolean;
  showSubject: boolean;
  canUpdate: boolean;
  onEdit: () => void;
  onAction: (action: TaskAction) => void;
}) {
  const closed = t.status === 'DONE' || t.status === 'CANCELLED';
  return (
    <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
      <div className="min-w-48 flex-1">
        <p className={cn('font-medium', closed && 'text-slate-400 line-through')}>
          {t.title}
          {t.priority === 'HIGH' && <span className="ml-2 text-xs font-semibold text-red-700">High</span>}
          {t.status === 'IN_PROGRESS' && <span className="ml-2 text-xs text-brand-700">In progress</span>}
          {t.source === 'SYSTEM' && <span className="ml-2 text-xs text-slate-500">automatic</span>}
        </p>
        <p className="text-xs text-slate-500">
          {t.dueAt && (
            <span className={overdue ? 'font-medium text-red-700' : ''}>Due {formatDue(t.dueAt)}</span>
          )}
          {t.dueAt && ' · '}
          {t.assignee ? t.assignee.displayName : 'Unassigned'}
          {showSubject && t.campaign && (
            <>
              {' · '}
              <Link
                to="/app/campaigns/$campaignId"
                params={{ campaignId: t.campaign.id }}
                className="text-brand-700 hover:underline"
              >
                {t.subject?.type === 'campaign_location'
                  ? `${t.subject.name} (${t.campaign.code})`
                  : `${t.campaign.code} · ${t.campaign.name}`}
              </Link>
            </>
          )}
          {showSubject && !t.campaign && t.organisation && (
            <>
              {' · '}
              <Link
                to="/app/crm/companies/$companyId"
                params={{ companyId: t.organisation.id }}
                className="text-brand-700 hover:underline"
              >
                {t.subject?.type === 'opportunity'
                  ? `${t.subject.name} (${t.organisation.displayName})`
                  : t.organisation.displayName}
              </Link>
            </>
          )}
        </p>
        {t.notes && <p className="whitespace-pre-line text-xs text-slate-600">{t.notes}</p>}
      </div>
      {canUpdate && (
        <span className="flex flex-wrap gap-1">
          {taskActions(t.status).map((action) => (
            <Button
              key={action}
              variant={action === 'complete' ? 'secondary' : 'ghost'}
              className="h-7 px-2"
              aria-label={`${ACTION_LABELS[action]}: ${t.title}`}
              onClick={() => onAction(action)}
            >
              {ACTION_LABELS[action]}
            </Button>
          ))}
          {!closed && (
            <Button variant="ghost" className="h-7 px-2" aria-label={`Edit: ${t.title}`} onClick={onEdit}>
              Edit
            </Button>
          )}
        </span>
      )}
    </div>
  );
}
