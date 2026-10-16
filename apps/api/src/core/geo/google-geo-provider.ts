import type { LatLng, ReverseGeocodeResult } from '@ooh/contracts';
import {
  type GeocodeCandidate,
  type GeocodeResult,
  type GeoProvider,
  type ProviderRoute,
} from './geo-provider';

interface GoogleResponse {
  status: string;
  error_message?: string;
  results: {
    place_id: string;
    formatted_address: string;
    partial_match?: boolean;
    types?: string[];
    address_components?: { long_name: string; types: string[] }[];
    geometry: { location: { lat: number; lng: number }; location_type: string };
  }[];
}

interface RoutesResponse {
  routes?: { distanceMeters?: number; duration?: string; polyline?: { encodedPolyline?: string } }[];
}

/** Romanian counties come back as "Județul Prahova" (or "Judetul …"); Bucharest as "București". */
export function countyName(name: string): string {
  return name.replace(/^jude[țţt]ul\s+/i, '');
}

/** Statuses that are worth retrying (the outbox backs off); anything else is a definite answer. */
const TRANSIENT = new Set(['OVER_QUERY_LIMIT', 'UNKNOWN_ERROR']);

/**
 * Google Geocoding API (server key, IP-restricted per 08 §7). Romania only. A single precise match is
 * RESOLVED; several, partial or only city-level matches are AMBIGUOUS; none is FAILED.
 */
export class GoogleGeoProvider implements GeoProvider {
  readonly configured = true;

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async geocode(query: string): Promise<GeocodeResult> {
    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.searchParams.set('address', query);
    url.searchParams.set('components', 'country:RO');
    url.searchParams.set('region', 'ro');
    url.searchParams.set('key', this.apiKey);
    const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Geocoding HTTP ${response.status}`);
    const body = (await response.json()) as GoogleResponse;
    if (TRANSIENT.has(body.status)) throw new Error(`Geocoding ${body.status}`);
    if (body.status === 'ZERO_RESULTS') return { kind: 'failed', reason: 'The address was not found.' };
    if (body.status !== 'OK') return { kind: 'failed', reason: `Geocoding refused: ${body.status}` };
    const candidates: GeocodeCandidate[] = body.results.slice(0, 5).map((r) => ({
      lat: r.geometry.location.lat,
      lng: r.geometry.location.lng,
      placeId: r.place_id,
      formattedAddress: r.formatted_address,
      precise:
        !r.partial_match &&
        (r.geometry.location_type === 'ROOFTOP' || r.geometry.location_type === 'RANGE_INTERPOLATED'),
    }));
    const [only] = candidates;
    return candidates.length === 1 && only?.precise
      ? { kind: 'resolved', candidate: only }
      : { kind: 'ambiguous', candidates };
  }

  async reverseGeocode(point: LatLng): Promise<ReverseGeocodeResult | null> {
    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.searchParams.set('latlng', `${point.lat},${point.lng}`);
    url.searchParams.set('language', 'ro');
    url.searchParams.set('key', this.apiKey);
    const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Reverse geocoding HTTP ${response.status}`);
    const body = (await response.json()) as GoogleResponse;
    if (body.status === 'ZERO_RESULTS') return null;
    // REQUEST_DENIED etc. is a set-up problem (key, API not enabled): an error, not "no address".
    if (body.status !== 'OK') throw new Error(`Reverse geocoding ${body.status}`);
    // Results come most specific first; plus codes alone don't describe a place.
    const best = body.results.find((r) => !r.types?.includes('plus_code'));
    if (!best) return null;
    const part = (type: string) => best.address_components?.find((c) => c.types.includes(type))?.long_name;
    const street = part('route');
    const number = part('street_number');
    const county = part('administrative_area_level_1');
    return {
      formattedAddress: best.formatted_address,
      address: street ? [street, number].filter(Boolean).join(' ') : null,
      city: part('locality') ?? part('administrative_area_level_2') ?? null,
      county: county ? countyName(county) : null,
      placeId: best.place_id,
    };
  }

  /** Routes API computeRoutes (driving, no live traffic), asking only for the fields used (cost). */
  async route(origin: LatLng, destination: LatLng): Promise<ProviderRoute | null> {
    const waypoint = (p: LatLng) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
    const response = await this.fetchImpl('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: {
        'content-type': 'application/json',
        'X-Goog-Api-Key': this.apiKey,
        'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline',
      },
      body: JSON.stringify({
        origin: waypoint(origin),
        destination: waypoint(destination),
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_UNAWARE',
        regionCode: 'RO',
      }),
    });
    // No route between the points is a 200 with no routes; any error status is a failure to report.
    if (!response.ok) throw new Error(`Routes HTTP ${response.status}`);
    const body = (await response.json()) as RoutesResponse;
    const best = body.routes?.[0];
    const polyline = best?.polyline?.encodedPolyline;
    if (!best || best.distanceMeters === undefined || !polyline) return null;
    return {
      distanceM: best.distanceMeters,
      durationS: Number.parseInt(best.duration ?? '0', 10),
      polyline,
    };
  }
}
