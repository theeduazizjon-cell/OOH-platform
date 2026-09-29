import { Module } from '@nestjs/common';
import { ClassificationsService } from './classifications.service';
import { ConfigController } from './config.controller';

/** Tenant nomenclatures. Classifications now; activity types, pipelines and task categories follow. */
@Module({ controllers: [ConfigController], providers: [ClassificationsService] })
export class TenantConfigModule {}
