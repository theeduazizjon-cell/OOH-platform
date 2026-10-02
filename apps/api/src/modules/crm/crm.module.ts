import { Module } from '@nestjs/common';
import { ActivitiesService } from './activities.service';
import { ContactsController } from './contacts.controller';
import { ContactsService } from './contacts.service';
import { ActivitiesController, OpportunitiesController } from './opportunities.controller';
import { OpportunitiesService } from './opportunities.service';
import { OrganisationsController } from './organisations.controller';
import { OrganisationsService } from './organisations.service';
import { TasksModule } from '../tasks/tasks.module';
import { RelationshipsService } from './relationships.service';

/** CRM (M2): organisations, contacts, relationships, opportunities and activities. */
@Module({
  imports: [TasksModule],
  controllers: [OrganisationsController, ContactsController, OpportunitiesController, ActivitiesController],
  providers: [
    OrganisationsService,
    ContactsService,
    RelationshipsService,
    OpportunitiesService,
    ActivitiesService,
  ],
})
export class CrmModule {}
