import {
  type ActivityTypeItem,
  type ClassificationItem,
  etagOf,
  IF_MATCH_HEADER,
  type Page,
  type PipelineItem,
  type PipelineStageItem,
} from '@ooh/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert, Card } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { hasPermission, useMe } from '@/lib/me';
import { AdminTabs } from './admin-tabs';

export const NOMENCLATURE_CONFLICT_MESSAGE =
  'Someone else changed this in the meantime. The list now shows the current state; check it and try again.';

/** The order after moving the item at `index` by `delta` places (unchanged at the ends). */
export function moveInOrder(ids: readonly string[], index: number, delta: -1 | 1): string[] {
  const target = index + delta;
  if (index < 0 || index >= ids.length || target < 0 || target >= ids.length) return [...ids];
  const next = [...ids];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

/** "" → null, "40" → 40, anything else → undefined (invalid). */
export function parseProbability(input: string): number | null | undefined {
  const text = input.trim();
  if (!text) return null;
  const value = Number(text);
  return Number.isInteger(value) && value >= 0 && value <= 100 ? value : undefined;
}

/** Which row is being edited: an entry id, or NEW for the add form. */
const NEW = 'new';

function field(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function message(caught: unknown): string {
  return caught instanceof ApiError ? caught.message : 'Could not reach the server. Try again.';
}

/**
 * Admin → Nomenclatures (docs/architecture/09-screen-map.md): pipeline stages, activity types and
 * company classifications. Entries are disabled rather than deleted, so history keeps its names.
 */
export function NomenclaturesPage() {
  const { session } = useAuth();
  const { data: me } = useMe();
  const queryClient = useQueryClient();
  const canManage = hasPermission(me, 'config.manage');

  const pipelines = useQuery({
    queryKey: ['pipelines', session?.tenantId],
    queryFn: () => api.request<PipelineItem[]>('/config/pipelines'),
  });
  const types = useQuery({
    queryKey: ['activity-types', session?.tenantId],
    queryFn: () => api.request<ActivityTypeItem[]>('/config/activity-types'),
  });
  const classifications = useQuery({
    queryKey: ['classifications', session?.tenantId],
    queryFn: () => api.request<Page<ClassificationItem>>('/config/classifications'),
  });

  const refresh = () =>
    Promise.all(
      ['pipelines', 'activity-types', 'classifications'].map((key) =>
        queryClient.invalidateQueries({ queryKey: [key] }),
      ),
    );

  /** Writes; changes to existing entries send If-Match, and a 412 reloads before explaining. */
  async function write(path: string, method: 'POST' | 'PATCH' | 'PUT', json: unknown, version?: number) {
    try {
      await api.request(path, {
        method,
        json,
        ...(version === undefined ? {} : { headers: { [IF_MATCH_HEADER]: etagOf(version) } }),
      });
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'PRECONDITION_FAILED') {
        await refresh();
        throw new ApiError(caught.status, { ...caught.problem!, detail: NOMENCLATURE_CONFLICT_MESSAGE });
      }
      throw caught;
    }
    await refresh();
  }

  return (
    <div className="max-w-4xl space-y-4">
      <AdminTabs />
      <div>
        <h1 className="text-xl font-semibold">Nomenclatures</h1>
        <p className="text-sm text-slate-600">
          Disabled entries stay on existing records but are no longer offered for new ones.
          {!canManage && ' You can view these lists but not change them.'}
        </p>
      </div>

      {pipelines.error && <Alert>{pipelines.error.message}</Alert>}
      {pipelines.data
        ?.filter((p) => p.active)
        .map((p) => (
          <PipelineStages key={p.id} pipeline={p} canManage={canManage} write={write} />
        ))}

      <NameList
        title="Activity types"
        hint="What people can log on a company timeline. Platform types are written automatically."
        addLabel="Add type"
        items={types.data}
        error={types.error}
        canManage={canManage}
        onCreate={(name) => write('/config/activity-types', 'POST', { name })}
        onUpdate={(item, patch) => write(`/config/activity-types/${item.id}`, 'PATCH', patch, item.version)}
      />
      <NameList
        title="Company classifications"
        hint="How companies are tagged (client, agency, supplier…). A company can have several."
        addLabel="Add classification"
        items={classifications.data?.data}
        error={classifications.error}
        canManage={canManage}
        onCreate={(name) => write('/config/classifications', 'POST', { name })}
        onUpdate={(item, patch) => write(`/config/classifications/${item.id}`, 'PATCH', patch, item.version)}
      />
    </div>
  );
}

type Write = (
  path: string,
  method: 'POST' | 'PATCH' | 'PUT',
  json: unknown,
  version?: number,
) => Promise<void>;

/** One pipeline: open stages in board order (reorderable), then Won and Lost. */
function PipelineStages({
  pipeline,
  canManage,
  write,
}: {
  pipeline: PipelineItem;
  canManage: boolean;
  write: Write;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open = pipeline.stages.filter((s) => s.kind === 'OPEN');
  const closing = pipeline.stages.filter((s) => s.kind !== 'OPEN');

  async function run(action: () => Promise<void>) {
    setError(null);
    try {
      await action();
      setEditing(null);
    } catch (caught) {
      setError(message(caught));
    }
  }
  const move = (index: number, delta: -1 | 1) =>
    run(() =>
      write(
        `/config/pipelines/${pipeline.id}/stage-order`,
        'PUT',
        {
          stageIds: moveInOrder(
            open.map((s) => s.id),
            index,
            delta,
          ),
        },
        pipeline.version,
      ),
    );

  const row = (stage: PipelineStageItem, index?: number) => (
    <li key={stage.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
      {canManage && editing === stage.id ? (
        <StageEditor
          stage={stage}
          onCancel={() => setEditing(null)}
          onSave={(patch) => run(() => write(`/config/stages/${stage.id}`, 'PATCH', patch, stage.version))}
        />
      ) : (
        <>
          <span className={stage.active ? 'font-medium' : 'text-slate-400 line-through'}>{stage.name}</span>
          <span className="text-xs text-slate-500">
            {stage.kind === 'OPEN' ? 'open' : stage.kind === 'WON' ? 'outcome: won' : 'outcome: lost'}
            {stage.probability !== null && ` · ${stage.probability}%`}
            {!stage.active && ' · disabled'}
          </span>
          {canManage && (
            <span className="ml-auto flex gap-1">
              {index !== undefined && (
                <>
                  <Button
                    variant="ghost"
                    className="h-7 px-2"
                    aria-label={`Move ${stage.name} up`}
                    disabled={index === 0}
                    onClick={() => void move(index, -1)}
                  >
                    ↑
                  </Button>
                  <Button
                    variant="ghost"
                    className="h-7 px-2"
                    aria-label={`Move ${stage.name} down`}
                    disabled={index === open.length - 1}
                    onClick={() => void move(index, 1)}
                  >
                    ↓
                  </Button>
                </>
              )}
              <Button variant="ghost" className="h-7 px-2" onClick={() => setEditing(stage.id)}>
                Edit
              </Button>
              {stage.kind === 'OPEN' && (
                <Button
                  variant="ghost"
                  className="h-7 px-2"
                  onClick={() =>
                    void run(() =>
                      write(`/config/stages/${stage.id}`, 'PATCH', { active: !stage.active }, stage.version),
                    )
                  }
                >
                  {stage.active ? 'Disable' : 'Enable'}
                </Button>
              )}
            </span>
          )}
        </>
      )}
    </li>
  );

  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Pipeline stages · {pipeline.name}</h2>
          <p className="text-xs text-slate-500">
            Open stages are the board columns, in this order. Every pipeline ends with Won and Lost.
          </p>
        </div>
        {canManage && editing !== NEW && (
          <Button variant="secondary" className="h-8" onClick={() => setEditing(NEW)}>
            Add stage
          </Button>
        )}
      </div>
      {error && <Alert className="mb-2">{error}</Alert>}
      {canManage && editing === NEW && (
        <div className="mb-2 rounded-md border border-slate-200 p-3">
          <StageEditor
            onCancel={() => setEditing(null)}
            onSave={(patch) => run(() => write(`/config/pipelines/${pipeline.id}/stages`, 'POST', patch))}
          />
        </div>
      )}
      <ol className="divide-y divide-slate-100 rounded-md border border-slate-200">
        {open.map((s, i) => row(s, i))}
        {closing.map((s) => row(s))}
      </ol>
    </Card>
  );
}

/** Name and default probability of a stage (new or existing). */
export function StageEditor({
  stage,
  onSave,
  onCancel,
}: {
  stage?: PipelineStageItem;
  onSave: (patch: { name: string; probability: number | null }) => Promise<void>;
  onCancel: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const prefix = stage?.id ?? 'new-stage';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = field(data, 'name');
    const probability = parseProbability(field(data, 'probability'));
    if (!name) return setError('Give the stage a name.');
    if (probability === undefined) return setError('Probability is a whole percentage between 0 and 100.');
    setError(null);
    await onSave({ name, probability });
  }

  return (
    <form className="flex w-full flex-wrap items-end gap-2" onSubmit={(e) => void submit(e)} noValidate>
      {error && <Alert className="w-full">{error}</Alert>}
      <div className="min-w-40 flex-1 space-y-1">
        <Label htmlFor={`${prefix}-name`}>Stage name</Label>
        <Input id={`${prefix}-name`} name="name" maxLength={60} defaultValue={stage?.name ?? ''} />
      </div>
      <div className="w-32 space-y-1">
        <Label htmlFor={`${prefix}-probability`}>Probability (%)</Label>
        <Input
          id={`${prefix}-probability`}
          name="probability"
          type="number"
          min={0}
          max={100}
          defaultValue={stage?.probability ?? ''}
        />
      </div>
      <Button variant="secondary" onClick={onCancel}>
        Cancel
      </Button>
      <Button type="submit">{stage ? 'Save' : 'Add stage'}</Button>
    </form>
  );
}

interface NamedItem {
  id: string;
  name: string;
  active: boolean;
  version: number;
  isSystem?: boolean;
}

/** A simple name list: add, rename, disable/enable. Platform (system) entries are read-only. */
export function NameList({
  title,
  hint,
  addLabel,
  items,
  error: loadError,
  canManage,
  onCreate,
  onUpdate,
}: {
  title: string;
  hint: string;
  addLabel: string;
  items: readonly NamedItem[] | undefined;
  error?: Error | null;
  canManage: boolean;
  onCreate: (name: string) => Promise<void>;
  onUpdate: (item: NamedItem, patch: { name?: string; active?: boolean }) => Promise<void>;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>) {
    setError(null);
    try {
      await action();
      setEditing(null);
    } catch (caught) {
      setError(message(caught));
    }
  }
  function submitName(event: FormEvent<HTMLFormElement>, save: (name: string) => Promise<void>) {
    event.preventDefault();
    const name = field(new FormData(event.currentTarget), 'name');
    if (!name) return setError('Enter a name.');
    void run(() => save(name));
  }
  const nameForm = (id: string, initial: string, save: (name: string) => Promise<void>, label: string) => (
    <form className="flex w-full flex-wrap items-end gap-2" onSubmit={(e) => submitName(e, save)} noValidate>
      <div className="min-w-40 flex-1 space-y-1">
        <Label htmlFor={id}>Name</Label>
        <Input id={id} name="name" maxLength={60} defaultValue={initial} />
      </div>
      <Button variant="secondary" onClick={() => setEditing(null)}>
        Cancel
      </Button>
      <Button type="submit">{label}</Button>
    </form>
  );

  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{title}</h2>
          <p className="text-xs text-slate-500">{hint}</p>
        </div>
        {canManage && editing !== NEW && (
          <Button variant="secondary" className="h-8" onClick={() => setEditing(NEW)}>
            {addLabel}
          </Button>
        )}
      </div>
      {(error || loadError) && <Alert className="mb-2">{error ?? loadError?.message}</Alert>}
      {canManage && editing === NEW && (
        <div className="mb-2 rounded-md border border-slate-200 p-3">
          {nameForm(`${title}-new`, '', onCreate, addLabel)}
        </div>
      )}
      <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
        {items?.map((item) => (
          <li key={item.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
            {canManage && editing === item.id ? (
              nameForm(item.id, item.name, (name) => onUpdate(item, { name }), 'Save')
            ) : (
              <>
                <span className={item.active ? 'font-medium' : 'text-slate-400 line-through'}>
                  {item.name}
                </span>
                {item.isSystem && <span className="text-xs text-slate-500">platform</span>}
                {!item.active && <span className="text-xs text-slate-500">disabled</span>}
                {canManage && !item.isSystem && (
                  <span className="ml-auto flex gap-1">
                    <Button variant="ghost" className="h-7 px-2" onClick={() => setEditing(item.id)}>
                      Rename
                    </Button>
                    <Button
                      variant="ghost"
                      className="h-7 px-2"
                      onClick={() => void run(() => onUpdate(item, { active: !item.active }))}
                    >
                      {item.active ? 'Disable' : 'Enable'}
                    </Button>
                  </span>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
