import type {
  AssetDetail,
  AssetTypeItem,
  DimensionPresetItem,
  FaceItem,
  MountItem,
  MountRequest,
  UpdateFaceRequest,
} from '@ooh/contracts';
import { useQuery } from '@tanstack/react-query';
import { Lightbulb } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { faceSize } from './asset-status';

/** Sends a change (If-Match when a version is given); the passport reloads afterwards. */
export type SendChange = (
  path: string,
  method: 'POST' | 'PATCH',
  json: unknown,
  version?: number,
) => Promise<void>;

const METRES = /^\d{1,4}(\.\d{1,2})?$/;

/** '' → null; a whole compass bearing 0–359; undefined when invalid. */
export function parseBearing(text: string): number | null | undefined {
  const value = text.trim();
  if (value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 359 ? n : undefined;
}

/** '' → null; metres like "0.8" or "12" (comma accepted) as the API's decimal string; undefined when invalid. */
export function parseMetres(text: string): string | null | undefined {
  const value = text.trim().replace(',', '.');
  if (value === '') return null;
  return METRES.test(value) ? value : undefined;
}

const field = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};

export function mountBody(form: FormData): { body: MountRequest } | { error: string } {
  const orientationBearing = parseBearing(field(form, 'orientationBearing'));
  const heightM = parseMetres(field(form, 'heightM'));
  if (orientationBearing === undefined) return { error: 'The orientation is a bearing from 0 to 359°.' };
  if (heightM === undefined) return { error: 'Give the height in metres, like 3.5.' };
  const notes = field(form, 'notes').trim();
  return { body: { orientationBearing, heightM, notes: notes === '' ? null : notes } };
}

/** A preset copies its size (server side); "custom" sends the size typed in. */
export function faceBody(form: FormData): { body: UpdateFaceRequest } | { error: string } {
  const facingBearing = parseBearing(field(form, 'facingBearing'));
  if (facingBearing === undefined) return { error: 'The facing is a bearing from 0 to 359°.' };
  const traffic = field(form, 'visibleTrafficDirection').trim();
  const common = {
    facingBearing,
    visibleTrafficDirection: traffic === '' ? null : traffic,
    illuminated: form.get('illuminated') === 'on',
  };
  const preset = field(form, 'preset');
  if (preset !== '') return { body: { ...common, dimensionPresetId: preset } };
  const widthM = parseMetres(field(form, 'widthM'));
  const heightM = parseMetres(field(form, 'heightM'));
  if (widthM === undefined || heightM === undefined)
    return { error: 'Give the size in metres, like 0.8 × 2.' };
  if ((widthM === null) !== (heightM === null)) return { error: 'Give both the width and the height.' };
  return { body: { ...common, dimensionPresetId: null, widthM, heightM } };
}

function usePresets() {
  const { session } = useAuth();
  return useQuery({
    queryKey: ['dimension-presets', session?.tenantId],
    queryFn: () => api.request<DimensionPresetItem[]>('/config/dimension-presets'),
    staleTime: 5 * 60_000,
  });
}

type Editing = { kind: 'mount'; id: string } | { kind: 'face'; id: string } | null;

/**
 * Mount positions and their faces (the passport's structure diagram): one column per mount, one
 * tile per face. The face is the booking unit (OPD-02); a type may book a mount's faces together.
 */
export function AssetStructure({
  asset,
  type,
  canEdit,
  send,
}: {
  asset: AssetDetail;
  type: AssetTypeItem | undefined;
  canEdit: boolean;
  send: SendChange;
}) {
  const [editing, setEditing] = useState<Editing>(null);
  const [error, setError] = useState<string | null>(null);
  const presets = usePresets();
  const max = type?.maxMountPositions ?? null;
  const canAddMount = canEdit && (max === null || asset.mounts.length < max);

  async function save(change: () => Promise<void>) {
    setError(null);
    try {
      await change();
      setEditing(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not reach the server. Try again.');
    }
  }

  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}
      {type?.facesBookedTogether && (
        <p className="text-xs text-slate-500">The faces of a mount are booked together.</p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {asset.mounts.map((mount) => (
          <div
            key={mount.id}
            className="rounded-md border border-slate-200 p-3"
            aria-label={`Mount ${mount.positionNo}`}
          >
            {editing?.kind === 'mount' && editing.id === mount.id ? (
              <MountForm
                mount={mount}
                onCancel={() => setEditing(null)}
                onSave={(body) => save(() => send(`/mounts/${mount.id}`, 'PATCH', body, mount.version))}
              />
            ) : (
              <div className="mb-2 flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-medium">Mount {mount.positionNo}</p>
                  <p className="text-xs text-slate-500">
                    {[
                      mount.orientationBearing !== null && `orientation ${mount.orientationBearing}°`,
                      mount.heightM && `${Number(mount.heightM)} m high`,
                    ]
                      .filter(Boolean)
                      .join(' · ') || 'Orientation and height not recorded'}
                  </p>
                  {mount.notes && <p className="text-xs text-slate-600">{mount.notes}</p>}
                </div>
                {canEdit && (
                  <Button
                    variant="ghost"
                    className="h-7 px-2"
                    aria-label={`Edit mount ${mount.positionNo}`}
                    onClick={() => setEditing({ kind: 'mount', id: mount.id })}
                  >
                    Edit
                  </Button>
                )}
              </div>
            )}
            <ul className="space-y-2">
              {mount.faces.map((face) =>
                editing?.kind === 'face' && editing.id === face.id ? (
                  <li key={face.id} className="rounded-md bg-slate-50 p-2">
                    <FaceForm
                      face={face}
                      presets={presets.data ?? []}
                      onCancel={() => setEditing(null)}
                      onSave={(body) => save(() => send(`/faces/${face.id}`, 'PATCH', body, face.version))}
                    />
                  </li>
                ) : (
                  <li
                    key={face.id}
                    className="flex items-start justify-between gap-2 rounded-md border border-slate-100 bg-slate-50 px-2 py-1.5"
                  >
                    <FaceSummary face={face} presets={presets.data ?? []} />
                    {canEdit && (
                      <Button
                        variant="ghost"
                        className="h-7 px-2"
                        aria-label={`Edit face ${mount.positionNo}${face.faceCode}`}
                        onClick={() => setEditing({ kind: 'face', id: face.id })}
                      >
                        Edit
                      </Button>
                    )}
                  </li>
                ),
              )}
            </ul>
          </div>
        ))}
      </div>
      {canAddMount && (
        <Button
          variant="secondary"
          className="h-8"
          onClick={() => void save(() => send(`/assets/${asset.id}/mounts`, 'POST', {}))}
        >
          Add mount
        </Button>
      )}
    </div>
  );
}

function FaceSummary({ face, presets }: { face: FaceItem; presets: readonly DimensionPresetItem[] }) {
  const preset = presets.find((p) => p.id === face.dimensionPresetId);
  const size = faceSize(face);
  return (
    <div className="text-sm">
      <span className="font-medium">Face {face.faceCode}</span>{' '}
      <span className="text-slate-600">
        {size ?? 'size not set'}
        {preset && preset.name !== size && ` (${preset.name})`}
      </span>
      {face.illuminated && (
        <span className="ml-1 inline-flex items-center gap-0.5 text-xs text-amber-700">
          <Lightbulb aria-hidden className="h-3 w-3" /> lit
        </span>
      )}
      <span className="block text-xs text-slate-500">
        {[
          face.facingBearing !== null && `faces ${face.facingBearing}°`,
          face.visibleTrafficDirection && `seen from ${face.visibleTrafficDirection}`,
        ]
          .filter(Boolean)
          .join(' · ')}
      </span>
    </div>
  );
}

function MountForm({
  mount,
  onSave,
  onCancel,
}: {
  mount: MountItem;
  onSave: (body: MountRequest) => Promise<void>;
  onCancel: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = mountBody(new FormData(event.currentTarget));
    if ('error' in result) return setError(result.error);
    setError(null);
    void onSave(result.body);
  }
  const id = `mount-${mount.id}`;
  return (
    <form className="mb-2 space-y-2" onSubmit={submit} noValidate aria-label={`Mount ${mount.positionNo}`}>
      <p className="text-sm font-medium">Mount {mount.positionNo}</p>
      {error && <Alert>{error}</Alert>}
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label htmlFor={`${id}-bearing`}>Orientation (°)</Label>
          <Input
            id={`${id}-bearing`}
            name="orientationBearing"
            inputMode="numeric"
            defaultValue={mount.orientationBearing ?? ''}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-height`}>Height (m)</Label>
          <Input id={`${id}-height`} name="heightM" inputMode="decimal" defaultValue={mount.heightM ?? ''} />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-notes`}>Notes</Label>
        <Input id={`${id}-notes`} name="notes" maxLength={2000} defaultValue={mount.notes ?? ''} />
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" className="h-8" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" className="h-8">
          Save mount
        </Button>
      </div>
    </form>
  );
}

function FaceForm({
  face,
  presets,
  onSave,
  onCancel,
}: {
  face: FaceItem;
  presets: readonly DimensionPresetItem[];
  onSave: (body: UpdateFaceRequest) => Promise<void>;
  onCancel: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [preset, setPreset] = useState(face.dimensionPresetId ?? '');
  const choosable = presets.filter((p) => p.active || p.id === face.dimensionPresetId);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = faceBody(new FormData(event.currentTarget));
    if ('error' in result) return setError(result.error);
    setError(null);
    void onSave(result.body);
  }
  const id = `face-${face.id}`;
  return (
    <form className="space-y-2" onSubmit={submit} noValidate aria-label={`Face ${face.faceCode}`}>
      <p className="text-sm font-medium">Face {face.faceCode}</p>
      {error && <Alert>{error}</Alert>}
      <div className="space-y-1">
        <Label htmlFor={`${id}-preset`}>Size</Label>
        <select
          id={`${id}-preset`}
          name="preset"
          value={preset}
          onChange={(e) => setPreset(e.currentTarget.value)}
          className="h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
        >
          <option value="">Custom size</option>
          {choosable.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      {preset === '' && (
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label htmlFor={`${id}-width`}>Width (m)</Label>
            <Input id={`${id}-width`} name="widthM" inputMode="decimal" defaultValue={face.widthM ?? ''} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${id}-height`}>Height (m)</Label>
            <Input id={`${id}-height`} name="heightM" inputMode="decimal" defaultValue={face.heightM ?? ''} />
          </div>
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label htmlFor={`${id}-bearing`}>Facing (°)</Label>
          <Input
            id={`${id}-bearing`}
            name="facingBearing"
            inputMode="numeric"
            defaultValue={face.facingBearing ?? ''}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-traffic`}>Seen from</Label>
          <Input
            id={`${id}-traffic`}
            name="visibleTrafficDirection"
            maxLength={200}
            placeholder="e.g. traffic towards Brașov"
            defaultValue={face.visibleTrafficDirection ?? ''}
          />
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="illuminated" defaultChecked={face.illuminated} /> Illuminated
      </label>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" className="h-8" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" className="h-8">
          Save face
        </Button>
      </div>
    </form>
  );
}
