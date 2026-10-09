import { Global, Module } from '@nestjs/common';
import { ENV } from '../../config/config.module';
import { type Env } from '../../config/env';
import { GEO_PROVIDER, UnconfiguredGeoProvider } from './geo-provider';
import { GoogleGeoProvider } from './google-geo-provider';

/** The geocoding provider: Google when GOOGLE_MAPS_SERVER_KEY is set, otherwise "not configured". */
@Global()
@Module({
  providers: [
    {
      provide: GEO_PROVIDER,
      inject: [ENV],
      useFactory: (env: Env) =>
        env.GOOGLE_MAPS_SERVER_KEY
          ? new GoogleGeoProvider(env.GOOGLE_MAPS_SERVER_KEY)
          : new UnconfiguredGeoProvider(),
    },
  ],
  exports: [GEO_PROVIDER],
})
export class GeoModule {}
