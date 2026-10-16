import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import {
  type ReverseGeocodeResponse,
  reverseGeocodeRequestSchema,
  routeRequestSchema,
  type RouteResponse,
} from '@ooh/contracts';
import { RequirePermission } from '../../core/auth/principal';
import { parseWith } from '../../core/http/validation';
import { GeoService } from './geo.service';

/**
 * Geo helpers for the map (10-api.md "Map / Geo"). POST because they are lookups with a body, not
 * resources; they change nothing. Anyone who can see the inventory can use them.
 */
@Controller('geo')
export class GeoController {
  constructor(private readonly geo: GeoService) {}

  @Post('reverse')
  @HttpCode(200)
  @RequirePermission('asset.read')
  reverse(@Body() body: unknown): Promise<ReverseGeocodeResponse> {
    return this.geo.reverse(parseWith(reverseGeocodeRequestSchema, body));
  }

  @Post('route')
  @HttpCode(200)
  @RequirePermission('asset.read')
  route(@Body() body: unknown): Promise<RouteResponse> {
    const { origin, destination } = parseWith(routeRequestSchema, body);
    return this.geo.route(origin, destination);
  }
}
