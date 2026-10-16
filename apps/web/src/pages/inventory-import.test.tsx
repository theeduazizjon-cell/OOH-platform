import { type AssetTypeItem, DEFAULT_ASSET_TYPES, type ImportPreview, type ImportRow } from '@ooh/contracts';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeCsv, InventoryImportPage, skippedLines, templateCsv } from './inventory-import-page';

const request = vi.fn();
vi.mock('@/lib/api', () => ({ api: { request: (...args: unknown[]) => request(...args) as unknown } }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#asset">{children}</a>,
}));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
const types: AssetTypeItem[] = DEFAULT_ASSET_TYPES.slice(0, 2).map((t, i) => ({
  ...t,
  id: `00000000-0000-4000-8000-00000000000${i}`,
  active: true,
  version: 1,
}));
vi.mock('./asset-status', () => ({ useAssetTypes: () => ({ data: types }) }));

const row = (line: number, status: ImportRow['status'], extra: Partial<ImportRow> = {}): ImportRow => ({
  line,
  status,
  typeName: 'Flag pole',
  lat: 45.35,
  lng: 25.55,
  address: null,
  city: 'Sinaia',
  externalRef: `S-${line}`,
  attributes: {},
  problems: [],
  nearby: [],
  duplicateOfLine: null,
  existing: null,
  ...extra,
});

const PREVIEW: ImportPreview = {
  columns: [
    { header: 'Cod vechi', mappedTo: 'externalRef' },
    { header: 'Tip', mappedTo: 'type' },
    { header: 'Nr. crt.', mappedTo: null },
  ],
  rows: [
    row(2, 'READY'),
    row(3, 'DUPLICATE', { nearby: [{ id: 'a1', code: 'POLE-000001', distanceM: 1.2, lifecycle: 'ACTIVE' }] }),
    row(4, 'ERROR', { typeName: 'Kiosk', problems: [{ column: 'Tip', message: 'Unknown type "Kiosk"' }] }),
    row(5, 'EXISTS', { existing: { id: 'a2', code: 'POLE-000002' } }),
  ],
  fileProblems: [],
  summary: { READY: 1, DUPLICATE: 1, EXISTS: 1, ERROR: 1 },
};

describe('helpers', () => {
  it('decodes UTF-8, and falls back to Windows-1250 for Excel files from Romanian Windows', () => {
    expect(decodeCsv(new TextEncoder().encode('Oraș;Județ').buffer)).toEqual({
      text: 'Oraș;Județ',
      encoding: 'utf-8',
    });
    // "Oraş" in Windows-1250: ş = 0xBA.
    const cp1250 = Uint8Array.from([0x4f, 0x72, 0x61, 0xba]);
    expect(decodeCsv(cp1250.buffer)).toEqual({ text: 'Oraş', encoding: 'windows-1250' });
  });

  it('builds a template with every column and attribute, one example row per type', () => {
    const [header, ...rows] = templateCsv(types).trim().split('\r\n');
    expect(header).toBe('ref,type,lat,lng,address,city,county,notes,material,poleHeightM,structure');
    expect(rows.map((r) => r.split(',')[1])).toEqual(['pole', 'billboard']);
  });

  it('skips every row that is not chosen', () => {
    expect(skippedLines(PREVIEW.rows, new Set([2]))).toEqual([3, 4, 5]);
  });
});

describe('InventoryImportPage', () => {
  beforeEach(() => request.mockReset());

  it('previews the file, needs a reason for chosen duplicates, then imports the chosen rows', async () => {
    request.mockResolvedValueOnce(PREVIEW);
    render(<InventoryImportPage />);
    const csv = 'Cod vechi;Tip\nS-2;pole\n';
    await userEvent.upload(
      screen.getByLabelText('CSV file'),
      new File([csv], 'stalpi.csv', { type: 'text/csv' }),
    );
    expect(request).toHaveBeenCalledWith('/assets/import/preview', { method: 'POST', json: { csv } });

    expect(await screen.findByText(/ignored: Nr\. crt\./)).toBeInTheDocument();
    expect(screen.getByText('Unknown type "Kiosk"')).toBeInTheDocument();
    expect(screen.getByText(/is 1.2 m away/)).toBeInTheDocument();
    // Ready rows are chosen; duplicates are not; errors and existing rows can't be.
    expect(screen.getByLabelText('Import row 2')).toBeChecked();
    expect(screen.getByLabelText('Import row 3')).not.toBeChecked();
    expect(screen.getByLabelText('Import row 4')).toBeDisabled();
    expect(screen.getByLabelText('Import row 5')).toBeDisabled();

    await userEvent.click(screen.getByLabelText('Import row 3'));
    const button = screen.getByRole('button', { name: 'Import 2 assets' });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Why import 1 possible duplicate/), 'Two poles on the corner');
    expect(button).toBeEnabled();

    request.mockResolvedValueOnce({
      created: [
        { line: 2, id: 'n1', code: 'POLE-000003' },
        { line: 3, id: 'n2', code: 'POLE-000004' },
      ],
      skipped: [
        { line: 4, status: 'ERROR' },
        { line: 5, status: 'EXISTS' },
      ],
    });
    await userEvent.click(button);
    expect(request).toHaveBeenLastCalledWith('/assets/import', {
      method: 'POST',
      json: { csv, skipRows: [4, 5], duplicateReason: 'Two poles on the corner' },
    });
    expect(await screen.findByText('Imported 2 assets, skipped 2 rows.')).toBeInTheDocument();
    expect(screen.getByText('POLE-000004')).toBeInTheDocument();
  });

  it('filters rows by status', async () => {
    request.mockResolvedValueOnce(PREVIEW);
    render(<InventoryImportPage />);
    await userEvent.upload(screen.getByLabelText('CSV file'), new File(['x'], 'a.csv', { type: 'text/csv' }));
    await userEvent.click(await screen.findByRole('tab', { name: 'Needs fixing (1)' }));
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(2); // header + the error row
    expect(within(table).getByText('S-4')).toBeInTheDocument();
  });
});
