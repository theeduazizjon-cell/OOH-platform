import type { BriefLineInput, BriefLineItem } from '@ooh/contracts';

/** One editable row of the store-lines table (inputs hold strings). */
export interface LineRow {
  key: string;
  storeName: string;
  address: string;
  city: string;
  county: string;
  requestedUnits: string;
  dimension: string;
  startDate: string;
  endDate: string;
  notes: string;
}

let nextKey = 0;
const newKey = () => `row-${++nextKey}`;

export function emptyRow(): LineRow {
  return {
    key: newKey(),
    storeName: '',
    address: '',
    city: '',
    county: '',
    requestedUnits: '',
    dimension: '',
    startDate: '',
    endDate: '',
    notes: '',
  };
}

export function rowFromLine(line: BriefLineItem): LineRow {
  return {
    key: line.id,
    storeName: line.storeName,
    address: line.address ?? '',
    city: line.city ?? '',
    county: line.county ?? '',
    requestedUnits: line.requestedUnits === null ? '' : String(line.requestedUnits),
    dimension: line.dimension ?? '',
    startDate: line.startDate ?? '',
    endDate: line.endDate ?? '',
    notes: line.notes ?? '',
  };
}

/** A row the user left completely empty is ignored rather than rejected. */
const isBlank = (r: LineRow) =>
  [
    r.storeName,
    r.address,
    r.city,
    r.county,
    r.requestedUnits,
    r.dimension,
    r.startDate,
    r.endDate,
    r.notes,
  ].every((v) => !v.trim());

/** Rows → API lines, or the first problem per row ("Row 2: …"). */
export function rowsToLines(rows: readonly LineRow[]): { lines: BriefLineInput[]; errors: string[] } {
  const lines: BriefLineInput[] = [];
  const errors: string[] = [];
  const kept = rows.filter((r) => !isBlank(r));
  kept.forEach((r, i) => {
    const label = `Store ${i + 1}`;
    const units = r.requestedUnits.trim();
    if (!r.storeName.trim()) return errors.push(`${label}: give the store a name.`);
    if (units && !/^\d+$/.test(units)) return errors.push(`${label}: units is a whole number.`);
    if (units && Number(units) < 1) return errors.push(`${label}: units is at least 1.`);
    if (r.startDate && r.endDate && r.endDate < r.startDate)
      return errors.push(`${label}: the end date is before the start date.`);
    const text = (v: string) => v.trim() || null;
    lines.push({
      storeName: r.storeName.trim(),
      address: text(r.address),
      city: text(r.city),
      county: text(r.county),
      requestedUnits: units ? Number(units) : null,
      dimension: text(r.dimension),
      startDate: r.startDate || null,
      endDate: r.endDate || null,
      notes: text(r.notes),
    });
  });
  return { lines, errors };
}

/** Same content as the saved lines (so "Save stores" can stay disabled when nothing changed). */
export function sameLines(rows: readonly LineRow[], saved: readonly BriefLineItem[]): boolean {
  const { lines, errors } = rowsToLines(rows);
  if (errors.length > 0 || lines.length !== saved.length) return false;
  return lines.every((l, i) => {
    const s = saved[i]!;
    return (
      l.storeName === s.storeName &&
      (l.address ?? null) === s.address &&
      (l.city ?? null) === s.city &&
      (l.county ?? null) === s.county &&
      (l.requestedUnits ?? null) === s.requestedUnits &&
      (l.dimension ?? null) === s.dimension &&
      (l.startDate ?? null) === s.startDate &&
      (l.endDate ?? null) === s.endDate &&
      (l.notes ?? null) === s.notes
    );
  });
}
