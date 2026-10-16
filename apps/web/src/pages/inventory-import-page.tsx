import {
  type AssetTypeItem,
  IMPORT_MAX_ROWS,
  type ImportPreview,
  type ImportResult,
  type ImportRow,
  type ImportRowStatus,
} from '@ooh/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type ChangeEvent, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert, Card } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useAssetTypes } from './asset-status';

export const ROW_STATUS_LABELS: Record<ImportRowStatus, string> = {
  READY: 'Ready',
  DUPLICATE: 'Possible duplicate',
  EXISTS: 'Already imported',
  ERROR: 'Needs fixing',
};

const STATUS_STYLES: Record<ImportRowStatus, string> = {
  READY: 'bg-emerald-50 text-emerald-800',
  DUPLICATE: 'bg-amber-50 text-amber-800',
  EXISTS: 'bg-slate-100 text-slate-600',
  ERROR: 'bg-red-50 text-red-800',
};

/**
 * File bytes as text: UTF-8 when valid, otherwise Windows-1250 (what Excel writes for "CSV" on
 * Romanian Windows), so ă/ș/ț survive either way.
 */
export function decodeCsv(bytes: ArrayBuffer): { text: string; encoding: 'utf-8' | 'windows-1250' } {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('windows-1250').decode(bytes), encoding: 'windows-1250' };
  }
}

/** A file's bytes (FileReader: works everywhere, including test DOMs without Blob.arrayBuffer). */
function readBytes(file: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read.'));
    reader.readAsArrayBuffer(file);
  });
}

/** A template with every recognised column and one example row per active type. */
export function templateCsv(types: readonly AssetTypeItem[]): string {
  const active = types.filter((t) => t.active);
  const attributeKeys = [...new Set(active.flatMap((t) => Object.keys(t.attributeSchema)))];
  const header = ['ref', 'type', 'lat', 'lng', 'address', 'city', 'county', 'notes', ...attributeKeys];
  const rows = active.map((t, i) => [
    `OLD-${i + 1}`,
    t.key,
    (45.35 + i / 1000).toFixed(5),
    '25.55000',
    '',
    '',
    '',
    '',
    ...attributeKeys.map(() => ''),
  ]);
  return [header, ...rows].map((r) => r.join(',')).join('\r\n') + '\r\n';
}

/** Rows to send as skipRows: every row not chosen (ERROR and EXISTS rows can't be chosen). */
export function skippedLines(rows: readonly ImportRow[], chosen: ReadonlySet<number>): number[] {
  return rows.filter((r) => !chosen.has(r.line)).map((r) => r.line);
}

const importable = (r: ImportRow) => r.status === 'READY' || r.status === 'DUPLICATE';

/** Inventory CSV import (11-mvp-scope.md): preview every row, choose, then import all or nothing. */
export function InventoryImportPage() {
  const queryClient = useQueryClient();
  const types = useAssetTypes();
  const [file, setFile] = useState<{ name: string; csv: string; encoding: string } | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [reason, setReason] = useState('');
  const [filter, setFilter] = useState<ImportRowStatus | 'ALL'>('ALL');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const chosenDuplicates = useMemo(
    () => preview?.rows.filter((r) => r.status === 'DUPLICATE' && chosen.has(r.line)).length ?? 0,
    [preview, chosen],
  );
  const visible = preview?.rows.filter((r) => filter === 'ALL' || r.status === filter) ?? [];

  async function check(csv: string) {
    setBusy(true);
    setError(null);
    try {
      const next = await api.request<ImportPreview>('/assets/import/preview', {
        method: 'POST',
        json: { csv },
      });
      setPreview(next);
      setChosen(new Set(next.rows.filter((r) => r.status === 'READY').map((r) => r.line)));
      setFilter('ALL');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function choose(event: ChangeEvent<HTMLInputElement>) {
    const picked = event.currentTarget.files?.[0];
    if (!picked) return;
    const { text, encoding } = decodeCsv(await readBytes(picked));
    setFile({ name: picked.name, csv: text, encoding });
    setResult(null);
    setReason('');
    await check(text);
  }

  async function runImport() {
    if (!file || !preview) return;
    setBusy(true);
    setError(null);
    try {
      const done = await api.request<ImportResult>('/assets/import', {
        method: 'POST',
        json: {
          csv: file.csv,
          skipRows: skippedLines(preview.rows, chosen),
          ...(chosenDuplicates > 0 ? { duplicateReason: reason } : {}),
        },
      });
      setResult(done);
      setPreview(null);
      await queryClient.invalidateQueries({ queryKey: ['assets'] });
    } catch (e) {
      // The inventory may have changed since the preview: show why and check the file again.
      setError((e as Error).message);
      await check(file.csv);
    } finally {
      setBusy(false);
    }
  }

  function toggle(line: number) {
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(line)) next.delete(line);
      else next.add(line);
      return next;
    });
  }

  function downloadTemplate() {
    const url = URL.createObjectURL(new Blob([templateCsv(types.data ?? [])], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'inventory-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="max-w-6xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link to="/app/inventory" className="text-sm text-brand-700 hover:underline">
            ← Inventory
          </Link>
          <h1 className="text-xl font-semibold">Import assets from CSV</h1>
        </div>
        <Button variant="secondary" onClick={downloadTemplate} disabled={!types.data}>
          Download template
        </Button>
      </div>

      <Card className="space-y-2 p-4 text-sm">
        <p>
          Save your Excel sheet as CSV. Needed: a <strong>type</strong> column (name, key or code prefix of an
          asset type) and <strong>lat</strong> + <strong>lng</strong> columns, or one{' '}
          <strong>coordinates</strong> column (“45.3486, 25.5517” or a Google Maps link). Optional: ref (the
          code in your old system: rows already imported are skipped), address, city, county, notes, and one
          column per attribute. Romanian headers and decimal commas work. At most {IMPORT_MAX_ROWS} rows per
          file.
        </p>
        <Label htmlFor="csv-file">CSV file</Label>
        <input
          id="csv-file"
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => void choose(e)}
          disabled={busy}
          className="block text-sm"
        />
        {file && (
          <p className="text-xs text-slate-500">
            {file.name}
            {file.encoding === 'windows-1250' && ' · read as Windows-1250 (not UTF-8)'}
          </p>
        )}
      </Card>

      {error && <Alert>{error}</Alert>}
      {busy && <p className="text-sm text-slate-500">Checking…</p>}

      {result && (
        <Card className="space-y-2 p-4">
          <p className="font-medium">
            Imported {result.created.length} asset{result.created.length === 1 ? '' : 's'}
            {result.skipped.length > 0 &&
              `, skipped ${result.skipped.length} row${result.skipped.length === 1 ? '' : 's'}`}
            .
          </p>
          <p className="text-sm text-slate-600">
            They start as prospective: add terms and a photo to activate them.
          </p>
          <ul className="flex flex-wrap gap-2 text-sm">
            {result.created.map((c) => (
              <li key={c.id}>
                <Link
                  to="/app/inventory/$assetId"
                  params={{ assetId: c.id }}
                  className="text-brand-700 hover:underline"
                >
                  {c.code}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {preview && preview.fileProblems.length > 0 && (
        <Alert>
          <ul className="list-disc pl-4">
            {preview.fileProblems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Alert>
      )}

      {preview && preview.rows.length > 0 && (
        <>
          <ColumnMapping preview={preview} />
          <div
            role="tablist"
            aria-label="Row status"
            className="flex flex-wrap gap-1 rounded-md bg-slate-100 p-1"
          >
            {(['ALL', 'READY', 'DUPLICATE', 'EXISTS', 'ERROR'] as const).map((s) => (
              <button
                key={s}
                type="button"
                role="tab"
                aria-selected={filter === s}
                onClick={() => setFilter(s)}
                className={cn(
                  'rounded px-3 py-1 text-sm',
                  filter === s ? 'bg-white font-medium shadow-sm' : 'text-slate-600',
                )}
              >
                {s === 'ALL'
                  ? `All (${preview.rows.length})`
                  : `${ROW_STATUS_LABELS[s]} (${preview.summary[s]})`}
              </button>
            ))}
          </div>
          <RowsTable rows={visible} chosen={chosen} onToggle={toggle} />

          <Card className="flex flex-wrap items-end gap-3 p-4">
            {chosenDuplicates > 0 && (
              <div className="min-w-72 flex-1">
                <Label htmlFor="duplicate-reason">
                  Why import {chosenDuplicates} possible duplicate{chosenDuplicates === 1 ? '' : 's'}?
                </Label>
                <Input
                  id="duplicate-reason"
                  value={reason}
                  onChange={(e) => setReason(e.currentTarget.value)}
                  placeholder="e.g. two poles on the same corner"
                />
              </div>
            )}
            <Button
              onClick={() => void runImport()}
              disabled={busy || chosen.size === 0 || (chosenDuplicates > 0 && reason.trim().length < 3)}
            >
              Import {chosen.size} asset{chosen.size === 1 ? '' : 's'}
            </Button>
            <p className="text-xs text-slate-500">
              All chosen rows are created together, or none if something changed.
            </p>
          </Card>
        </>
      )}
    </div>
  );
}

function ColumnMapping({ preview }: { preview: ImportPreview }) {
  const ignored = preview.columns.filter((c) => c.mappedTo === null);
  return (
    <p className="text-sm text-slate-600">
      Columns:{' '}
      {preview.columns
        .filter((c) => c.mappedTo !== null)
        .map((c) => `${c.header} → ${c.mappedTo!.replace(/^attr:/, 'attribute ')}`)
        .join(' · ')}
      {ignored.length > 0 && (
        <span className="text-amber-800">
          {' '}
          · ignored: {ignored.map((c) => c.header || '(no header)').join(', ')}
        </span>
      )}
    </p>
  );
}

function RowsTable({
  rows,
  chosen,
  onToggle,
}: {
  rows: readonly ImportRow[];
  chosen: ReadonlySet<number>;
  onToggle: (line: number) => void;
}) {
  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500">
          <tr>
            <th className="px-3 py-2">Import</th>
            <th className="px-3 py-2">Row</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Ref</th>
            <th className="px-3 py-2">Type</th>
            <th className="px-3 py-2">Place</th>
            <th className="px-3 py-2">Details</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={7} className="px-3 py-6 text-center text-slate-500">
                No rows.
              </td>
            </tr>
          )}
          {rows.map((r) => (
            <tr key={r.line} className="border-b border-slate-100 align-top last:border-0">
              <td className="px-3 py-2">
                <input
                  type="checkbox"
                  aria-label={`Import row ${r.line}`}
                  checked={chosen.has(r.line)}
                  disabled={!importable(r)}
                  onChange={() => onToggle(r.line)}
                />
              </td>
              <td className="px-3 py-2 tabular-nums">{r.line}</td>
              <td className="px-3 py-2">
                <span
                  className={cn(
                    'whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium',
                    STATUS_STYLES[r.status],
                  )}
                >
                  {ROW_STATUS_LABELS[r.status]}
                </span>
              </td>
              <td className="px-3 py-2">{r.externalRef ?? '—'}</td>
              <td className="px-3 py-2">{r.typeName ?? '—'}</td>
              <td className="px-3 py-2">
                {[r.address, r.city].filter(Boolean).join(', ')}
                {r.lat !== null && r.lng !== null && (
                  <span className="block text-xs text-slate-500">
                    {r.lat.toFixed(5)}, {r.lng.toFixed(5)}
                  </span>
                )}
              </td>
              <td className="px-3 py-2">
                <RowDetails row={r} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function RowDetails({ row }: { row: ImportRow }) {
  if (row.status === 'ERROR') {
    return (
      <ul className="space-y-0.5 text-red-800">
        {row.problems.map((p) => (
          <li key={`${p.column}:${p.message}`}>
            {p.column && <span className="font-medium">{p.column}: </span>}
            {p.message}
          </li>
        ))}
      </ul>
    );
  }
  if (row.status === 'EXISTS' && row.existing) {
    return (
      <span>
        Already{' '}
        <Link
          to="/app/inventory/$assetId"
          params={{ assetId: row.existing.id }}
          className="text-brand-700 hover:underline"
        >
          {row.existing.code}
        </Link>
      </span>
    );
  }
  if (row.status === 'DUPLICATE') {
    return (
      <span className="text-amber-800">
        {row.nearby.map((n, i) => (
          <span key={n.id}>
            {i > 0 && ', '}
            <Link to="/app/inventory/$assetId" params={{ assetId: n.id }} className="hover:underline">
              {n.code}
            </Link>{' '}
            is {n.distanceM} m away
          </span>
        ))}
        {row.duplicateOfLine !== null &&
          `${row.nearby.length > 0 ? '; ' : ''}close to row ${row.duplicateOfLine}`}
      </span>
    );
  }
  return null;
}
