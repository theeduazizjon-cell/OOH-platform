import {
  ASSET_LIFECYCLES,
  type AssetDetail,
  type AssetLifecycle,
  MAP_POINTS_LIMIT,
  MAP_POINTS_MIN_ZOOM,
  type MapPoint,
} from '@ooh/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { InfoWindow, Map, useMap } from '@vis.gl/react-google-maps';
import { type FormEvent, useCallback, useState } from 'react';
import { type AssetLayerStatus, AssetLayer } from '@/components/map/asset-layer';
import { MapsProvider, MapUnavailable, useMapsEnabled } from '@/components/map/maps';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { DEFAULT_VIEW, LIFECYCLE_COLORS, mapsConfig, POINT_ZOOM } from '@/lib/map';
import {
  addressLine,
  LifecycleBadge,
  LIFECYCLE_LABELS,
  mapsLink,
  streetViewLink,
  structureSummary,
  useAssetTypes,
} from './asset-status';
import { parseCoordinates } from './location-pin';

const ALL = 'all';

export interface MapViewport {
  center: { lat: number; lng: number };
  zoom: number;
}

/** One line under the filters: what is drawn and what to do to see more. */
export function layerStatusText(status: AssetLayerStatus | null, zoom: number): string {
  if (!status || status.count === null) return status?.error ?? 'Loading assets…';
  if (status.error) return status.error;
  if (status.truncated) return `Showing the first ${MAP_POINTS_LIMIT} assets here: zoom in to see all.`;
  const n = `${status.count} asset${status.count === 1 ? '' : 's'} in view`;
  return zoom < MAP_POINTS_MIN_ZOOM ? `${n} · grouped: click a group or zoom in to see each asset` : n;
}

/**
 * The inventory on a map (09-screen-map.md "Map"): server clusters when zoomed out, every asset from
 * zoom 13, filters by type and status, an asset card on click, Street View from the map's own control.
 */
export function MapPage({
  initial,
  onViewportChange,
}: {
  initial: MapViewport | null;
  onViewportChange: (v: MapViewport) => void;
}) {
  const enabled = useMapsEnabled();
  const types = useAssetTypes();
  const [typeId, setTypeId] = useState<string>(ALL);
  const [lifecycle, setLifecycle] = useState<AssetLifecycle | typeof ALL>(ALL);
  const [status, setStatus] = useState<AssetLayerStatus | null>(null);
  const [zoom, setZoom] = useState(initial?.zoom ?? DEFAULT_VIEW.zoom);
  const [selected, setSelected] = useState<MapPoint | null>(null);
  const onStatus = useCallback((s: AssetLayerStatus) => setStatus(s), []);

  return (
    <div className="flex h-[calc(100dvh-7rem)] min-h-[28rem] flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Map</h1>
        <select
          aria-label="Asset type"
          value={typeId}
          onChange={(e) => setTypeId(e.currentTarget.value)}
          className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm"
        >
          <option value={ALL}>All types</option>
          {(types.data ?? [])
            .filter((t) => t.active)
            .map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
        </select>
        <select
          aria-label="Status"
          value={lifecycle}
          onChange={(e) => setLifecycle(e.currentTarget.value as AssetLifecycle | typeof ALL)}
          className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm"
        >
          <option value={ALL}>Any status except decommissioned</option>
          {ASSET_LIFECYCLES.map((l) => (
            <option key={l} value={l}>
              {LIFECYCLE_LABELS[l]}
            </option>
          ))}
        </select>
        <Legend />
      </div>

      {!enabled ? (
        <MapUnavailable className="flex-1">
          <Link to="/app/inventory" className="text-brand-700 hover:underline">
            Use the inventory list instead
          </Link>
        </MapUnavailable>
      ) : (
        <MapsProvider>
          <GoTo />
          <p className="text-sm text-slate-600" aria-live="polite">
            {layerStatusText(status, zoom)}
          </p>
          <div className="relative flex-1 overflow-hidden rounded-lg border border-slate-200">
            <Map
              mapId={mapsConfig().mapId}
              defaultCenter={initial?.center ?? DEFAULT_VIEW.center}
              defaultZoom={initial?.zoom ?? DEFAULT_VIEW.zoom}
              gestureHandling="greedy"
              clickableIcons={false}
              streetViewControl
              mapTypeControl
              className="h-full w-full"
              onIdle={(e) => {
                const center = e.map.getCenter()?.toJSON();
                const z = Math.round(e.map.getZoom() ?? DEFAULT_VIEW.zoom);
                setZoom(z);
                if (center) onViewportChange({ center, zoom: z });
              }}
              onClick={() => setSelected(null)}
            >
              <AssetLayer
                assetTypeId={typeId === ALL ? undefined : typeId}
                lifecycle={lifecycle === ALL ? undefined : lifecycle}
                onSelect={setSelected}
                onStatus={onStatus}
              />
              {selected && (
                <InfoWindow
                  position={{ lat: selected.lat, lng: selected.lng }}
                  pixelOffset={[0, -10]}
                  onCloseClick={() => setSelected(null)}
                  headerContent={<span className="font-semibold">{selected.code}</span>}
                >
                  <AssetCard point={selected} />
                </InfoWindow>
              )}
            </Map>
          </div>
        </MapsProvider>
      )}
    </div>
  );
}

function Legend() {
  return (
    <ul className="flex flex-wrap gap-3 text-xs text-slate-600" aria-label="Legend">
      {ASSET_LIFECYCLES.filter((l) => l !== 'DECOMMISSIONED').map((l) => (
        <li key={l} className="flex items-center gap-1">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ background: LIFECYCLE_COLORS[l] }}
          />
          {LIFECYCLE_LABELS[l]}
        </li>
      ))}
    </ul>
  );
}

/** Jump to pasted coordinates or a Google Maps link. */
function GoTo() {
  const map = useMap();
  const [error, setError] = useState<string | null>(null);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get('goto');
    const point = parseCoordinates(typeof value === 'string' ? value : '');
    if (!point) return setError('Paste coordinates like "45.3486, 25.5517" or a Google Maps link.');
    setError(null);
    map?.panTo(point);
    map?.setZoom(POINT_ZOOM);
  }
  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2" aria-label="Go to a point">
      <Input
        name="goto"
        aria-label="Coordinates or Google Maps link"
        placeholder="Go to 45.3486, 25.5517"
        className="max-w-xs"
      />
      <Button type="submit" variant="secondary">
        Go
      </Button>
      {error && <span className="text-sm text-red-700">{error}</span>}
    </form>
  );
}

/** The clicked asset: loads its details for the card. */
export function AssetCard({ point }: { point: MapPoint }) {
  const asset = useQuery({
    queryKey: ['asset', point.id],
    queryFn: () => api.request<AssetDetail>(`/assets/${point.id}`),
  });
  const a = asset.data;
  return (
    <div className="min-w-56 space-y-1.5 text-sm">
      {asset.isLoading && <p className="text-slate-500">Loading…</p>}
      {asset.error && <p className="text-red-700">{asset.error.message}</p>}
      {a && (
        <>
          <p className="text-slate-600">
            {a.type.name} · {structureSummary(a)}
          </p>
          <p>{addressLine(a) || `${a.location.lat.toFixed(5)}, ${a.location.lng.toFixed(5)}`}</p>
          <LifecycleBadge lifecycle={a.lifecycle} />
          <p className="flex flex-wrap gap-3 pt-1">
            <Link
              to="/app/inventory/$assetId"
              params={{ assetId: a.id }}
              className="font-medium text-brand-700 hover:underline"
            >
              Open asset
            </Link>
            <a
              href={streetViewLink(a)}
              target="_blank"
              rel="noreferrer"
              className="text-brand-700 hover:underline"
            >
              Street View ↗
            </a>
            <a
              href={mapsLink(a.location)}
              target="_blank"
              rel="noreferrer"
              className="text-brand-700 hover:underline"
            >
              Google Maps ↗
            </a>
          </p>
        </>
      )}
    </div>
  );
}
