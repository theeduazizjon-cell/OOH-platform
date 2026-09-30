import {
  type ContactListItem,
  etagOf,
  IF_MATCH_HEADER,
  type OpportunityDetail,
  type Page,
  type PipelineItem,
  type ProblemDetails,
} from '@ooh/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert, Card } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { hasPermission, useMe } from '@/lib/me';
import { ActivityTimeline } from './activity-timeline';
import { CompanyPicker, type PickedCompany } from './company-picker';
import { OpportunityForm, parseAmount } from './opportunity-form';
import { formatMoney, missingToWin, openStages } from './pipeline';

export const OPPORTUNITY_CONFLICT_MESSAGE =
  'Someone else changed this opportunity in the meantime. It has been reloaded; check it and try again.';

export type OpportunityTarget =
  { kind: 'new'; organisation?: PickedCompany; pipelineId?: string } | { kind: 'open'; id: string };

const NO_COMPANY: ProblemDetails = {
  type: 'about:blank',
  title: 'Choose the company first.',
  status: 422,
  code: 'VALIDATION_FAILED',
};

type Step = { kind: 'win' } | { kind: 'lose' } | { kind: 'reopen' } | null;

/** Create or work one opportunity: details, stage moves, win / lose / reopen, and its timeline. */
export function OpportunityPanel({ target, onClose }: { target: OpportunityTarget; onClose: () => void }) {
  const { session } = useAuth();
  const { data: me } = useMe();
  const queryClient = useQueryClient();
  const [company, setCompany] = useState<PickedCompany | null>(
    target.kind === 'new' ? (target.organisation ?? null) : null,
  );
  const [step, setStep] = useState<Step>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const can = {
    update: hasPermission(me, 'opportunity.update'),
    close: hasPermission(me, 'opportunity.close'),
    reopen: hasPermission(me, 'opportunity.reopen'),
  };

  const opened = useQuery({
    queryKey: ['opportunity', target.kind === 'open' ? target.id : null],
    queryFn: () => api.request<OpportunityDetail>(`/opportunities/${(target as { id: string }).id}`),
    enabled: target.kind === 'open',
  });
  const opportunity = opened.data;
  const organisationId = opportunity?.organisation.id ?? company?.id;
  const pipelines = useQuery({
    queryKey: ['pipelines', session?.tenantId],
    queryFn: () => api.request<PipelineItem[]>('/config/pipelines'),
    enabled: target.kind === 'open' && hasPermission(me, 'config.read'),
  });
  const contacts = useQuery({
    queryKey: ['contacts', 'organisation', organisationId],
    queryFn: () => api.request<Page<ContactListItem>>(`/contacts?organisationId=${organisationId}&limit=100`),
    enabled: Boolean(organisationId) && hasPermission(me, 'contact.read'),
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['opportunities'] });
    await queryClient.invalidateQueries({ queryKey: ['opportunity'] });
    await queryClient.invalidateQueries({ queryKey: ['activities'] });
  };

  /** Changes send If-Match; on 412 the opportunity reloads and the error explains why. */
  async function change(o: OpportunityDetail, path: string, json: unknown) {
    try {
      await api.request<OpportunityDetail>(`/opportunities/${o.id}${path}`, {
        method: path ? 'POST' : 'PATCH',
        json,
        headers: { [IF_MATCH_HEADER]: etagOf(o.version) },
      });
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'PRECONDITION_FAILED') {
        await refresh();
        throw new ApiError(caught.status, { ...caught.problem!, detail: OPPORTUNITY_CONFLICT_MESSAGE });
      }
      throw caught;
    } finally {
      setStep(null);
    }
    await refresh();
  }

  async function act(run: () => Promise<void>, done: string) {
    setError(null);
    setNotice(null);
    try {
      await run();
      setNotice(done);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not reach the server. Try again.');
    }
  }

  if (target.kind === 'new') {
    return (
      <Card className="p-4">
        <h3 className="mb-3 text-sm font-semibold">New opportunity</h3>
        <div className="mb-4">
          <CompanyPicker id="opportunity-company" label="Company" value={company} onChange={setCompany} />
        </div>
        <OpportunityForm
          key={company?.id ?? 'none'}
          contacts={contacts.data?.data ?? []}
          submitLabel="Create opportunity"
          onSubmit={async (values) => {
            if (!company) throw new ApiError(422, NO_COMPANY);
            await api.request<OpportunityDetail>('/opportunities', {
              method: 'POST',
              json: {
                ...values,
                organisationId: company.id,
                ...(target.pipelineId ? { pipelineId: target.pipelineId } : {}),
              },
            });
            await refresh();
            onClose();
          }}
          onCancel={onClose}
        />
      </Card>
    );
  }

  const pipeline = pipelines.data?.find((p) => p.id === opportunity?.stage.pipelineId);
  const isOpen = opportunity?.stage.kind === 'OPEN';

  return (
    <Card className="p-4">
      {opened.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {opened.error && <Alert>{opened.error.message}</Alert>}
      {opportunity && (
        <>
          <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold">{opportunity.name}</h3>
              <p className="text-xs text-slate-500">
                {opportunity.organisation.displayName} · {opportunity.owner.displayName} ·{' '}
                <span className={opportunity.stage.kind === 'OPEN' ? '' : 'font-medium'}>
                  {opportunity.stage.name}
                </span>
                {opportunity.estimatedValue &&
                  ` · ${formatMoney(opportunity.estimatedValue, opportunity.currency)}`}
              </p>
              {opportunity.lostReason && (
                <p className="text-xs text-slate-600">Lost because: {opportunity.lostReason}</p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1">
              {isOpen && can.update && pipeline && (
                <select
                  aria-label="Move to stage"
                  className="h-8 rounded-md border border-slate-300 bg-white px-2 text-sm"
                  value={opportunity.stage.id}
                  onChange={(e) => {
                    const stageId = e.currentTarget.value;
                    const name = pipeline.stages.find((s) => s.id === stageId)?.name;
                    void act(
                      () => change(opportunity, '/actions/move-stage', { stageId }),
                      `Moved to ${name}.`,
                    );
                  }}
                >
                  {openStages(pipeline).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              )}
              {isOpen && can.close && (
                <>
                  <Button variant="secondary" className="h-8 px-2" onClick={() => setStep({ kind: 'win' })}>
                    Won
                  </Button>
                  <Button variant="ghost" className="h-8 px-2" onClick={() => setStep({ kind: 'lose' })}>
                    Lost
                  </Button>
                </>
              )}
              {!isOpen && can.reopen && (
                <Button variant="secondary" className="h-8 px-2" onClick={() => setStep({ kind: 'reopen' })}>
                  Reopen
                </Button>
              )}
            </div>
          </div>
          {notice && (
            <p role="status" className="mb-2 text-sm text-slate-600">
              {notice}
            </p>
          )}
          {error && <Alert className="mb-3">{error}</Alert>}
          {step && (
            <ActionForm
              key={step.kind}
              step={step.kind}
              opportunity={opportunity}
              onCancel={() => setStep(null)}
              onRun={(path, json, done) => act(() => change(opportunity, path, json), done)}
            />
          )}
          <OpportunityForm
            key={`${opportunity.id}:${opportunity.version}`}
            initial={opportunity}
            contacts={contacts.data?.data ?? []}
            readOnly={!can.update}
            submitLabel="Save opportunity"
            onSubmit={async (values) => {
              await change(opportunity, '', values);
              setNotice('Opportunity saved.');
            }}
            onCancel={onClose}
          />
          <ActivityTimeline organisationId={opportunity.organisation.id} opportunityId={opportunity.id} />
        </>
      )}
    </Card>
  );
}

/** The confirmation step of win / lose / reopen, asking only for what the action needs. */
export function ActionForm({
  step,
  opportunity,
  onRun,
  onCancel,
}: {
  step: 'win' | 'lose' | 'reopen';
  opportunity: Pick<OpportunityDetail, 'name' | 'estimatedValue' | 'expectedCloseDate'>;
  onRun: (path: string, json: unknown, done: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const missing = missingToWin(opportunity);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const text = (name: string) => {
      const value = data.get(name);
      return typeof value === 'string' ? value.trim() : '';
    };
    if (step === 'win') {
      const estimatedValue = missing.value ? parseAmount(text('estimatedValue')) : undefined;
      const expectedCloseDate = missing.closeDate ? text('expectedCloseDate') : undefined;
      if (missing.value && !estimatedValue)
        return setError('A won opportunity needs its value (net of VAT), e.g. 12500 or 12500.50.');
      if (missing.closeDate && !expectedCloseDate) return setError('A won opportunity needs its close date.');
      await onRun(
        '/actions/win',
        {
          ...(estimatedValue ? { estimatedValue } : {}),
          ...(expectedCloseDate ? { expectedCloseDate } : {}),
        },
        `${opportunity.name} is won.`,
      );
      return;
    }
    const reason = text('reason');
    if (reason.length < 3) return setError('Give a short reason (at least 3 characters).');
    if (step === 'lose') await onRun('/actions/lose', { lostReason: reason }, `${opportunity.name} is lost.`);
    else await onRun('/actions/reopen', { reason }, `${opportunity.name} is open again.`);
  }

  const title = { win: 'Mark as won', lose: 'Mark as lost', reopen: 'Reopen' }[step];
  return (
    <form
      aria-label={title}
      className="mb-4 space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3"
      onSubmit={(e) => void submit(e)}
      noValidate
    >
      <h4 className="text-sm font-semibold">{title}</h4>
      {error && <Alert>{error}</Alert>}
      {step === 'win' && !missing.value && !missing.closeDate && (
        <p className="text-sm text-slate-600">Value and close date are set; confirm the win.</p>
      )}
      {step === 'win' && missing.value && (
        <div className="space-y-1.5">
          <Label htmlFor="win-value">Value (net of VAT)</Label>
          <Input id="win-value" name="estimatedValue" inputMode="decimal" />
        </div>
      )}
      {step === 'win' && missing.closeDate && (
        <div className="space-y-1.5">
          <Label htmlFor="win-date">Close date</Label>
          <Input id="win-date" name="expectedCloseDate" type="date" />
        </div>
      )}
      {step !== 'win' && (
        <div className="space-y-1.5">
          <Label htmlFor="action-reason">{step === 'lose' ? 'Why was it lost?' : 'Why reopen it?'}</Label>
          <Input id="action-reason" name="reason" maxLength={500} />
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit">{title}</Button>
      </div>
    </form>
  );
}
