import type { BriefLineInput, BriefLineItem } from '@ooh/contracts';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/card';
import { ApiError } from '@/lib/api';
import { emptyRow, type LineRow, rowFromLine, rowsToLines, sameLines } from './brief-lines';

const COLUMNS: {
  field: Exclude<keyof LineRow, 'key' | 'notes'>;
  label: string;
  type?: string;
  width: string;
}[] = [
  { field: 'storeName', label: 'Store', width: 'min-w-44' },
  { field: 'address', label: 'Address', width: 'min-w-52' },
  { field: 'city', label: 'City', width: 'min-w-28' },
  { field: 'county', label: 'County', width: 'min-w-28' },
  { field: 'requestedUnits', label: 'Units', width: 'w-20' },
  { field: 'dimension', label: 'Size / type', width: 'min-w-32' },
  { field: 'startDate', label: 'Start', type: 'date', width: 'w-36' },
  { field: 'endDate', label: 'End', type: 'date', width: 'w-36' },
];

/** The stores of a brief as an editable table; saved as a whole (PUT /briefs/{id}/lines). */
export function BriefLinesEditor({
  lines,
  editable,
  onSave,
}: {
  lines: readonly BriefLineItem[];
  editable: boolean;
  onSave: (lines: BriefLineInput[]) => Promise<void>;
}) {
  const [rows, setRows] = useState<LineRow[]>(() =>
    lines.length > 0 ? lines.map(rowFromLine) : editable ? [emptyRow()] : [],
  );
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const unchanged = sameLines(rows, lines);

  const set = (key: string, field: keyof LineRow, value: string) =>
    setRows((current) => current.map((r) => (r.key === key ? { ...r, [field]: value } : r)));

  async function save() {
    const result = rowsToLines(rows);
    setErrors(result.errors);
    if (result.errors.length > 0) return;
    setSaving(true);
    try {
      await onSave(result.lines);
    } catch (caught) {
      setErrors([caught instanceof ApiError ? caught.message : 'Could not reach the server. Try again.']);
    } finally {
      setSaving(false);
    }
  }

  if (!editable && rows.length === 0) return <p className="text-sm text-slate-500">No stores yet.</p>;
  return (
    <div className="space-y-2">
      {errors.length > 0 && (
        <Alert>
          {errors.map((e) => (
            <span key={e} className="block">
              {e}
            </span>
          ))}
        </Alert>
      )}
      <div className="overflow-x-auto rounded-md border border-slate-200">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-2 py-2">#</th>
              {COLUMNS.map((c) => (
                <th key={c.field} className="px-2 py-2">
                  {c.label}
                </th>
              ))}
              {editable && (
                <th className="px-2 py-2">
                  <span className="sr-only">Remove</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.key} className="border-b border-slate-100 last:border-0">
                <td className="px-2 py-1 text-slate-500">{i + 1}</td>
                {COLUMNS.map((c) => (
                  <td key={c.field} className={`px-1 py-1 ${c.width}`}>
                    {editable ? (
                      <input
                        aria-label={`${c.label}, store ${i + 1}`}
                        type={c.type ?? 'text'}
                        inputMode={c.field === 'requestedUnits' ? 'numeric' : undefined}
                        className="h-8 w-full rounded border border-slate-300 px-2 text-sm"
                        value={r[c.field]}
                        onChange={(e) => set(r.key, c.field, e.currentTarget.value)}
                      />
                    ) : (
                      <span className="px-1">{r[c.field]}</span>
                    )}
                  </td>
                ))}
                {editable && (
                  <td className="px-1 py-1">
                    <Button
                      variant="ghost"
                      className="h-8 px-2"
                      aria-label={`Remove store ${i + 1}`}
                      onClick={() => setRows((current) => current.filter((x) => x.key !== r.key))}
                    >
                      ✕
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editable && (
        <div className="flex flex-wrap justify-between gap-2">
          <Button
            variant="secondary"
            className="h-8"
            onClick={() => setRows((current) => [...current, emptyRow()])}
          >
            Add store
          </Button>
          <Button className="h-8" disabled={saving || unchanged} onClick={() => void save()}>
            {saving ? 'Saving…' : unchanged ? 'Stores saved' : 'Save stores'}
          </Button>
        </div>
      )}
    </div>
  );
}
