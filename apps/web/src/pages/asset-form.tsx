import {
  type AssetDetail,
  type AssetTypeItem,
  type AttributeSpec,
  attributeProblems,
  DUPLICATE_RADIUS_M,
  type NearbyAsset,
} from '@ooh/contracts';
import { Link } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { ApiError } from '@/lib/api';
import { LIFECYCLE_LABELS } from './asset-status';
import { parseCoordinates } from './location-pin';

export interface AssetFormValues {
  assetTypeId: string;
  lat: number;
  lng: number;
  address: string | null;
  city: string | null;
  county: string | null;
  attributes: Record<string, string | number | boolean>;
  notes: string | null;
}

type AttributeValues = AssetFormValues['attributes'];

const text = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
};

/**
 * The type's attributes from the form (blank ones left out), checked against the type's schema
 * with the same rules as the API.
 */
export function readAttributes(
  schema: Record<string, AttributeSpec>,
  form: FormData,
): { values: AttributeValues; problems: string[] } {
  const values: AttributeValues = {};
  for (const [key, spec] of Object.entries(schema)) {
    const name = `attr.${key}`;
    if (spec.type === 'boolean') {
      if (form.get(name) === 'on') values[key] = true;
      continue;
    }
    const raw = text(form, name);
    if (raw === null) continue;
    values[key] = spec.type === 'string' ? raw : Number(raw.replace(',', '.'));
  }
  return { values, problems: attributeProblems(schema, values).map((p) => p.message) };
}

/**
 * Create an asset, or edit its location and details (09-screen-map.md "create/edit asset"). The map
 * picker arrives with the Map module (M5); until then the point is typed or pasted from Google Maps.
 * A same-kind asset within 10 m answers 409 DUPLICATE_SUSPECTED: the form lists it and asks for a
 * reason before trying again.
 */
export function AssetForm({
  types,
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  types: readonly AssetTypeItem[];
  initial?: AssetDetail;
  submitLabel: string;
  onSubmit: (values: AssetFormValues, duplicateReason: string | null) => Promise<void>;
  onCancel: () => void;
}) {
  const choosable = types.filter((t) => t.active || t.id === initial?.type.id);
  const [typeId, setTypeId] = useState(initial?.type.id ?? choosable[0]?.id ?? '');
  const [errors, setErrors] = useState<string[]>([]);
  const [nearby, setNearby] = useState<NearbyAsset[] | null>(null);
  const [saving, setSaving] = useState(false);
  const type = types.find((t) => t.id === typeId);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const point = parseCoordinates(text(form, 'coordinates') ?? '');
    const attributes = type ? readAttributes(type.attributeSchema, form) : null;
    const reason = nearby ? text(form, 'duplicateReason') : null;
    const problems = [
      ...(type ? [] : ['Choose the type.']),
      ...(point ? [] : ['Paste coordinates like "45.3486, 25.5517" or a Google Maps link to the spot.']),
      ...(attributes?.problems ?? []),
      ...(nearby && (reason ?? '').length < 3 ? ['Say why this is a different asset.'] : []),
    ];
    setErrors(problems);
    if (problems.length > 0 || !type || !point || !attributes) return;

    setSaving(true);
    try {
      await onSubmit(
        {
          assetTypeId: type.id,
          lat: point.lat,
          lng: point.lng,
          address: text(form, 'address'),
          city: text(form, 'city'),
          county: text(form, 'county'),
          attributes: attributes.values,
          notes: text(form, 'notes'),
        },
        reason,
      );
    } catch (caught) {
      const near = caught instanceof ApiError ? caught.problem?.meta?.nearby : undefined;
      if (caught instanceof ApiError && caught.code === 'DUPLICATE_SUSPECTED' && Array.isArray(near)) {
        setNearby(near as NearbyAsset[]);
        setErrors([caught.message]);
      } else {
        setErrors([caught instanceof ApiError ? caught.message : 'Could not reach the server. Try again.']);
      }
    } finally {
      setSaving(false);
    }
  }

  const current = initial?.location;
  return (
    <form className="space-y-4" onSubmit={(e) => void submit(e)} noValidate aria-label={submitLabel}>
      {errors.length > 0 && (
        <Alert>
          {errors.length === 1 ? (
            errors[0]
          ) : (
            <ul className="list-disc pl-4">
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
        </Alert>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="asset-type">Type</Label>
          <select
            id="asset-type"
            value={typeId}
            disabled={Boolean(initial)}
            onChange={(e) => setTypeId(e.currentTarget.value)}
            className="h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm disabled:bg-slate-50"
          >
            {choosable.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          {type && !initial && (
            <p className="text-xs text-slate-500">
              Code {type.codePrefix}-000001…; starts with {type.defaultMountPositions} mount
              {type.defaultMountPositions === 1 ? '' : 's'} × {type.facesPerMount} face
              {type.facesPerMount === 1 ? '' : 's'}.
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="asset-coordinates">Coordinates or Google Maps link</Label>
          <Input
            id="asset-coordinates"
            name="coordinates"
            placeholder="45.3486, 25.5517"
            defaultValue={current ? `${current.lat}, ${current.lng}` : ''}
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="asset-address">Address</Label>
          <Input id="asset-address" name="address" maxLength={300} defaultValue={initial?.address ?? ''} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="asset-city">City</Label>
          <Input id="asset-city" name="city" maxLength={100} defaultValue={initial?.city ?? ''} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="asset-county">County</Label>
          <Input id="asset-county" name="county" maxLength={100} defaultValue={initial?.county ?? ''} />
        </div>
        {type &&
          Object.entries(type.attributeSchema).map(([key, spec]) => (
            <AttributeField
              key={`${type.id}.${key}`}
              name={key}
              spec={spec}
              value={initial?.attributes[key]}
            />
          ))}
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="asset-notes">Notes</Label>
          <textarea
            id="asset-notes"
            name="notes"
            rows={3}
            maxLength={5000}
            defaultValue={initial?.notes ?? ''}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </div>
      </div>

      {nearby && (
        <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm">
          <p className="font-medium">Within {DUPLICATE_RADIUS_M} m of this point:</p>
          <ul className="space-y-1">
            {nearby.map((n) => (
              <li key={n.id}>
                <Link
                  to="/app/inventory/$assetId"
                  params={{ assetId: n.id }}
                  className="font-medium text-brand-700 hover:underline"
                >
                  {n.code}
                </Link>{' '}
                · {n.distanceM} m · {LIFECYCLE_LABELS[n.lifecycle]}
              </li>
            ))}
          </ul>
          <div className="space-y-1.5">
            <Label htmlFor="asset-duplicate-reason">Why is this a different asset?</Label>
            <Input id="asset-duplicate-reason" name="duplicateReason" maxLength={500} />
          </div>
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? 'Saving…' : nearby ? `${submitLabel} anyway` : submitLabel}
        </Button>
      </div>
    </form>
  );
}

function AttributeField({
  name,
  spec,
  value,
}: {
  name: string;
  spec: AttributeSpec;
  value: string | number | boolean | undefined;
}) {
  const id = `asset-attr-${name}`;
  const label = spec.required ? spec.label : `${spec.label} (optional)`;
  if (spec.type === 'boolean') {
    return (
      <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
        <input type="checkbox" name={`attr.${name}`} defaultChecked={value === true} />
        {spec.label}
      </label>
    );
  }
  if (spec.enum) {
    return (
      <div className="space-y-1.5">
        <Label htmlFor={id}>{label}</Label>
        <select
          id={id}
          name={`attr.${name}`}
          defaultValue={typeof value === 'string' ? value : ''}
          className="h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
        >
          <option value="">—</option>
          {spec.enum.map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        name={`attr.${name}`}
        inputMode={spec.type === 'string' ? 'text' : 'decimal'}
        defaultValue={value === undefined ? '' : String(value)}
      />
    </div>
  );
}
