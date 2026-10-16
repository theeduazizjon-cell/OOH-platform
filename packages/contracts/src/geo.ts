import { z } from 'zod';
import { ASSET_LIFECYCLES, type AssetKind, type AssetLifecycle } from './inventory';

/**
 * Map and geo (docs/architecture/07-database.md §5, 10-api.md "Map / Geo"). Distances, radius and
 * clustering are PostGIS (free, instant); reverse geocoding and driving routes go to the provider
 * (Google, server key) and degrade to "not available" when none is configured.
 */

/** From this zoom the map gets individual points (clustered in the browser); below it, grid counts. */
export const MAP_POINTS_MIN_ZOOM = 13;
/** At most this many points per viewport; more means "zoom in" (`truncated`). */
export const MAP_POINTS_LIMIT = 5000;
/** Grid clusters aim at roughly this many screen pixels per cell (256 px tiles). */
export const MAP_CLUSTER_CELL_PX = 64;

const EARTH_RADIUS_M = 6_371_008.8;
const rad = (deg: number) => (deg * Math.PI) / 180;

export interface LatLng {
  lat: number;
  lng: number;
}

/** Great-circle distance in metres (PostGIS geography agrees within ~0.5% for Romania-scale distances). */
export function haversineM(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial compass bearing from `a` towards `b`, 0–359 (0 = north, 90 = east). */
export function initialBearing(a: LatLng, b: LatLng): number {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x =
    Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  const deg = (Math.atan2(y, x) * 180) / Math.PI;
  return Math.round((deg + 360) % 360) % 360;
}

/** Grid cell size in degrees of longitude for clustering at `zoom` (Web Mercator, 256 px tiles). */
export function clusterCellDegrees(zoom: number): number {
  return (360 / 2 ** zoom) * (MAP_CLUSTER_CELL_PX / 256);
}

export interface Bbox {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** "west,south,east,north" in degrees; null when malformed. A box across the antimeridian is not supported. */
export function parseBbox(text: string): Bbox | null {
  const parts = text.split(',').map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [west, south, east, north] = parts as [number, number, number, number];
  const ok = west >= -180 && east <= 180 && south >= -90 && north <= 90 && west < east && south < north;
  return ok ? { west, south, east, north } : null;
}

/** Decodes a Google encoded polyline (precision 5) into points. */
export function decodePolyline(encoded: string): LatLng[] {
  const points: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const next = () => {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length) {
    lat += next();
    lng += next();
    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return points;
}

/**
 * Bearing of a path's start: from the first point to the first one at least `minM` away (a single
 * GPS-jittery segment would give a meaningless direction). Null for a path shorter than that.
 */
export function pathStartBearing(points: readonly LatLng[], minM = 20): number | null {
  const [first] = points;
  if (!first) return null;
  const ahead = points.find((p) => haversineM(first, p) >= minM);
  return ahead ? initialBearing(first, ahead) : null;
}

// ── map ──────────────────────────────────────────────────────────────────────

export const mapAssetsQuerySchema = z.object({
  bbox: z.string().transform((value, ctx) => {
    const box = parseBbox(value);
    if (!box) {
      ctx.addIssue({ code: 'custom', message: 'Use bbox=west,south,east,north in degrees' });
      return z.NEVER;
    }
    return box;
  }),
  zoom: z.coerce.number().int().min(0).max(22),
  assetTypeId: z.uuid().optional(),
  lifecycle: z.enum(ASSET_LIFECYCLES).optional(),
});
export type MapAssetsQuery = z.infer<typeof mapAssetsQuerySchema>;

export interface MapPoint {
  id: string;
  code: string;
  lat: number;
  lng: number;
  kind: AssetKind;
  assetTypeId: string;
  lifecycle: AssetLifecycle;
}

export interface MapCluster {
  /** The mean position of the cell's assets (not the cell centre), so markers sit on the data. */
  lat: number;
  lng: number;
  count: number;
}

/** GET /map/assets: points from MAP_POINTS_MIN_ZOOM, grid clusters below it. */
export type MapAssetsResponse =
  | { kind: 'points'; points: MapPoint[]; truncated: boolean }
  | { kind: 'clusters'; clusters: MapCluster[]; total: number };

// ── geo ──────────────────────────────────────────────────────────────────────

const latLngSchema = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });

export const reverseGeocodeRequestSchema = latLngSchema;

export interface ReverseGeocodeResult {
  formattedAddress: string;
  /** Street and number, when the point is on one. */
  address: string | null;
  city: string | null;
  county: string | null;
  placeId: string | null;
}

/** POST /geo/reverse: `configured: false` when no provider is set up (type the address instead). */
export interface ReverseGeocodeResponse {
  configured: boolean;
  result: ReverseGeocodeResult | null;
}

export const routeRequestSchema = z.object({ origin: latLngSchema, destination: latLngSchema });
export type RouteRequest = z.infer<typeof routeRequestSchema>;

export interface DrivingRoute {
  distanceM: number;
  durationS: number;
  /** Google encoded polyline (precision 5). */
  polyline: string;
  /** Bearing of the route's first leg, 0–359: compared with a face's facing for the direction arrow. */
  initialBearing: number;
}

/**
 * POST /geo/route: the straight line is always there; the driving route only with a provider
 * (`routeUnavailable` says why not).
 */
export interface RouteResponse {
  straight: { distanceM: number; bearing: number };
  route: DrivingRoute | null;
  routeUnavailable: string | null;
}
