import { Module } from '@nestjs/common';
import { GeoController } from './geo.controller';
import { GeoService } from './geo.service';

/** Map helpers (M5): reverse geocoding and driving routes through the configured GeoProvider. */
@Module({
  controllers: [GeoController],
  providers: [GeoService],
})
export class GeoApiModule {}
