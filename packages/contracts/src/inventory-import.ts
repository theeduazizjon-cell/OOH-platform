import { z } from 'zod';
import type { AttributeSpec, NearbyAsset } from './inventory';

/**
 * Inventory CSV import (11-mvp-scope.md: migrating existing Excel / My Maps inventory). Two steps:
 * POST /assets/import/preview checks every row; POST /assets/import creates them all or nothing.
 */

/** Rows per file: one import runs in one transaction. Bigger inventories are split into files. */
export const IMPORT_MAX_ROWS = 1000;
/** The CSV travels in a JSON body (1 MB limit). */
export const IMPORT_MAX_CSV_CHARS = 900_000;

/** Fields a column can fill. Attribute columns map to `attr:<key>` per asset type. */
export const IMPORT_FIELDS = [
  'type',
  'lat',
  'lng',
  'coordinates',
  'address',
  'city',
  'county',
  'notes',
  'externalRef',
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

/** Header spellings accepted per field (compared after `normalizeHeader`), English and Romanian. */
export const IMPORT_HEADER_ALIASES: Record<ImportField, readonly string[]> = {
  type: ['type', 'asset type', 'tip', 'tip activ', 'tip suport'],
  lat: ['lat', 'latitude', 'latitudine', 'y'],
  lng: ['lng', 'lon', 'long', 'longitude', 'longitudine', 'x'],
  coordinates: ['coordinates', 'coords', 'gps', 'coordonate', 'location', 'locatie', 'google maps', 'link'],
  address: ['address', 'adresa', 'strada'],
  city: ['city', 'town', 'oras', 'localitate', 'municipiu'],
  county: ['county', 'judet'],
  notes: ['notes', 'note', 'comments', 'observatii', 'mentiuni', 'description', 'descriere'],
  // Not "nr"/"id": a row-number column would become the reference and make other files' rows "EXISTS".
  externalRef: [
    'ref',
    'reference',
    'external ref',
    'legacy code',
    'old code',
    'code',
    'cod',
    'cod vechi',
    'cod intern',
  ],
};

/** Lowercase, no diacritics, single spaces, no punctuation around words ("Județ:" → "judet"). */
export function normalizeHeader(header: string): string {
  return header
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[_\-./():]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A fixed field for this header, or null (it may still be an attribute of the row's type). */
export function fieldOfHeader(header: string): ImportField | null {
  const normalized = normalizeHeader(header);
  for (const field of IMPORT_FIELDS) {
    if (IMPORT_HEADER_ALIASES[field].includes(normalized)) return field;
  }
  return null;
}

/** The attribute this header names (by key or label) in a type's schema, or null. */
export function attributeOfHeader(header: string, schema: Record<string, AttributeSpec>): string | null {
  const normalized = normalizeHeader(header.replace(/^attr(ibute)?\s*[:.]\s*/i, ''));
  for (const [key, spec] of Object.entries(schema)) {
    if (normalizeHeader(key) === normalized || normalizeHeader(spec.label) === normalized) return key;
  }
  return null;
}

/**
 * RFC 4180 CSV (quoted fields, doubled quotes, line breaks inside quotes; CRLF or LF). The delimiter
 * is the one of `,` `;` tab that occurs most in the first line outside quotes (Excel in Romanian
 * locales writes `;`). A UTF-8 BOM is dropped; blank lines are skipped.
 */
export function parseCsv(text: string): { delimiter: string; rows: string[][] } {
  const input = text.replace(/^\uFEFF/, '');
  const delimiter = detectDelimiter(input);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && input[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((v) => v.trim() !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v.trim() !== '')) rows.push(row);
  return { delimiter, rows };
}

function detectDelimiter(input: string): string {
  const counts = new Map<string, number>([
    [',', 0],
    [';', 0],
    ['\t', 0],
  ]);
  let quoted = false;
  for (const c of input) {
    if (c === '"') quoted = !quoted;
    else if (!quoted && (c === '\n' || c === '\r')) break;
    else if (!quoted && counts.has(c)) counts.set(c, counts.get(c)! + 1);
  }
  const [best, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
  return count > 0 ? best : ',';
}

/** A number written with a decimal point or a decimal comma ("45,3486"); null when it isn't one. */
export function parseDecimal(text: string): number | null {
  const t = text.trim().replace(/\s/g, '');
  if (!/^[-+]?\d+([.,]\d+)?$/.test(t)) return null;
  return Number(t.replace(',', '.'));
}

/**
 * One coordinates cell: "45.3486, 25.5517" (decimal points), or a Google Maps link
 * (".../@45.3486,25.5517,17z", "?q=45.3486,25.5517", "query=…"). Decimal commas need lat/lng columns.
 */
export function parseCoordinatePair(text: string): { lat: number; lng: number } | null {
  const t = text.trim();
  const match =
    /@(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/.exec(t) ??
    /[?&](?:q|query|ll)=(-?\d{1,3}(?:\.\d+)?)(?:,|%2C)(-?\d{1,3}(?:\.\d+)?)/i.exec(t) ??
    /^(-?\d{1,3}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)$/.exec(t);
  if (!match) return null;
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

// ── API shapes ───────────────────────────────────────────────────────────────

export const importPreviewRequestSchema = z.object({
  csv: z.string().min(1, 'The file is empty').max(IMPORT_MAX_CSV_CHARS, 'The file is too large: split it'),
});

export const importRequestSchema = importPreviewRequestSchema.extend({
  /** Data rows (file line numbers, as in the preview) to leave out. */
  skipRows: z.array(z.number().int().min(2)).max(IMPORT_MAX_ROWS).default([]),
  /** Creates the rows flagged DUPLICATE anyway (recorded on each asset); otherwise they must be skipped. */
  duplicateReason: z.string().trim().min(3).max(500).optional(),
});
export type ImportRequest = z.infer<typeof importRequestSchema>;

/**
 * READY: will be created. DUPLICATE: within the duplicate radius of an asset of the same kind (or of an
 * earlier row): skip it or give a reason. EXISTS: its reference was imported before (always skipped).
 * ERROR: can't be imported as written.
 */
export const IMPORT_ROW_STATUSES = ['READY', 'DUPLICATE', 'EXISTS', 'ERROR'] as const;
export type ImportRowStatus = (typeof IMPORT_ROW_STATUSES)[number];

export interface ImportRowProblem {
  /** The CSV header the problem is about (null: the row as a whole). */
  column: string | null;
  message: string;
}

export interface ImportRow {
  /** Line in the file (the header is line 1). */
  line: number;
  status: ImportRowStatus;
  typeName: string | null;
  lat: number | null;
  lng: number | null;
  address: string | null;
  city: string | null;
  externalRef: string | null;
  attributes: Record<string, string | number | boolean>;
  problems: ImportRowProblem[];
  /** DUPLICATE: existing assets nearby. */
  nearby: NearbyAsset[];
  /** DUPLICATE: an earlier row of this file within the radius. */
  duplicateOfLine: number | null;
  /** EXISTS: the asset already carrying this reference. */
  existing: { id: string; code: string } | null;
}

export interface ImportColumn {
  header: string;
  /** A field, `attr:<key>` (for at least one type in the file), or null (ignored). */
  mappedTo: string | null;
}

export interface ImportPreview {
  columns: ImportColumn[];
  rows: ImportRow[];
  /** Problems with the file as a whole (no header, missing columns, too many rows). */
  fileProblems: string[];
  summary: Record<ImportRowStatus, number>;
}

export interface ImportResult {
  created: { line: number; id: string; code: string }[];
  skipped: { line: number; status: ImportRowStatus }[];
}
