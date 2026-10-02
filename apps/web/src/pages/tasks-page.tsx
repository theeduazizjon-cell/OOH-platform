import { useState } from 'react';
import { cn } from '@/lib/cn';
import { useMe } from '@/lib/me';
import { type TaskFilter, TaskList } from './task-list';

type View = 'mine' | 'unassigned' | 'everyone';

/** Tasks (docs/architecture/09-screen-map.md): my tasks / team, grouped by due date. */
export function TasksPage() {
  const { data: me } = useMe();
  const [view, setView] = useState<View>('mine');
  const [closed, setClosed] = useState(false);
  // Members who only see their own tasks (ASSIGNED scope, e.g. decorators) get no team views.
  const seesTeam = me?.permissions['task.read'] === 'ALL';
  const views: { key: View; label: string }[] = seesTeam
    ? [
        { key: 'mine', label: 'My tasks' },
        { key: 'unassigned', label: 'Unassigned' },
        { key: 'everyone', label: 'Everyone' },
      ]
    : [{ key: 'mine', label: 'My tasks' }];
  const filter: TaskFilter = {
    state: closed ? 'closed' : 'open',
    ...(view === 'mine'
      ? { assignee: 'me' as const }
      : view === 'unassigned'
        ? { assignee: 'unassigned' as const }
        : {}),
  };

  return (
    <div className="max-w-4xl space-y-4">
      <h1 className="text-xl font-semibold">Tasks</h1>
      <div className="flex flex-wrap items-center gap-3">
        {views.length > 1 && (
          <div role="tablist" aria-label="Whose tasks" className="flex gap-1 rounded-md bg-slate-100 p-1">
            {views.map((v) => (
              <button
                key={v.key}
                type="button"
                role="tab"
                aria-selected={view === v.key}
                className={cn(
                  'rounded px-3 py-1 text-sm',
                  view === v.key ? 'bg-white font-medium shadow-sm' : 'text-slate-600',
                )}
                onClick={() => setView(v.key)}
              >
                {v.label}
              </button>
            ))}
          </div>
        )}
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={closed} onChange={(e) => setClosed(e.currentTarget.checked)} />
          Show closed tasks
        </label>
      </div>
      <TaskList
        key={`${view}:${closed}`}
        filter={filter}
        canAdd={!closed}
        emptyText={
          closed ? 'No closed tasks.' : view === 'mine' ? 'Nothing on your plate.' : 'No open tasks.'
        }
      />
    </div>
  );
}
