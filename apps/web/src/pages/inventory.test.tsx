import { type AssetTypeItem, DEFAULT_ASSET_TYPES } from '@ooh/contracts';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import { sha256Hex, uploadProblem } from '@/lib/upload';
import { fileStatusLabel, formatBytes, isProcessing } from './asset-files';
import { AssetForm, readAttributes } from './asset-form';
import { actionError, updateAssetBody } from './asset-page';
import { faceSize, streetViewLink, structureSummary } from './asset-status';
import { faceBody, mountBody, parseBearing, parseMetres } from './asset-structure';
import { blockBody, termsBody, termsPeriod, today } from './asset-terms';
import { createAssetBody } from './inventory-page';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#asset">{children}</a>,
}));

const types: AssetTypeItem[] = DEFAULT_ASSET_TYPES.slice(0, 2).map((t, i) => ({
  ...t,
  id: `00000000-0000-4000-8000-00000000000${i}`,
  active: true,
  version: 1,
}));
const pole = DEFAULT_ASSET_TYPES[0]!;

const formOf = (fields: Record<string, string>) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return form;
};

describe('asset attributes', () => {
  it('reads typed values, skips blanks and reports schema problems', () => {
    expect(
      readAttributes(pole.attributeSchema, formOf({ 'attr.material': 'metal', 'attr.poleHeightM': '6,5' })),
    ).toEqual({ values: { material: 'metal', poleHeightM: 6.5 }, problems: [] });
    expect(readAttributes(pole.attributeSchema, formOf({ 'attr.material': '' })).values).toEqual({});
    expect(readAttributes(pole.attributeSchema, formOf({ 'attr.poleHeightM': 'tall' })).problems).toEqual([
      'Pole height (m) must be a number',
    ]);
    const prism = DEFAULT_ASSET_TYPES[2]!;
    expect(readAttributes(prism.attributeSchema, formOf({ 'attr.rotationSeconds': '7.5' })).problems).toEqual(
      ['Rotation (s) must be a whole number'],
    );
  });
});

describe('AssetForm', () => {
  it('validates the point, then submits the asset', async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    render(<AssetForm types={types} submitLabel="Create asset" onSubmit={onSubmit} onCancel={vi.fn()} />);
    expect(screen.getByText(/Code POLE-000001…; starts with 2 mounts × 2 faces/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Create asset' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/Paste coordinates/)).toBeInTheDocument();

    await userEvent.type(
      screen.getByLabelText('Coordinates or Google Maps link'),
      'https://www.google.com/maps/@45.3486,25.5517,17z',
    );
    await userEvent.type(screen.getByLabelText('City'), 'Sinaia');
    await userEvent.selectOptions(screen.getByLabelText('Material (optional)'), 'metal');
    await userEvent.click(screen.getByRole('button', { name: 'Create asset' }));
    expect(onSubmit).toHaveBeenCalledWith(
      {
        assetTypeId: types[0]!.id,
        lat: 45.3486,
        lng: 25.5517,
        address: null,
        city: 'Sinaia',
        county: null,
        attributes: { material: 'metal' },
        notes: null,
      },
      null,
    );
  });

  it('lists a nearby duplicate and needs a reason to create anyway', async () => {
    const duplicate = new ApiError(409, {
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      code: 'DUPLICATE_SUSPECTED',
      detail: 'POLE-000007 is 4 m away. Reuse it, or give a reason to add another.',
      meta: { nearby: [{ id: 'a7', code: 'POLE-000007', distanceM: 4, lifecycle: 'ACTIVE' }] },
    });
    const onSubmit = vi
      .fn<(values: unknown, reason: string | null) => Promise<void>>()
      .mockRejectedValueOnce(duplicate)
      .mockResolvedValueOnce();
    render(<AssetForm types={types} submitLabel="Create asset" onSubmit={onSubmit} onCancel={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Coordinates or Google Maps link'), '45.3486, 25.5517');
    await userEvent.click(screen.getByRole('button', { name: 'Create asset' }));

    expect(await screen.findByText('POLE-000007')).toBeInTheDocument();
    expect(screen.getByText(/4 m · Active/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Create asset anyway' }));
    expect(screen.getByText('Say why this is a different asset.')).toBeInTheDocument();
    expect(onSubmit).toHaveBeenCalledTimes(1);

    await userEvent.type(
      screen.getByLabelText('Why is this a different asset?'),
      'Opposite side of the road',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Create asset anyway' }));
    expect(onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({ lat: 45.3486 }),
      'Opposite side of the road',
    );
  });
});

describe('asset request bodies', () => {
  const values = {
    assetTypeId: 't',
    lat: 45.1,
    lng: 25.1,
    address: null,
    city: 'Sinaia',
    county: null,
    attributes: {},
    notes: null,
  };

  it('adds the duplicate override only with a reason', () => {
    expect(createAssetBody(values, null)).toEqual(values);
    expect(createAssetBody(values, 'Other side')).toEqual({
      ...values,
      duplicateOverride: { reason: 'Other side' },
    });
  });

  it('sends the point only when the asset moved', () => {
    expect(updateAssetBody({ location: { lat: 45.1, lng: 25.1 } }, values, null)).not.toHaveProperty('lat');
    expect(updateAssetBody({ location: { lat: 45.2, lng: 25.1 } }, values, 'Moved')).toMatchObject({
      lat: 45.1,
      lng: 25.1,
      duplicateOverride: { reason: 'Moved' },
    });
  });

  it('lists what activation is missing', () => {
    const missing = new ApiError(422, {
      type: 'about:blank',
      title: 'Unprocessable',
      status: 422,
      code: 'VALIDATION_FAILED',
      detail: 'An asset joins the inventory once its current terms and a photo are recorded.',
      errors: [
        { path: 'terms', message: 'Record who owns or supplies it (terms covering today)' },
        { path: 'photos', message: 'Add at least one checked photo of the asset' },
      ],
    });
    expect(actionError(missing)).toBe(
      'An asset joins the inventory once its current terms and a photo are recorded. Missing: Record who owns or supplies it (terms covering today); Add at least one checked photo of the asset.',
    );
    expect(actionError(new TypeError('offline'))).toBe('Could not reach the server. Try again.');
  });
});

describe('structure', () => {
  it('parses bearings and metres', () => {
    expect(parseBearing('')).toBeNull();
    expect(parseBearing('359')).toBe(359);
    expect(parseBearing('360')).toBeUndefined();
    expect(parseBearing('12.5')).toBeUndefined();
    expect(parseMetres(' 0,8 ')).toBe('0.8');
    expect(parseMetres('12')).toBe('12');
    expect(parseMetres('1.234')).toBeUndefined();
  });

  it('builds mount and face changes', () => {
    expect(mountBody(formOf({ orientationBearing: '90', heightM: '3.5', notes: ' ' }))).toEqual({
      body: { orientationBearing: 90, heightM: '3.5', notes: null },
    });
    expect(mountBody(formOf({ orientationBearing: 'north', heightM: '' }))).toHaveProperty('error');
    expect(faceBody(formOf({ preset: 'p1', facingBearing: '', visibleTrafficDirection: '' }))).toEqual({
      body: {
        facingBearing: null,
        visibleTrafficDirection: null,
        illuminated: false,
        dimensionPresetId: 'p1',
      },
    });
    expect(
      faceBody(formOf({ preset: '', widthM: '4', heightM: '3', facingBearing: '180', illuminated: 'on' })),
    ).toEqual({
      body: {
        facingBearing: 180,
        visibleTrafficDirection: null,
        illuminated: true,
        dimensionPresetId: null,
        widthM: '4',
        heightM: '3',
      },
    });
    expect(faceBody(formOf({ preset: '', widthM: '4', heightM: '' }))).toEqual({
      error: 'Give both the width and the height.',
    });
  });

  it('summarises sizes and structure', () => {
    expect(faceSize({ widthM: '0.80', heightM: '2.00' })).toBe('0.8 × 2 m');
    expect(faceSize({ widthM: null, heightM: '2.00' })).toBeNull();
    expect(structureSummary({ mountCount: 2, faceCount: 4 })).toBe('2 mounts · 4 faces');
    expect(structureSummary({ mountCount: 1, faceCount: 1 })).toBe('1 mount · 1 face');
  });

  it('links Street View to the saved panorama', () => {
    const at = { location: { lat: 45.3, lng: 25.5 } };
    expect(streetViewLink({ ...at, streetViewRef: null })).toBe(
      'https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=45.3%2C25.5',
    );
    expect(
      streetViewLink({ ...at, streetViewRef: { panoId: 'abc', heading: 90, pitch: 0, fov: 80 } }),
    ).toContain('pano=abc&heading=90&pitch=0&fov=80');
  });
});

describe('terms and blocks', () => {
  it('knows past, current and upcoming periods', () => {
    expect(termsPeriod({ validFrom: '2026-01-01', validTo: null }, '2026-10-16')).toBe('current');
    expect(termsPeriod({ validFrom: '2026-01-01', validTo: '2026-10-15' }, '2026-10-16')).toBe('past');
    expect(termsPeriod({ validFrom: '2026-10-17', validTo: null }, '2026-10-16')).toBe('future');
    expect(today(new Date(2026, 9, 16, 23, 30))).toBe('2026-10-16');
  });

  it('validates terms like the API', () => {
    const supplier = { id: '00000000-0000-4000-8000-000000000009', displayName: 'Supplier SRL' };
    expect(termsBody(formOf({ acquisition: 'SUBLEASED', validFrom: '2026-10-01' }), null, null)).toEqual({
      error: 'A subleased asset needs its supplier',
    });
    expect(
      termsBody(formOf({ acquisition: 'DIRECT', validFrom: '2026-10-01', costAmount: '1200' }), null, null),
    ).toEqual({ error: 'Give the cost and its unit together' });
    expect(
      termsBody(
        formOf({
          acquisition: 'SUBLEASED',
          validFrom: '2026-10-01',
          costAmount: '1200,50',
          costUnit: 'MONTH',
          currency: 'EUR',
          contractRef: '',
        }),
        null,
        supplier,
      ),
    ).toEqual({
      body: {
        acquisition: 'SUBLEASED',
        ownerOrganisationId: null,
        supplierOrganisationId: supplier.id,
        costAmount: '1200.50',
        costUnit: 'MONTH',
        currency: 'EUR',
        validFrom: '2026-10-01',
        validTo: null,
        contractRef: null,
      },
    });
  });

  it('validates blocks', () => {
    expect(blockBody(formOf({ from: '2026-10-10', to: '2026-10-01', reason: 'Repair' }))).toEqual({
      error: 'The end is before the start',
    });
    expect(blockBody(formOf({ faceId: '', from: '2026-10-01', to: '2026-10-10', reason: 'Repair' }))).toEqual(
      {
        body: { from: '2026-10-01', to: '2026-10-10', reason: 'Repair' },
      },
    );
  });
});

describe('uploads', () => {
  it('checks type and size before uploading', () => {
    expect(uploadProblem({ type: 'image/jpeg', size: 1000 })).toBeNull();
    expect(uploadProblem({ type: 'image/gif', size: 1000 })).toMatch(/only/);
    expect(uploadProblem({ type: 'image/jpeg', size: 26 * 1024 * 1024 })).toBe(
      'The file is larger than 25 MB.',
    );
    expect(uploadProblem({ type: 'application/pdf', size: 0 })).toBe('The file is empty.');
  });

  it('polls only uploads that are being checked', () => {
    expect(isProcessing({ status: 'PENDING', uploadedAt: '2026-10-16T10:00:00Z' })).toBe(true);
    expect(isProcessing({ status: 'PENDING', uploadedAt: null })).toBe(false);
    expect(isProcessing({ status: 'READY', uploadedAt: '2026-10-16T10:00:00Z' })).toBe(false);
    expect(fileStatusLabel({ status: 'PENDING', uploadedAt: null })).toBe('Upload not finished');
    expect(fileStatusLabel({ status: 'PENDING', uploadedAt: '2026-10-16T10:00:00Z' })).toBe('Checking…');
    expect(formatBytes(2_500_000)).toBe('2.4 MB');
  });

  it('hashes with SHA-256 as hex', async () => {
    const bytes = new TextEncoder().encode('abc');
    expect(await sha256Hex(bytes.buffer)).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
