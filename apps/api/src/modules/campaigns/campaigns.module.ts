import { Module } from '@nestjs/common';
import { CampaignsController, LocationsController } from './campaigns.controller';
import { CampaignsService } from './campaigns.service';
import { LocationEvents } from './location-events';
import { TasksModule } from '../tasks/tasks.module';

/** Campaigns and locations (M3). Exported so brief convert creates them in its transaction. */
@Module({
  imports: [TasksModule],
  controllers: [CampaignsController, LocationsController],
  providers: [CampaignsService, LocationEvents],
  exports: [CampaignsService],
})
export class CampaignsModule {}
