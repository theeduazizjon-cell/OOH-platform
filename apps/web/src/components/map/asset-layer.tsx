import { MarkerClusterer } from '@googlemaps/markerclusterer';
import { type AssetLifecycle, type MapAssetsResponse, type MapCluster, type MapPoint } from '@ooh/contracts';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AdvancedMarker, useMap, useMapsLibrary } from '@vis.gl/react-google-maps';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { bboxParam, clusterClickZoom, compactCount, LIFECYCLE_COLORS } from '@/lib/map';

export interface AssetLayerStatus {
  loading: boolean;
  error: string | null;
  /** Assets in view (clusters: their total; points: how many were returned). */
  count: number | null;
  /** Points mode hit MAP_POINTS_LIMIT: zoom in to see all. */
  truncated: boolean;
}

/** /map/assets query string for a viewport and filters. */
export function mapAssetsPath(
  viewport: { bbox: string; zoom: number },
  filters: { assetTypeId?: string; lifecycle?: AssetLifecycle },
): string {
  const params = new URLSearchParams({ bbox: viewport.bbox, zoom: String(viewport.zoom) });
  if (filters.assetTypeId) params.set('assetTypeId', filters.assetTypeId);
  if (filters.lifecycle) params.set('lifecycle', filters.lifecycle);
  return `/map/assets?${params.toString()}`;
}

/**
 * Assets in the map's viewport (GET /map/assets after each pan or zoom settles): grid clusters from
 * the server when zoomed out, points from MAP_POINTS_MIN_ZOOM, clustered in the browser.
 */
export function AssetLayer({
  assetTypeId,
  lifecycle,
  onSelect,
  onStatus,
  excludeId,
}: {
  assetTypeId?: string;
  lifecycle?: AssetLifecycle;
  onSelect?: (point: MapPoint) => void;
  onStatus?: (status: AssetLayerStatus) => void;
  /** An asset not to draw (the one being edited in a picker). */
  excludeId?: string;
}) {
  const map = useMap();
  const { session } = useAuth();
  const [viewport, setViewport] = useState<{ bbox: string; zoom: number } | null>(null);

  useEffect(() => {
    if (!map) return;
    const read = () => {
      const bounds = map.getBounds()?.toJSON();
      const zoom = map.getZoom();
      if (bounds && zoom !== undefined) setViewport({ bbox: bboxParam(bounds), zoom: Math.round(zoom) });
    };
    read();
    const listener = map.addListener('idle', read);
    return () => listener.remove();
  }, [map]);

  const filters = { ...(assetTypeId ? { assetTypeId } : {}), ...(lifecycle ? { lifecycle } : {}) };
  const assets = useQuery({
    queryKey: ['map-assets', session?.tenantId, viewport, filters],
    queryFn: () => api.request<MapAssetsResponse>(mapAssetsPath(viewport!, filters)),
    enabled: viewport !== null,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  const data = assets.data;
  useEffect(() => {
    onStatus?.({
      loading: assets.isFetching,
      error: assets.error ? assets.error.message : null,
      count: data ? (data.kind === 'clusters' ? data.total : data.points.length) : null,
      truncated: data?.kind === 'points' && data.truncated,
    });
  }, [assets.isFetching, assets.error, data, onStatus]);

  if (!data) return null;
  if (data.kind === 'clusters') {
    return (
      <>
        {data.clusters.map((c) => (
          <ClusterMarker key={`${c.lat},${c.lng}`} cluster={c} />
        ))}
      </>
    );
  }
  return (
    <PointMarkers
      points={excludeId ? data.points.filter((p) => p.id !== excludeId) : data.points}
      onSelect={onSelect}
    />
  );
}

function ClusterMarker({ cluster }: { cluster: MapCluster }) {
  const map = useMap();
  const size = Math.min(56, 26 + Math.log10(cluster.count + 1) * 10);
  return (
    <AdvancedMarker
      position={{ lat: cluster.lat, lng: cluster.lng }}
      title={`${cluster.count} assets: zoom in`}
      onClick={() => {
        if (!map) return;
        map.panTo({ lat: cluster.lat, lng: cluster.lng });
        map.setZoom(clusterClickZoom(map.getZoom() ?? 7));
      }}
    >
      <div
        className="flex items-center justify-center rounded-full border-2 border-white bg-brand-700/85 text-xs font-semibold text-white shadow"
        style={{ width: size, height: size }}
      >
        {compactCount(cluster.count)}
      </div>
    </AdvancedMarker>
  );
}

/**
 * Up to MAP_POINTS_LIMIT points as advanced markers grouped by MarkerClusterer. Markers are kept by
 * id (and status) between viewports, so panning only adds and removes the difference.
 */
function PointMarkers({
  points,
  onSelect,
}: {
  points: readonly MapPoint[];
  onSelect?: (p: MapPoint) => void;
}) {
  const map = useMap();
  const markerLib = useMapsLibrary('marker');
  const clusterer = useRef<MarkerClusterer | null>(null);
  const markers = useRef(new Map<string, google.maps.marker.AdvancedMarkerElement>());
  const select = useRef(onSelect);
  select.current = onSelect;

  useEffect(() => {
    if (!map) return;
    clusterer.current = new MarkerClusterer({ map });
    const current = markers.current;
    return () => {
      clusterer.current?.clearMarkers();
      clusterer.current?.setMap(null);
      clusterer.current = null;
      current.clear();
    };
  }, [map]);

  useEffect(() => {
    if (!markerLib || !clusterer.current) return;
    // Keyed by id and lifecycle: an asset whose status changed is redrawn in its new colour.
    const keyOf = (p: MapPoint) => `${p.id}:${p.lifecycle}`;
    const wanted = new Map(points.map((p) => [keyOf(p), p]));
    const gone = [...markers.current.entries()].filter(([id]) => !wanted.has(id));
    for (const [id] of gone) markers.current.delete(id);
    const added: google.maps.marker.AdvancedMarkerElement[] = [];
    for (const point of points) {
      if (markers.current.has(keyOf(point))) continue;
      const dot = document.createElement('div');
      dot.className = 'h-3.5 w-3.5 rounded-full border-2 border-white shadow';
      dot.style.background = LIFECYCLE_COLORS[point.lifecycle];
      const marker = new markerLib.AdvancedMarkerElement({
        position: { lat: point.lat, lng: point.lng },
        content: dot,
        title: point.code,
        gmpClickable: true,
      });
      marker.addListener('click', () => select.current?.(point));
      markers.current.set(keyOf(point), marker);
      added.push(marker);
    }
    if (gone.length > 0)
      clusterer.current.removeMarkers(
        gone.map(([, m]) => m),
        true,
      );
    if (added.length > 0) clusterer.current.addMarkers(added, true);
    if (gone.length > 0 || added.length > 0) clusterer.current.render();
  }, [points, markerLib, map]);

  return null;
}
