import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  decodePolyline,
  haversineM,
  initialBearing,
  type LatLng,
  pathStartBearing,
  type ReverseGeocodeResponse,
  type ReverseGeocodeResult,
  type RouteResponse,
} from '@ooh/contracts';
import { GEO_PROVIDER, type GeoProvider } from '../../core/geo/geo-provider';
import { AppError } from '../../core/http/app-error';

/** Map clicks repeat (double clicks, moving back and forth); ~1 m grid, short-lived (OPD-19 caching). */
const REVERSE_CACHE_MS = 10 * 60_000;
const REVERSE_CACHE_MAX = 1000;

/**
 * Provider-backed geo answers for the map (07-database.md §5): reverse geocoding on click and the
 * driving route between two points. Straight-line distance and bearing never need the provider.
 */
@Injectable()
export class GeoService {
  private readonly logger = new Logger(GeoService.name);
  private readonly reverseCache = new Map<string, { at: number; value: ReverseGeocodeResult | null }>();

  constructor(@Inject(GEO_PROVIDER) private readonly provider: GeoProvider) {}

  async reverse(point: LatLng): Promise<ReverseGeocodeResponse> {
    if (!this.provider.configured) return { configured: false, result: null };
    const key = `${point.lat.toFixed(5)},${point.lng.toFixed(5)}`;
    const cached = this.reverseCache.get(key);
    if (cached && Date.now() - cached.at < REVERSE_CACHE_MS)
      return { configured: true, result: cached.value };

    let value: ReverseGeocodeResult | null;
    try {
      value = await this.provider.reverseGeocode(point);
    } catch (error) {
      this.logger.warn(`Reverse geocoding failed: ${(error as Error).message}`);
      throw new AppError(
        'SERVICE_UNAVAILABLE',
        'Looking up the address is not possible right now. Type it in, or try again shortly.',
      );
    }
    if (this.reverseCache.size >= REVERSE_CACHE_MAX) this.reverseCache.clear();
    this.reverseCache.set(key, { at: Date.now(), value });
    return { configured: true, result: value };
  }

  async route(origin: LatLng, destination: LatLng): Promise<RouteResponse> {
    const straight = {
      distanceM: Math.round(haversineM(origin, destination)),
      bearing: initialBearing(origin, destination),
    };
    if (!this.provider.configured) {
      return { straight, route: null, routeUnavailable: 'Driving routes are not configured.' };
    }
    try {
      const found = await this.provider.route(origin, destination);
      if (!found)
        return { straight, route: null, routeUnavailable: 'No driving route between these points.' };
      return {
        straight,
        route: {
          ...found,
          initialBearing: pathStartBearing(decodePolyline(found.polyline)) ?? straight.bearing,
        },
        routeUnavailable: null,
      };
    } catch (error) {
      this.logger.warn(`Route failed: ${(error as Error).message}`);
      return {
        straight,
        route: null,
        routeUnavailable: 'The driving route is not available right now; the straight distance is shown.',
      };
    }
  }
}
