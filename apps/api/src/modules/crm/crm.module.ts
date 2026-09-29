import { Module } from '@nestjs/common';
import { OrganisationsController } from './organisations.controller';
import { OrganisationsService } from './organisations.service';

/** CRM (M2): organisations now; contacts, relationships, opportunities and activities follow. */
@Module({ controllers: [OrganisationsController], providers: [OrganisationsService] })
export class CrmModule {}
