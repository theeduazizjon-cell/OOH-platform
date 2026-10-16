import type { LatLng, ReverseGeocodeResult } from '@ooh/contracts';

/**
 * Geocoding behind an interface (ADR-0007: Google from the backend, swappable). Results are
 * suggestions: a person confirms or moves the pin before research starts (04-user-flows.md A6–A7).
 */
export interface GeocodeCandidate {
  readonly lat: number;
  readonly lng: number;
  readonly placeId: string | null;
  readonly formattedAddress: string;
  /** ROOFTOP/street-level vs. only the city or region (too coarse to place a store). */
  readonly precise: boolean;
}

export type GeocodeResult =
  | { readonly kind: 'resolved'; readonly candidate: GeocodeCandidate }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly GeocodeCandidate[] }
  | { readonly kind: 'failed'; readonly reason: string };

export interface ProviderRoute {
  readonly distanceM: number;
  readonly durationS: number;
  /** Google encoded polyline (precision 5). */
  readonly polyline: string;
}

export interface GeoProvider {
  /** False when no provider is set up: callers explain that a person has to do it by hand. */
  readonly configured: boolean;
  /** Throws only for transient errors (network, quota): the outbox then retries with backoff. */
  geocode(query: string): Promise<GeocodeResult>;
  /** The address at a point (map click); null when there is none or no provider. Throws when transient. */
  reverseGeocode(point: LatLng): Promise<ReverseGeocodeResult | null>;
  /** Driving route; null when there is none (unreachable) or no provider. Throws when transient. */
  route(origin: LatLng, destination: LatLng): Promise<ProviderRoute | null>;
}

export const GEO_PROVIDER = Symbol('GEO_PROVIDER');

/** No provider configured (e.g. local development): every address needs a person to place the pin. */
export class UnconfiguredGeoProvider implements GeoProvider {
  readonly configured = false;

  geocode(): Promise<GeocodeResult> {
    return Promise.resolve({ kind: 'failed', reason: 'Geocoding is not configured; place the pin by hand.' });
  }

  reverseGeocode(): Promise<ReverseGeocodeResult | null> {
    return Promise.resolve(null);
  }

  route(): Promise<ProviderRoute | null> {
    return Promise.resolve(null);
  }
}

/** The single text query for an address (street, city, county, country). */
export function geocodeQuery(parts: {
  address: string | null;
  city: string | null;
  county: string | null;
}): string {
  return [parts.address, parts.city, parts.county, 'Romania'].filter((p) => p && p.trim()).join(', ');
}
