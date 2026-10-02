import { Module } from '@nestjs/common';
import { CampaignsController, LocationsController } from './campaigns.controller';
import { CampaignsService } from './campaigns.service';

/** Campaigns and locations (M3). Exported so brief convert creates them in its transaction. */
@Module({
  controllers: [CampaignsController, LocationsController],
  providers: [CampaignsService],
  exports: [CampaignsService],
})
export class CampaignsModule {}
