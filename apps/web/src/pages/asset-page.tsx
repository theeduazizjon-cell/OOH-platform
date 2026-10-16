import {
  ASSET_TRANSITIONS,
  type AssetAction,
  type AssetDetail,
  etagOf,
  IF_MATCH_HEADER,
} from '@ooh/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert, Card } from '@/components/ui/card';
import { api, ApiError } from '@/lib/api';
import { hasPermission, useMe } from '@/lib/me';
import { AssetFiles } from './asset-files';
import { AssetForm, type AssetFormValues } from './asset-form';
import {
  addressLine,
  LifecycleBadge,
  mapsLink,
  streetViewLink,
  structureSummary,
  useAssetTypes,
  VERIFICATION_LABELS,
} from './asset-status';
import { AssetStructure, type SendChange } from './asset-structure';
import { AssetBlocks, AssetTerms } from './asset-terms';
import { ReasonForm } from './campaign-page';

export const ASSET_CONFLICT_MESSAGE =
  'Someone else changed this asset in the meantime. It has been reloaded; check it and try again.';

const ACTION_LABELS: Record<AssetAction, string> = {
  activate: 'Activate',
  suspend: 'Suspend',
  reinstate: 'Reinstate',
  decommission: 'Decommission',
};
const PAST: Record<AssetAction, string> = {
  activate: 'activated',
  suspend: 'suspended',
  reinstate: 'reinstated',
  decommission: 'decommissioned',
};

/** PATCH body: the point only when it moved (moving re-runs the 10 m duplicate check). */
export function updateAssetBody(
  asset: Pick<AssetDetail, 'location'>,
  values: AssetFormValues,
  duplicateReason: string | null,
) {
  const moved = values.lat !== asset.location.lat || values.lng !== asset.location.lng;
  return {
    ...(moved ? { lat: values.lat, lng: values.lng } : {}),
    address: values.address,
    city: values.city,
    county: values.county,
    attributes: values.attributes,
    notes: values.notes,
    ...(duplicateReason ? { duplicateOverride: { reason: duplicateReason } } : {}),
  };
}

/** A 422 from an action lists what is missing (e.g. activation: terms covering today, a photo). */
export function actionError(caught: unknown): string {
  if (!(caught instanceof ApiError)) return 'Could not reach the server. Try again.';
  const missing = caught.problem?.errors?.map((e) => e.message) ?? [];
  return missing.length > 0 ? `${caught.message} Missing: ${missing.join('; ')}.` : caught.message;
}

type Pending = { action: 'suspend' } | { action: 'decommission' } | null;

/**
 * Asset passport (09-screen-map.md, R§14): identity and lifecycle, location with Maps and Street
 * View, the mounts → faces structure, photos and documents, terms history and availability blocks.
 * Verifications, bookings and history join with field jobs (M9) and studies (M6–M7).
 */
export function AssetPage({ assetId }: { assetId: string }) {
  const { data: me } = useMe();
  const queryClient = useQueryClient();
  const types = useAssetTypes();
  const [pending, setPending] = useState<Pending>(null);
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const opened = useQuery({
    queryKey: ['asset', assetId],
    queryFn: () => api.request<AssetDetail>(`/assets/${assetId}`),
  });
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['assets'] });
    await queryClient.invalidateQueries({ queryKey: ['asset', assetId] });
  };

  /** Changes send If-Match when versioned; on 412 the asset reloads and the error explains why. */
  const send: SendChange = async (path, method, json, version) => {
    try {
      await api.request(path, {
        method,
        json,
        ...(version === undefined ? {} : { headers: { [IF_MATCH_HEADER]: etagOf(version) } }),
      });
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'PRECONDITION_FAILED') {
        throw new ApiError(caught.status, { ...caught.problem!, detail: ASSET_CONFLICT_MESSAGE });
      }
      throw caught;
    } finally {
      await refresh();
    }
  };

  async function act(action: AssetAction, body: unknown = {}) {
    const a = opened.data!;
    setError(null);
    setNotice(null);
    try {
      await send(`/assets/${a.id}/actions/${action}`, 'POST', body, a.version);
      setPending(null);
      setNotice(`${a.code} ${PAST[action]}.`);
    } catch (caught) {
      setError(actionError(caught));
    }
  }

  const back = (
    <Link to="/app/inventory" className="text-sm text-brand-700 hover:underline">
      ← Inventory
    </Link>
  );
  if (opened.isLoading) return <p className="text-sm text-slate-500">Loading…</p>;
  if (!opened.data) {
    return (
      <div className="max-w-6xl space-y-3">
        {back}
        <Alert>{opened.error?.message ?? 'Asset not found.'}</Alert>
      </div>
    );
  }
  const a = opened.data;
  const type = types.data?.find((t) => t.id === a.type.id);
  const live = a.lifecycle !== 'DECOMMISSIONED';
  const canUpdate = live && hasPermission(me, 'asset.update');
  const actions = a.actions.filter((x) => hasPermission(me, ASSET_TRANSITIONS[x].permission));
  const attributes = Object.entries(a.attributes);

  return (
    <div className="max-w-6xl space-y-4">
      {back}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold">
            {a.code} <LifecycleBadge lifecycle={a.lifecycle} />
          </h1>
          <p className="text-sm text-slate-600">
            {[a.type.name, structureSummary(a), VERIFICATION_LABELS[a.verificationStatus]].join(' · ')}
          </p>
          <p className="text-sm text-slate-600">{addressLine(a) || 'No address recorded.'}</p>
          {a.suspendReason && <p className="text-sm text-amber-800">Suspended: {a.suspendReason}</p>}
        </div>
        <span className="flex flex-wrap gap-2">
          {actions.map((x) => (
            <Button
              key={x}
              variant={x === 'activate' ? 'primary' : x === 'decommission' ? 'ghost' : 'secondary'}
              className={x === 'decommission' ? 'text-red-700' : ''}
              onClick={() =>
                x === 'suspend' || x === 'decommission' ? setPending({ action: x }) : void act(x)
              }
            >
              {ACTION_LABELS[x]}
            </Button>
          ))}
        </span>
      </div>

      {notice && (
        <p role="status" className="text-sm text-slate-600">
          {notice}
        </p>
      )}
      {error && <Alert>{error}</Alert>}
      {pending?.action === 'suspend' && (
        <ReasonForm
          title={`Suspend ${a.code}`}
          hint="It stays in the inventory but can't be offered until it is reinstated."
          onCancel={() => setPending(null)}
          onConfirm={(reason) => act('suspend', { reason })}
        />
      )}
      {pending?.action === 'decommission' && (
        <div
          role="alertdialog"
          aria-label={`Decommission ${a.code}`}
          className="space-y-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm"
        >
          <p className="font-medium">Decommission {a.code}?</p>
          <p className="text-slate-700">
            It leaves the inventory for good: it can no longer be edited, offered or booked. Its history
            stays.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setPending(null)}>
              Back
            </Button>
            <Button className="bg-red-700 hover:bg-red-800" onClick={() => void act('decommission')}>
              Decommission
            </Button>
          </div>
        </div>
      )}

      <Section
        title="Location and details"
        action={
          canUpdate &&
          !editing &&
          types.data && (
            <Button variant="secondary" className="h-8" onClick={() => setEditing(true)}>
              Edit
            </Button>
          )
        }
      >
        {editing && types.data ? (
          <AssetForm
            types={types.data}
            initial={a}
            submitLabel="Save asset"
            onCancel={() => setEditing(false)}
            onSubmit={async (values, reason) => {
              await send(`/assets/${a.id}`, 'PATCH', updateAssetBody(a, values, reason), a.version);
              setEditing(false);
              setNotice(`${a.code} saved.`);
            }}
          />
        ) : (
          <div className="grid gap-4 text-sm sm:grid-cols-2">
            <div className="space-y-1">
              <p>
                <span className="text-slate-500">Coordinates </span>
                {a.location.lat.toFixed(6)}, {a.location.lng.toFixed(6)}
              </p>
              <p className="flex flex-wrap gap-3">
                <a
                  href={mapsLink(a.location)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-brand-700 hover:underline"
                >
                  Open in Google Maps ↗
                </a>
                <a
                  href={streetViewLink(a)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-brand-700 hover:underline"
                >
                  Street View ↗
                </a>
              </p>
              {a.lastVerifiedAt && (
                <p className="text-slate-500">Last verified {a.lastVerifiedAt.slice(0, 10)}</p>
              )}
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              {attributes.length === 0 && (
                <dd className="col-span-2 text-slate-500">No attributes recorded.</dd>
              )}
              {attributes.map(([key, value]) => (
                <div key={key} className="contents">
                  <dt className="text-slate-500">{type?.attributeSchema[key]?.label ?? key}</dt>
                  <dd>{typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value)}</dd>
                </div>
              ))}
            </dl>
            {a.notes && <p className="whitespace-pre-line text-slate-700 sm:col-span-2">{a.notes}</p>}
          </div>
        )}
      </Section>

      <Section title="Structure">
        <AssetStructure asset={a} type={type} canEdit={canUpdate} send={send} />
      </Section>

      <Section title="Photos and documents">
        <AssetFiles assetId={a.id} canUpload={canUpdate} onChanged={() => void refresh()} />
      </Section>

      {a.terms && (
        <Section title="Terms">
          <AssetTerms
            asset={a}
            terms={a.terms}
            canManage={hasPermission(me, 'asset.terms.manage')}
            send={send}
          />
        </Section>
      )}

      <Section title="Availability blocks">
        <AssetBlocks asset={a} canManage={hasPermission(me, 'asset.availability.manage')} send={send} />
      </Section>
    </div>
  );
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </Card>
  );
}
