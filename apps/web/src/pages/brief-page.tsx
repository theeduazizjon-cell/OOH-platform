import {
  type BriefAction,
  type BriefDetail,
  type BriefLineInput,
  briefConfirmProblems,
  BRIEF_TRANSITIONS,
  etagOf,
  IF_MATCH_HEADER,
} from '@ooh/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert, Card } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api';
import { hasPermission, useMe } from '@/lib/me';
import { BriefForm } from './brief-form';
import { BriefLinesEditor } from './brief-lines-editor';
import { BriefStatusBadge } from './requests-page';

export const BRIEF_CONFLICT_MESSAGE =
  'Someone else changed this brief in the meantime. It has been reloaded; check it and try again.';

const ACTION_LABELS: Record<BriefAction, string> = {
  confirm: 'Confirm brief',
  reopen: 'Reopen',
  discard: 'Discard',
};

/** What still blocks `confirm`, in the user's words (the API checks the same rule). */
export function confirmChecklist(brief: BriefDetail): string[] {
  return briefConfirmProblems({
    clientOrganisationId: brief.client?.id ?? null,
    requestedStart: brief.requestedStart,
    requestedEnd: brief.requestedEnd,
    datesTbd: brief.datesTbd,
    lines: brief.lines,
  }).map((p) => p.message);
}

/** Brief editor (09-screen-map.md `/app/requests/:id`): details, stores, confirm / reopen / discard. */
export function BriefPage({ briefId }: { briefId: string }) {
  const { data: me } = useMe();
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);

  const opened = useQuery({
    queryKey: ['brief', briefId],
    queryFn: () => api.request<BriefDetail>(`/briefs/${briefId}`),
  });
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['briefs'] });
    await queryClient.invalidateQueries({ queryKey: ['brief', briefId] });
    await queryClient.invalidateQueries({ queryKey: ['tasks'] });
  };

  /** Changes send If-Match; on 412 the brief reloads and the error explains why. */
  async function change(b: BriefDetail, method: 'PATCH' | 'PUT' | 'POST', path: string, json: unknown) {
    try {
      await api.request<BriefDetail>(`/briefs/${b.id}${path}`, {
        method,
        json,
        headers: { [IF_MATCH_HEADER]: etagOf(b.version) },
      });
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'PRECONDITION_FAILED') {
        await refresh();
        throw new ApiError(caught.status, { ...caught.problem!, detail: BRIEF_CONFLICT_MESSAGE });
      }
      throw caught;
    }
    await refresh();
  }

  async function act(b: BriefDetail, action: BriefAction, body: object = {}) {
    setError(null);
    setNotice(null);
    try {
      await change(b, 'POST', `/actions/${action}`, body);
      setDiscarding(false);
      setNotice(
        { confirm: 'Brief confirmed.', reopen: 'Brief reopened for changes.', discard: 'Brief discarded.' }[
          action
        ],
      );
    } catch (caught) {
      if (caught instanceof ApiError && caught.problem?.errors?.length) {
        setError(caught.problem.errors.map((e) => e.message).join(' · '));
      } else {
        setError(caught instanceof ApiError ? caught.message : 'Could not reach the server. Try again.');
      }
    }
  }

  const back = (
    <Link to="/app/requests" className="text-sm text-brand-700 hover:underline">
      ← Requests
    </Link>
  );
  if (opened.isLoading) return <p className="text-sm text-slate-500">Loading…</p>;
  if (!opened.data) {
    return (
      <div className="max-w-6xl space-y-3">
        {back}
        <Alert>{opened.error?.message ?? 'Brief not found.'}</Alert>
      </div>
    );
  }
  const b = opened.data;
  const editable = b.status === 'DRAFT' && hasPermission(me, 'brief.update');
  const actions = b.actions.filter((a) => hasPermission(me, BRIEF_TRANSITIONS[a].permission));
  const missing = b.status === 'DRAFT' ? confirmChecklist(b) : [];

  return (
    <div className="max-w-6xl space-y-4">
      {back}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold">
            {b.title} <BriefStatusBadge status={b.status} />
          </h1>
          <p className="text-sm text-slate-600">
            {[
              b.client && `For ${b.client.displayName}`,
              b.agency && `via ${b.agency.displayName}`,
              `Owner: ${b.owner.displayName}`,
              b.opportunity && `From opportunity ${b.opportunity.name}`,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
          {b.discardReason && <p className="text-sm text-slate-600">Discarded: {b.discardReason}</p>}
        </div>
        <span className="flex flex-wrap gap-2">
          {actions.map((a) => (
            <Button
              key={a}
              variant={a === 'confirm' ? 'primary' : a === 'discard' ? 'ghost' : 'secondary'}
              className={a === 'discard' ? 'text-red-700' : ''}
              disabled={a === 'confirm' && missing.length > 0}
              onClick={() => (a === 'discard' ? setDiscarding(true) : void act(b, a))}
            >
              {ACTION_LABELS[a]}
            </Button>
          ))}
        </span>
      </div>

      {notice && (
        <p role="status" className="text-sm text-slate-600">
          {notice}
        </p>
      )}
      {error && <Alert>{error}</Alert>}
      {missing.length > 0 && b.actions.includes('confirm') && (
        <Card className="border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="font-medium">Before confirming:</p>
          <ul className="list-disc pl-5">
            {missing.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </Card>
      )}
      {discarding && (
        <DiscardForm
          onCancel={() => setDiscarding(false)}
          onDiscard={(reason) => act(b, 'discard', { reason })}
        />
      )}

      <Card className="p-4">
        <h2 className="mb-3 text-base font-semibold">Details</h2>
        {editable ? (
          <BriefForm
            key={`${b.id}:${b.version}`}
            initial={b}
            submitLabel="Save details"
            onSubmit={async (values) => {
              await change(b, 'PATCH', '', values);
              setNotice('Details saved.');
            }}
          />
        ) : (
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <Detail label="Campaign dates">
              {b.datesTbd ? 'Not known yet' : `${b.requestedStart ?? '…'} → ${b.requestedEnd ?? '…'}`}
            </Detail>
            <Detail label="Reply needed by">{b.deadline ?? '—'}</Detail>
            <Detail label="Budget (net of VAT)">{b.budget ? `${b.budget} ${b.currency}` : '—'}</Detail>
            <Detail label="Special requirements">{b.specialRequirements ?? '—'}</Detail>
          </dl>
        )}
      </Card>

      <Card className="p-4">
        <h2 className="mb-3 text-base font-semibold">Stores ({b.lines.length})</h2>
        <BriefLinesEditor
          key={`${b.id}:${b.version}`}
          lines={b.lines}
          editable={editable}
          onSave={async (lines: BriefLineInput[]) => {
            await change(b, 'PUT', '/lines', { lines });
            setNotice('Stores saved.');
          }}
        />
      </Card>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase text-slate-500">{label}</dt>
      <dd className="whitespace-pre-line">{children}</dd>
    </div>
  );
}

function DiscardForm({
  onDiscard,
  onCancel,
}: {
  onDiscard: (reason: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get('reason');
    const reason = typeof value === 'string' ? value.trim() : '';
    if (reason.length < 3) return setError('Say why (at least 3 characters).');
    void onDiscard(reason);
  }
  return (
    <form
      aria-label="Discard brief"
      className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3"
      onSubmit={submit}
      noValidate
    >
      {error && <Alert>{error}</Alert>}
      <div className="space-y-1.5">
        <Label htmlFor="discard-reason">Why discard this brief?</Label>
        <Input id="discard-reason" name="reason" maxLength={500} />
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Keep it
        </Button>
        <Button type="submit" className="bg-red-700 hover:bg-red-800">
          Discard brief
        </Button>
      </div>
    </form>
  );
}
