import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import {
  type ActivityTypeItem,
  type ClassificationItem,
  createActivityTypeRequestSchema,
  createClassificationRequestSchema,
  createStageRequestSchema,
  type Page,
  type PipelineItem,
  type PipelineStageItem,
  stageOrderRequestSchema,
  updateActivityTypeRequestSchema,
  updateClassificationRequestSchema,
  updateStageRequestSchema,
} from '@ooh/contracts';
import type { FastifyRequest } from 'fastify';
import { CurrentPrincipal, type Principal, RequirePermission } from '../../core/auth/principal';
import { clientInfo } from '../../core/http/client-info';
import { type IfMatch, IfMatchHeader, VersionEtagInterceptor } from '../../core/http/concurrency';
import { parseWith } from '../../core/http/validation';
import { ClassificationsService } from './classifications.service';
import { SalesConfigService } from './sales-config.service';

/** Nomenclatures (docs/architecture/10-api.md: GET/POST/PATCH /config/{…}). */
@Controller('config')
@UseInterceptors(VersionEtagInterceptor)
export class ConfigController {
  constructor(
    private readonly classifications: ClassificationsService,
    private readonly sales: SalesConfigService,
  ) {}

  /** Pipelines with their stages (ordered), for the board and opportunity forms. */
  @Get('pipelines')
  @RequirePermission('config.read')
  listPipelines(@CurrentPrincipal() principal: Principal): Promise<PipelineItem[]> {
    return this.sales.pipelines(principal);
  }

  @Post('pipelines/:id/stages')
  @RequirePermission('config.manage')
  createStage(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) pipelineId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<PipelineStageItem> {
    return this.sales.createStage(
      principal,
      pipelineId,
      parseWith(createStageRequestSchema, body),
      clientInfo(request),
    );
  }

  /** Every OPEN stage in the new order; If-Match is the pipeline's version. */
  @Put('pipelines/:id/stage-order')
  @RequirePermission('config.manage')
  reorderStages(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) pipelineId: string,
    @Body() body: unknown,
    @IfMatchHeader() ifMatch: IfMatch,
    @Req() request: FastifyRequest,
  ): Promise<PipelineItem> {
    return this.sales.reorderStages(
      principal,
      pipelineId,
      parseWith(stageOrderRequestSchema, body),
      ifMatch,
      clientInfo(request),
    );
  }

  @Patch('stages/:id')
  @RequirePermission('config.manage')
  updateStage(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @IfMatchHeader() ifMatch: IfMatch,
    @Req() request: FastifyRequest,
  ): Promise<PipelineStageItem> {
    return this.sales.updateStage(
      principal,
      id,
      parseWith(updateStageRequestSchema, body),
      ifMatch,
      clientInfo(request),
    );
  }

  @Get('activity-types')
  @RequirePermission('config.read')
  listActivityTypes(@CurrentPrincipal() principal: Principal): Promise<ActivityTypeItem[]> {
    return this.sales.activityTypes(principal);
  }

  @Post('activity-types')
  @RequirePermission('config.manage')
  createActivityType(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<ActivityTypeItem> {
    return this.sales.createActivityType(
      principal,
      parseWith(createActivityTypeRequestSchema, body),
      clientInfo(request),
    );
  }

  @Patch('activity-types/:id')
  @RequirePermission('config.manage')
  updateActivityType(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @IfMatchHeader() ifMatch: IfMatch,
    @Req() request: FastifyRequest,
  ): Promise<ActivityTypeItem> {
    return this.sales.updateActivityType(
      principal,
      id,
      parseWith(updateActivityTypeRequestSchema, body),
      ifMatch,
      clientInfo(request),
    );
  }

  @Get('classifications')
  @RequirePermission('config.read')
  listClassifications(@CurrentPrincipal() principal: Principal): Promise<Page<ClassificationItem>> {
    return this.classifications.list(principal);
  }

  @Post('classifications')
  @RequirePermission('config.manage')
  createClassification(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<ClassificationItem> {
    return this.classifications.create(
      principal,
      parseWith(createClassificationRequestSchema, body),
      clientInfo(request),
    );
  }

  @Patch('classifications/:id')
  @RequirePermission('config.manage')
  updateClassification(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @IfMatchHeader() ifMatch: IfMatch,
    @Req() request: FastifyRequest,
  ): Promise<ClassificationItem> {
    return this.classifications.update(
      principal,
      id,
      parseWith(updateClassificationRequestSchema, body),
      ifMatch,
      clientInfo(request),
    );
  }
}
