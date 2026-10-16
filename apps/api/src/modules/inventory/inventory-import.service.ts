import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  attributeOfHeader,
  attributeProblems,
  type AttributeSpec,
  DUPLICATE_RADIUS_M,
  fieldOfHeader,
  IMPORT_MAX_ROWS,
  type ImportColumn,
  type ImportField,
  type ImportPreview,
  type ImportRequest,
  type ImportResult,
  type ImportRow,
  type ImportRowStatus,
  type NearbyAsset,
  normalizeHeader,
  parseCoordinatePair,
  parseCsv,
  parseDecimal,
} from '@ooh/contracts';
import { assetType, oohAsset, type Transaction } from '@ooh/db';
import { eq, inArray, sql } from 'drizzle-orm';
import { userActor } from '../../core/audit/actor';
import { AuditService } from '../../core/audit/audit.service';
import { type Principal } from '../../core/auth/principal';
import { DatabaseService } from '../../core/database/database.service';
import { AppError } from '../../core/http/app-error';
import { type ClientInfo } from '../../core/http/client-info';
import { CodeSequence, InventoryService, type TypeRow } from './inventory.service';

const TEXT_LIMITS = { address: 300, city: 100, county: 100, notes: 5000, externalRef: 100 } as const;
type TextField = keyof typeof TEXT_LIMITS;

/** A row as analysed, with what the commit needs to create it. */
interface Candidate {
  row: ImportRow;
  type: TypeRow | null;
  county: string | null;
  notes: string | null;
}

interface Analysis {
  preview: ImportPreview;
  candidates: Candidate[];
}

/**
 * Inventory CSV import (11-mvp-scope.md: moving existing Excel / My Maps inventory in). The preview
 * and the import run the same analysis; the import repeats it inside its transaction, so what is
 * created is what the rules say at that moment, all or nothing.
 */
@Injectable()
export class InventoryImportService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly inventory: InventoryService,
  ) {}

  preview(principal: Principal, csv: string): Promise<ImportPreview> {
    return this.inTenant(principal, async (tx) => (await this.analyse(tx, csv, new Set())).preview);
  }

  import(principal: Principal, input: ImportRequest, client: ClientInfo): Promise<ImportResult> {
    return this.inTenant(principal, async (tx) => {
      // One import at a time per company: rows of two files can't both pass the duplicate check.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${principal.tenantId}:asset_import`}, 0))`,
      );
      const skip = new Set(input.skipRows);
      const { preview, candidates } = await this.analyse(tx, input.csv, skip);
      if (preview.fileProblems.length > 0) {
        throw new AppError('VALIDATION_FAILED', preview.fileProblems.join(' '), {
          errors: preview.fileProblems.map((message) => ({ path: 'csv', message })),
        });
      }
      const blocking = preview.rows.filter(
        (r) =>
          !skip.has(r.line) && (r.status === 'ERROR' || (r.status === 'DUPLICATE' && !input.duplicateReason)),
      );
      if (blocking.length > 0) {
        throw new AppError(
          'VALIDATION_FAILED',
          `${blocking.length} row${blocking.length === 1 ? '' : 's'} can't be imported as they are: fix or skip them${
            blocking.some((r) => r.status === 'DUPLICATE')
              ? ', and give a reason to import possible duplicates'
              : ''
          }.`,
          {
            errors: blocking.slice(0, 100).map((r) => ({
              path: `rows.${r.line}`,
              message:
                r.status === 'DUPLICATE' ? 'Possible duplicate' : r.problems.map((p) => p.message).join('; '),
            })),
          },
        );
      }

      const codes = new CodeSequence(principal.tenantId);
      const result: ImportResult = { created: [], skipped: [] };
      for (const { row, type, county, notes } of candidates) {
        if (skip.has(row.line) || row.status === 'EXISTS') {
          result.skipped.push({ line: row.line, status: row.status });
          continue;
        }
        const duplicate = row.status === 'DUPLICATE';
        const { id, code } = await this.inventory.insertAsset(
          tx,
          principal,
          client,
          type!,
          {
            lat: row.lat!,
            lng: row.lng!,
            address: row.address,
            city: row.city,
            county,
            notes,
            externalRef: row.externalRef,
            attributes: row.attributes,
            ...(duplicate ? { duplicateOverride: { reason: input.duplicateReason! } } : {}),
          },
          { nearby: row.nearby, codes, source: 'import' },
        );
        result.created.push({ line: row.line, id, code });
      }
      if (result.created.length === 0) {
        throw new AppError(
          'VALIDATION_FAILED',
          'Nothing to import: every row is skipped or already imported.',
        );
      }
      await this.audit.record(tx, {
        ...userActor(principal, client),
        action: 'asset.imported',
        subjectType: 'asset_import',
        subjectId: randomUUID(),
        metadata: {
          created: result.created.length,
          skipped: result.skipped.length,
          duplicatesImported: candidates.filter((c) => c.row.status === 'DUPLICATE' && !skip.has(c.row.line))
            .length,
          ...(input.duplicateReason ? { duplicateReason: input.duplicateReason } : {}),
          codes: result.created.map((c) => c.code),
        },
      });
      return result;
    });
  }

  // ── analysis ───────────────────────────────────────────────────────────────

  private async analyse(tx: Transaction, csv: string, skip: Set<number>): Promise<Analysis> {
    const { rows } = parseCsv(csv);
    const fileProblems: string[] = [];
    const empty = (columns: ImportColumn[] = []): Analysis => ({
      preview: { columns, rows: [], fileProblems, summary: { READY: 0, DUPLICATE: 0, EXISTS: 0, ERROR: 0 } },
      candidates: [],
    });
    const [headers, ...data] = rows;
    if (!headers) {
      fileProblems.push('The file has no header row.');
      return empty();
    }

    // Columns → fields (each field once).
    const fieldColumn = new Map<ImportField, number>();
    headers.forEach((header, index) => {
      const field = fieldOfHeader(header);
      if (!field) return;
      if (fieldColumn.has(field)) {
        fileProblems.push(
          `Two columns mean the same thing: "${headers[fieldColumn.get(field)!]}" and "${header}".`,
        );
      } else fieldColumn.set(field, index);
    });
    if (!fieldColumn.has('type'))
      fileProblems.push('Add a "type" column (asset type name, key or code prefix).');
    const hasLatLng = fieldColumn.has('lat') && fieldColumn.has('lng');
    if (!hasLatLng && !fieldColumn.has('coordinates')) {
      fileProblems.push(
        'Add "lat" and "lng" columns, or a "coordinates" column ("45.3486, 25.5517" or a Google Maps link).',
      );
    }
    if (data.length === 0) fileProblems.push('The file has no data rows.');
    if (data.length > IMPORT_MAX_ROWS) {
      fileProblems.push(
        `The file has ${data.length} rows; import at most ${IMPORT_MAX_ROWS} at a time (split the file).`,
      );
    }
    const baseColumns: ImportColumn[] = headers.map((header) => ({
      header,
      mappedTo: fieldOfHeader(header),
    }));
    if (fileProblems.length > 0) return empty(baseColumns);

    const types = await tx.select().from(assetType).where(eq(assetType.active, true));
    const typeOf = (text: string): TypeRow | null => {
      const wanted = normalizeHeader(text);
      return (
        types.find((t) => [t.key, t.name, t.codePrefix].some((v) => normalizeHeader(v) === wanted)) ?? null
      );
    };
    const cell = (values: string[], field: ImportField): string => {
      const index = fieldColumn.get(field);
      return index === undefined ? '' : (values[index] ?? '').trim();
    };
    const attributeColumns = headers
      .map((header, index) => ({ header, index }))
      .filter(({ header }) => fieldOfHeader(header) === null);
    const mappedAttributes = new Map<number, string>();

    const candidates: Candidate[] = data.map((values, i) => {
      const line = i + 2;
      const problems: ImportRow['problems'] = [];
      const header = (field: ImportField) => headers[fieldColumn.get(field)!] ?? null;

      const typeText = cell(values, 'type');
      const type = typeText ? typeOf(typeText) : null;
      if (!typeText) problems.push({ column: header('type'), message: 'The type is missing' });
      else if (!type) {
        problems.push({
          column: header('type'),
          message: `Unknown type "${typeText}". Use one of: ${types.map((t) => t.name).join(', ')}`,
        });
      }

      let lat: number | null = null;
      let lng: number | null = null;
      if (hasLatLng && (cell(values, 'lat') || cell(values, 'lng') || !fieldColumn.has('coordinates'))) {
        lat = parseDecimal(cell(values, 'lat'));
        lng = parseDecimal(cell(values, 'lng'));
        if (lat === null || Math.abs(lat) > 90) {
          problems.push({ column: header('lat'), message: 'Latitude must be a number between -90 and 90' });
          lat = null;
        }
        if (lng === null || Math.abs(lng) > 180) {
          problems.push({
            column: header('lng'),
            message: 'Longitude must be a number between -180 and 180',
          });
          lng = null;
        }
      } else {
        const pair = parseCoordinatePair(cell(values, 'coordinates'));
        if (pair) ({ lat, lng } = pair);
        else {
          problems.push({
            column: header('coordinates'),
            message: 'Coordinates must be "lat, lng" with decimal points, or a Google Maps link to the point',
          });
        }
      }
      if (lat === 0 && lng === 0) {
        problems.push({ column: null, message: 'Coordinates 0, 0 are not a real position' });
        lat = lng = null;
      }

      const text = {} as Record<TextField, string | null>;
      for (const field of Object.keys(TEXT_LIMITS) as TextField[]) {
        const value = cell(values, field);
        text[field] = value === '' ? null : value;
        if (value.length > TEXT_LIMITS[field]) {
          problems.push({ column: header(field), message: `At most ${TEXT_LIMITS[field]} characters` });
        }
      }

      const attributes: Record<string, string | number | boolean> = {};
      if (type) {
        const schema = type.attributeSchema;
        for (const { header: h, index } of attributeColumns) {
          const key = attributeOfHeader(h, schema);
          const raw = (values[index] ?? '').trim();
          if (!key || raw === '') continue;
          mappedAttributes.set(index, key);
          const value = attributeValue(raw, schema[key]!);
          if (value === null) {
            problems.push({ column: h, message: `${schema[key]!.label} must be ${describe(schema[key]!)}` });
          } else attributes[key] = value;
        }
        for (const problem of attributeProblems(schema, attributes)) {
          const key = problem.path.replace(/^attributes\./, '');
          const index = [...mappedAttributes.entries()].find(([, k]) => k === key)?.[0];
          problems.push({ column: index === undefined ? null : headers[index]!, message: problem.message });
        }
      }

      return {
        type,
        county: text.county,
        notes: text.notes,
        row: {
          line,
          status: 'READY',
          typeName: type?.name ?? (typeText || null),
          lat,
          lng,
          address: text.address,
          city: text.city,
          externalRef: text.externalRef,
          attributes,
          problems,
          nearby: [],
          duplicateOfLine: null,
          existing: null,
        },
      };
    });

    // References: unique within the file; already imported → EXISTS.
    const byRef = new Map<string, number>();
    for (const { row } of candidates) {
      if (!row.externalRef) continue;
      const first = byRef.get(row.externalRef);
      if (first !== undefined) {
        row.problems.push({
          column: headers[fieldColumn.get('externalRef')!]!,
          message: `Same reference as row ${first}`,
        });
      } else byRef.set(row.externalRef, row.line);
    }
    const existing = new Map<string, { id: string; code: string }>();
    const refs = [...byRef.keys()];
    for (let i = 0; i < refs.length; i += 500) {
      const found = await tx
        .select({ id: oohAsset.id, code: oohAsset.code, ref: oohAsset.externalRef })
        .from(oohAsset)
        .where(inArray(oohAsset.externalRef, refs.slice(i, i + 500)));
      for (const f of found) existing.set(f.ref!, { id: f.id, code: f.code });
    }

    // Duplicates: existing assets of the same kind nearby, then earlier rows of this file.
    const checkable = candidates.filter(
      (c) => c.row.problems.length === 0 && !(c.row.externalRef && existing.has(c.row.externalRef)),
    );
    const nearby = await nearbyExisting(tx, checkable);
    const kept: Candidate[] = [];
    for (const c of checkable) {
      c.row.nearby = nearby.get(c.row.line) ?? [];
      if (skip.has(c.row.line)) continue;
      const earlier = kept.find(
        (k) => k.type!.kind === c.type!.kind && distanceM(k.row, c.row) <= DUPLICATE_RADIUS_M,
      );
      c.row.duplicateOfLine = earlier?.row.line ?? null;
      kept.push(c);
    }

    const summary: Record<ImportRowStatus, number> = { READY: 0, DUPLICATE: 0, EXISTS: 0, ERROR: 0 };
    for (const { row } of candidates) {
      const already = row.externalRef ? existing.get(row.externalRef) : undefined;
      if (already) {
        row.status = 'EXISTS';
        row.existing = already;
      } else if (row.problems.length > 0) row.status = 'ERROR';
      else if (row.nearby.length > 0 || row.duplicateOfLine !== null) row.status = 'DUPLICATE';
      else row.status = 'READY';
      summary[row.status]++;
    }

    // An attribute column is mapped when its header names an attribute of any active type.
    const columns = baseColumns.map((column) => {
      if (column.mappedTo) return column;
      const key = types
        .map((t) => attributeOfHeader(column.header, t.attributeSchema))
        .find((k) => k !== null);
      return { ...column, mappedTo: key ? `attr:${key}` : null };
    });
    return { preview: { columns, rows: candidates.map((c) => c.row), fileProblems, summary }, candidates };
  }

  private inTenant<T>(principal: Principal, fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.database.withTenant({ tenantId: principal.tenantId, actorUserId: principal.userId }, fn);
  }
}

/** Existing same-kind assets within the duplicate radius of each row (at most 3 each), in one query. */
async function nearbyExisting(tx: Transaction, candidates: Candidate[]): Promise<Map<number, NearbyAsset[]>> {
  const result = new Map<number, NearbyAsset[]>();
  if (candidates.length === 0) return result;
  const points = candidates.map((c) => ({
    line: c.row.line,
    lat: c.row.lat,
    lng: c.row.lng,
    kind: c.type!.kind,
  }));
  // SECURITY DEFINER (migration 0030): under RLS the spatial index can't be used for this query.
  const rows = await tx.execute<{
    line: number;
    id: string;
    code: string;
    lifecycle: NearbyAsset['lifecycle'];
    distance_m: number;
  }>(sql`SELECT * FROM asset_nearby_same_kind(${JSON.stringify(points)}::jsonb, ${DUPLICATE_RADIUS_M})`);
  for (const r of rows) {
    const list = result.get(r.line) ?? [];
    list.push({
      id: r.id,
      code: r.code,
      lifecycle: r.lifecycle,
      distanceM: Math.round(Number(r.distance_m) * 10) / 10,
    });
    result.set(r.line, list);
  }
  return result;
}

/** Great-circle distance in metres (enough for a 10 m check between rows of one file). */
function distanceM(
  a: { lat: number | null; lng: number | null },
  b: { lat: number | null; lng: number | null },
): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat! - a.lat!) * rad;
  const dLng = (b.lng! - a.lng!) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat! * rad) * Math.cos(b.lat! * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.sqrt(h));
}

const TRUE_WORDS = ['yes', 'y', 'true', '1', 'da', 'x'];
const FALSE_WORDS = ['no', 'n', 'false', '0', 'nu'];

/** A cell as the attribute's type (decimal commas allowed; da/nu for booleans); null when it isn't. */
function attributeValue(raw: string, spec: AttributeSpec): string | number | boolean | null {
  if (spec.type === 'string') {
    if (!spec.enum) return raw;
    return spec.enum.find((v) => normalizeHeader(v) === normalizeHeader(raw)) ?? raw;
  }
  if (spec.type === 'boolean') {
    const word = normalizeHeader(raw);
    if (TRUE_WORDS.includes(word)) return true;
    if (FALSE_WORDS.includes(word)) return false;
    return null;
  }
  const n = parseDecimal(raw);
  if (n === null || (spec.type === 'integer' && !Number.isInteger(n))) return null;
  return n;
}

function describe(spec: AttributeSpec): string {
  return spec.type === 'integer'
    ? 'a whole number'
    : spec.type === 'boolean'
      ? 'yes or no'
      : `a ${spec.type}`;
}
