import { type LatLng } from '@ooh/contracts';
import { AdvancedMarker, Map, Pin, useMap } from '@vis.gl/react-google-maps';
import { useEffect } from 'react';
import { DEFAULT_VIEW, mapsConfig, POINT_ZOOM } from '@/lib/map';
import { AssetLayer } from './asset-layer';
import { MapsProvider, MapUnavailable, useMapsEnabled } from './maps';

/** Six decimals (~10 cm): what the coordinates field shows after a pick. */
export function formatPoint(point: LatLng): string {
  return `${point.lat.toFixed(6)}, ${point.lng.toFixed(6)}`;
}

/**
 * Click the map or drag the pin to choose a point. Existing assets are drawn around it (when
 * `showAssets`), so a duplicate is visible before the server's 10 m check.
 */
export function MapPicker({
  value,
  onChange,
  showAssets = false,
  excludeAssetId,
  label,
  className = 'h-72',
}: {
  value: LatLng | null;
  onChange: (point: LatLng) => void;
  showAssets?: boolean;
  excludeAssetId?: string;
  label: string;
  className?: string;
}) {
  const enabled = useMapsEnabled();
  // Compact without a key: a map-sized empty box would only push the form down.
  if (!enabled)
    return <MapUnavailable className="py-3">Type or paste the coordinates instead.</MapUnavailable>;
  return (
    <MapsProvider>
      <div className={className} role="group" aria-label={label}>
        <Map
          mapId={mapsConfig().mapId}
          defaultCenter={value ?? DEFAULT_VIEW.center}
          defaultZoom={value ? POINT_ZOOM : DEFAULT_VIEW.zoom}
          gestureHandling="greedy"
          clickableIcons={false}
          streetViewControl
          mapTypeControl
          className="h-full w-full overflow-hidden rounded-md"
          onClick={(e) => {
            if (e.detail.latLng) onChange(e.detail.latLng);
          }}
        >
          {showAssets && <AssetLayer excludeId={excludeAssetId} />}
          {value && (
            <AdvancedMarker
              position={value}
              draggable
              zIndex={1000}
              title="Drag to adjust"
              onDragEnd={(e) => {
                const point = e.latLng?.toJSON();
                if (point) onChange(point);
              }}
            >
              <Pin background="#1d4ed8" borderColor="#ffffff" glyphColor="#ffffff" />
            </AdvancedMarker>
          )}
          <FollowValue value={value} />
        </Map>
      </div>
    </MapsProvider>
  );
}

/** Pans to the value when it changes from outside (typed or pasted coordinates). */
function FollowValue({ value }: { value: LatLng | null }) {
  const map = useMap();
  const lat = value?.lat;
  const lng = value?.lng;
  useEffect(() => {
    if (!map || lat === undefined || lng === undefined) return;
    const inView = map.getBounds()?.contains({ lat, lng });
    if (!inView) {
      map.panTo({ lat, lng });
      if ((map.getZoom() ?? 0) < 15) map.setZoom(POINT_ZOOM);
    }
  }, [map, lat, lng]);
  return null;
}
