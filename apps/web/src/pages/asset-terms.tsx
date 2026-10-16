import {
  ASSET_ACQUISITIONS,
  type AssetDetail,
  type BlockItem,
  COST_UNITS,
  type CreateBlockRequest,
  createBlockRequestSchema,
  type CreateTermsRequest,
  createTermsRequestSchema,
  type TermsItem,
} from '@ooh/contracts';
import { type FormEvent, useState } from 'react';
import type { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import type { SendChange } from './asset-structure';
import { formatDates } from './campaign-status';
import { CompanyPicker, type PickedCompany } from './company-picker';

const ACQUISITION_LABELS: Record<(typeof ASSET_ACQUISITIONS)[number], string> = {
  DIRECT: 'Direct (we hold it)',
  SUBLEASED: 'Subleased (from a supplier)',
};
const UNIT_LABELS: Record<(typeof COST_UNITS)[number], string> = {
  MONTH: 'per month',
  DAY: 'per day',
  CAMPAIGN: 'per campaign',
};

/** The browser's calendar day as YYYY-MM-DD. */
export function today(now = new Date()): string {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

export function termsPeriod(t: Pick<TermsItem, 'validFrom' | 'validTo'>, day: string) {
  if (t.validFrom > day) return 'future' as const;
  if (t.validTo !== null && t.validTo < day) return 'past' as const;
  return 'current' as const;
}

type Parsed<T> = { body: T } | { error: string };

/** The first problem zod found, as a sentence for the form. */
function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'Check the form.';
}

const text = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
};

export function termsBody(
  form: FormData,
  owner: PickedCompany | null,
  supplier: PickedCompany | null,
): Parsed<CreateTermsRequest> {
  const parsed = createTermsRequestSchema.safeParse({
    acquisition: form.get('acquisition'),
    ownerOrganisationId: owner?.id ?? null,
    supplierOrganisationId: supplier?.id ?? null,
    costAmount: text(form, 'costAmount')?.replace(',', '.') ?? null,
    costUnit: text(form, 'costUnit'),
    currency: form.get('currency') ?? 'RON',
    validFrom: text(form, 'validFrom') ?? '',
    validTo: text(form, 'validTo'),
    contractRef: text(form, 'contractRef') ?? '',
  });
  return parsed.success ? { body: parsed.data } : { error: firstIssue(parsed.error) };
}

export function blockBody(form: FormData): Parsed<CreateBlockRequest> {
  const faceId = text(form, 'faceId');
  const parsed = createBlockRequestSchema.safeParse({
    ...(faceId ? { faceId } : {}),
    from: text(form, 'from') ?? '',
    to: text(form, 'to') ?? '',
    reason: text(form, 'reason') ?? '',
  });
  return parsed.success ? { body: parsed.data } : { error: firstIssue(parsed.error) };
}

/**
 * Terms history (owner/supplier, acquisition, cost, validity). Periods never overlap; a new one
 * starts after the current one is closed. Only holders of asset.terms.read see this.
 */
export function AssetTerms({
  asset,
  terms,
  canManage,
  send,
}: {
  asset: AssetDetail;
  terms: readonly TermsItem[];
  canManage: boolean;
  send: SendChange;
}) {
  const [adding, setAdding] = useState(false);
  const [closing, setClosing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const day = today();
  const open = asset.lifecycle !== 'DECOMMISSIONED';

  async function save(change: () => Promise<void>) {
    setError(null);
    try {
      await change();
      setAdding(false);
      setClosing(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not reach the server. Try again.');
    }
  }

  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}
      {terms.length === 0 ? (
        <p className="text-sm text-slate-500">
          No terms yet. An asset is activated once terms covering today are recorded.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-2 py-2">Period</th>
                <th className="px-2 py-2">Acquisition</th>
                <th className="px-2 py-2">Owner / supplier</th>
                <th className="px-2 py-2">Cost</th>
                <th className="px-2 py-2">Contract</th>
                <th className="px-2 py-2">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {terms.map((t) => {
                const period = termsPeriod(t, day);
                return (
                  <tr
                    key={t.id}
                    className={cn(
                      'border-b border-slate-100 align-top last:border-0',
                      period === 'past' && 'text-slate-500',
                    )}
                  >
                    <td className="whitespace-nowrap px-2 py-2">
                      {formatDates(t.validFrom, t.validTo)}
                      {period !== 'past' && (
                        <span className="block text-xs text-slate-500">
                          {period === 'current' ? 'current' : 'upcoming'}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-2">{t.acquisition === 'DIRECT' ? 'Direct' : 'Subleased'}</td>
                    <td className="px-2 py-2">
                      {t.owner && <span className="block">Owner: {t.owner.displayName}</span>}
                      {t.supplier && <span className="block">Supplier: {t.supplier.displayName}</span>}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2">
                      {t.costAmount && t.costUnit
                        ? `${t.costAmount} ${t.currency} ${UNIT_LABELS[t.costUnit]}`
                        : '—'}
                    </td>
                    <td className="px-2 py-2">{t.contractRef ?? '—'}</td>
                    <td className="px-2 py-1 text-right">
                      {canManage && open && period !== 'past' && closing !== t.id && (
                        <Button
                          variant="ghost"
                          className="h-7 px-2"
                          aria-label={`Close terms from ${t.validFrom}`}
                          onClick={() => setClosing(t.id)}
                        >
                          Close
                        </Button>
                      )}
                      {closing === t.id && (
                        <CloseTermsForm
                          terms={t}
                          defaultDay={t.validFrom > day ? t.validFrom : day}
                          onCancel={() => setClosing(null)}
                          onClose={(validTo) =>
                            save(() => send(`/terms/${t.id}/actions/close`, 'POST', { validTo }, t.version))
                          }
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {canManage && open && !adding && (
        <Button variant="secondary" className="h-8" onClick={() => setAdding(true)}>
          Add terms
        </Button>
      )}
      {adding && (
        <TermsForm
          defaultFrom={day}
          onCancel={() => setAdding(false)}
          onSubmit={(body) => save(() => send(`/assets/${asset.id}/terms`, 'POST', body))}
        />
      )}
    </div>
  );
}

function CloseTermsForm({
  terms,
  defaultDay,
  onClose,
  onCancel,
}: {
  terms: TermsItem;
  defaultDay: string;
  onClose: (validTo: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validTo = text(new FormData(event.currentTarget), 'validTo');
    if (!validTo || validTo < terms.validFrom) return setError(`Pick a day from ${terms.validFrom}.`);
    setError(null);
    void onClose(validTo);
  }
  return (
    <form className="flex flex-wrap items-end justify-end gap-2" onSubmit={submit} noValidate>
      {error && <Alert className="w-full">{error}</Alert>}
      <div className="space-y-1 text-left">
        <Label htmlFor={`close-${terms.id}`}>Last day</Label>
        <Input
          id={`close-${terms.id}`}
          name="validTo"
          type="date"
          min={terms.validFrom}
          defaultValue={defaultDay}
        />
      </div>
      <Button variant="secondary" className="h-9" onClick={onCancel}>
        Back
      </Button>
      <Button type="submit" className="h-9">
        Close terms
      </Button>
    </form>
  );
}

function TermsForm({
  defaultFrom,
  onSubmit,
  onCancel,
}: {
  defaultFrom: string;
  onSubmit: (body: CreateTermsRequest) => Promise<void>;
  onCancel: () => void;
}) {
  const [owner, setOwner] = useState<PickedCompany | null>(null);
  const [supplier, setSupplier] = useState<PickedCompany | null>(null);
  const [error, setError] = useState<string | null>(null);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = termsBody(new FormData(event.currentTarget), owner, supplier);
    if ('error' in result) return setError(result.error);
    setError(null);
    void onSubmit(result.body);
  }
  const select = 'h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm';
  return (
    <form
      aria-label="New terms"
      className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3"
      onSubmit={submit}
      noValidate
    >
      <h3 className="text-sm font-semibold">New terms</h3>
      {error && <Alert>{error}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="terms-acquisition">Acquisition</Label>
          <select id="terms-acquisition" name="acquisition" defaultValue="DIRECT" className={select}>
            {ASSET_ACQUISITIONS.map((a) => (
              <option key={a} value={a}>
                {ACQUISITION_LABELS[a]}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="terms-contract">Contract reference (optional)</Label>
          <Input id="terms-contract" name="contractRef" maxLength={200} />
        </div>
        <CompanyPicker
          id="terms-owner"
          label="Owner (optional)"
          value={owner}
          onChange={setOwner}
          {...(supplier ? { excludeId: supplier.id } : {})}
        />
        <CompanyPicker
          id="terms-supplier"
          label="Supplier (required when subleased)"
          value={supplier}
          onChange={setSupplier}
          {...(owner ? { excludeId: owner.id } : {})}
        />
        <div className="space-y-1.5">
          <Label htmlFor="terms-from">From</Label>
          <Input id="terms-from" name="validFrom" type="date" defaultValue={defaultFrom} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="terms-to">Until (optional, last day included)</Label>
          <Input id="terms-to" name="validTo" type="date" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="terms-cost">Cost (optional)</Label>
          <Input id="terms-cost" name="costAmount" inputMode="decimal" placeholder="1200" />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1.5">
            <Label htmlFor="terms-unit">Unit</Label>
            <select id="terms-unit" name="costUnit" defaultValue="" className={select}>
              <option value="">—</option>
              {COST_UNITS.map((u) => (
                <option key={u} value={u}>
                  {UNIT_LABELS[u]}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="terms-currency">Currency</Label>
            <select id="terms-currency" name="currency" defaultValue="RON" className={select}>
              <option>RON</option>
              <option>EUR</option>
            </select>
          </div>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit">Save terms</Button>
      </div>
    </form>
  );
}

/** Availability blocks (maintenance, permit issues…) on the whole asset or one face; released, not deleted. */
export function AssetBlocks({
  asset,
  canManage,
  send,
}: {
  asset: AssetDetail;
  canManage: boolean;
  send: SendChange;
}) {
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const faces = asset.mounts.flatMap((m) =>
    m.faces.map((f) => ({ id: f.id, label: `Mount ${m.positionNo} · face ${f.faceCode}` })),
  );
  const faceLabel = (block: BlockItem) =>
    block.faceId ? (faces.find((f) => f.id === block.faceId)?.label ?? 'One face') : 'Whole asset';
  const blocks = [...asset.blocks].sort(
    (a, b) => Number(a.releasedAt !== null) - Number(b.releasedAt !== null) || a.from.localeCompare(b.from),
  );
  const open = asset.lifecycle !== 'DECOMMISSIONED';

  async function save(change: () => Promise<void>) {
    setError(null);
    try {
      await change();
      setAdding(false);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not reach the server. Try again.');
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = blockBody(new FormData(event.currentTarget));
    if ('error' in result) return setError(result.error);
    void save(() => send(`/assets/${asset.id}/blocks`, 'POST', result.body));
  }

  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}
      {blocks.length === 0 ? (
        <p className="text-sm text-slate-500">No blocks.</p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
          {blocks.map((b) => (
            <li
              key={b.id}
              className={cn(
                'flex items-start justify-between gap-3 px-3 py-2 text-sm',
                b.releasedAt && 'text-slate-500',
              )}
            >
              <span>
                <span className="font-medium">{formatDates(b.from, b.to)}</span> · {faceLabel(b)}
                <span className="block text-xs">
                  {b.reason}
                  {b.releasedAt && ` · released ${b.releasedAt.slice(0, 10)}`}
                </span>
              </span>
              {canManage && !b.releasedAt && (
                <Button
                  variant="ghost"
                  className="h-7 px-2"
                  aria-label={`Release block ${formatDates(b.from, b.to)}`}
                  onClick={() => void save(() => send(`/blocks/${b.id}/actions/release`, 'POST', {}))}
                >
                  Release
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canManage && open && !adding && (
        <Button variant="secondary" className="h-8" onClick={() => setAdding(true)}>
          Block dates
        </Button>
      )}
      {adding && (
        <form
          aria-label="New block"
          className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3"
          onSubmit={submit}
          noValidate
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="block-face">What</Label>
              <select
                id="block-face"
                name="faceId"
                defaultValue=""
                className="h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
              >
                <option value="">Whole asset</option>
                {faces.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="block-from">From</Label>
              <Input id="block-from" name="from" type="date" defaultValue={today()} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="block-to">To (included)</Label>
              <Input id="block-to" name="to" type="date" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="block-reason">Reason</Label>
            <Input id="block-reason" name="reason" maxLength={500} placeholder="e.g. structure repair" />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button type="submit">Block</Button>
          </div>
        </form>
      )}
    </div>
  );
}
