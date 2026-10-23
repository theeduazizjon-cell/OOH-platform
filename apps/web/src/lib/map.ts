import { type AssetLifecycle, MAP_POINTS_MIN_ZOOM } from '@ooh/contracts';

/** Romania, whole country in view (the map's starting viewport). */
export const DEFAULT_VIEW = { center: { lat: 45.94, lng: 24.97 }, zoom: 7 } as const;
/** Zoom used when jumping to one point (coordinates, an asset, a store pin). */
export const POINT_ZOOM = 17;

export interface MapsConfig {
  apiKey: string | null;
  mapId: string;
}

/** Browser key and map ID from the root .env (VITE_*); no key → no Google map, the UI says so. */
export function mapsConfig(env: ImportMetaEnv = import.meta.env): MapsConfig {
  const apiKey = env.VITE_GOOGLE_MAPS_BROWSER_KEY?.trim();
  return { apiKey: apiKey ? apiKey : null, mapId: env.VITE_GOOGLE_MAPS_MAP_ID?.trim() || 'DEMO_MAP_ID' };
}

export interface Bounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

/**
 * The `bbox` query parameter (`west,south,east,north`) for a viewport, rounded to ~10 m so small pans
 * reuse the cached response. A viewport across the antimeridian is widened to the whole world.
 */
export function bboxParam(b: Bounds): string {
  const round = (v: number) => Math.round(v * 10_000) / 10_000;
  const [west, east] = b.west <= b.east ? [b.west, b.east] : [-180, 180];
  return [round(west), round(Math.max(b.south, -85)), round(east), round(Math.min(b.north, 85))].join(',');
}

/** Zoom after clicking a server cluster (only shown below MAP_POINTS_MIN_ZOOM): closer, at most to where points start. */
export function clusterClickZoom(zoom: number): number {
  return Math.min(zoom + 2, MAP_POINTS_MIN_ZOOM);
}

/** The viewport in the URL (`?lat=&lng=&z=`), when all three are present and sensible. */
export function parseViewport(search: { lat?: unknown; lng?: unknown; z?: unknown }) {
  const lat = Number(search.lat);
  const lng = Number(search.lng);
  const zoom = Number(search.z);
  const ok =
    search.lat !== undefined &&
    search.lng !== undefined &&
    search.z !== undefined &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180 &&
    Number.isInteger(zoom) &&
    zoom >= 3 &&
    zoom <= 21;
  return ok ? { center: { lat, lng }, zoom } : null;
}

/** Marker colours by lifecycle (also used for the legend). */
export const LIFECYCLE_COLORS: Record<AssetLifecycle, string> = {
  PROSPECTIVE: '#64748b',
  ACTIVE: '#059669',
  SUSPENDED: '#d97706',
  DECOMMISSIONED: '#b91c1c',
};

/** Short counts for cluster bubbles: 950, 1.2k, 12k. */
export function compactCount(n: number): string {
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}
