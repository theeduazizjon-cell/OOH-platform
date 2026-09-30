import { Module } from '@nestjs/common';
import { ContactsController } from './contacts.controller';
import { ContactsService } from './contacts.service';
import { OrganisationsController } from './organisations.controller';
import { OrganisationsService } from './organisations.service';
import { RelationshipsService } from './relationships.service';

/** CRM (M2): organisations and contacts; relationships, opportunities and activities follow. */
@Module({
  controllers: [OrganisationsController, ContactsController],
  providers: [OrganisationsService, ContactsService, RelationshipsService],
})
export class CrmModule {}
