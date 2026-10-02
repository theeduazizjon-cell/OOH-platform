import { Module } from '@nestjs/common';
import { ClassificationsService } from './classifications.service';
import { ConfigController } from './config.controller';
import { SalesConfigService } from './sales-config.service';

/** Tenant nomenclatures: classifications, pipelines and activity types (task categories follow). */
@Module({ controllers: [ConfigController], providers: [ClassificationsService, SalesConfigService] })
export class TenantConfigModule {}
