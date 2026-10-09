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

export interface GeoProvider {
  /** Throws only for transient errors (network, quota): the outbox then retries with backoff. */
  geocode(query: string): Promise<GeocodeResult>;
}

export const GEO_PROVIDER = Symbol('GEO_PROVIDER');

/** No provider configured (e.g. local development): every address needs a person to place the pin. */
export class UnconfiguredGeoProvider implements GeoProvider {
  geocode(): Promise<GeocodeResult> {
    return Promise.resolve({ kind: 'failed', reason: 'Geocoding is not configured; place the pin by hand.' });
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
