import { type GeocodeCandidate, type GeocodeResult, type GeoProvider } from './geo-provider';

interface GoogleResponse {
  status: string;
  error_message?: string;
  results: {
    place_id: string;
    formatted_address: string;
    partial_match?: boolean;
    geometry: { location: { lat: number; lng: number }; location_type: string };
  }[];
}

/** Statuses that are worth retrying (the outbox backs off); anything else is a definite answer. */
const TRANSIENT = new Set(['OVER_QUERY_LIMIT', 'UNKNOWN_ERROR']);

/**
 * Google Geocoding API (server key, IP-restricted per 08 §7). Romania only. A single precise match is
 * RESOLVED; several, partial or only city-level matches are AMBIGUOUS; none is FAILED.
 */
export class GoogleGeoProvider implements GeoProvider {
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
}
