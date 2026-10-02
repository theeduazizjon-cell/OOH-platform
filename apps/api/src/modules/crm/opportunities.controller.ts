import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import {
  type ActivityItem,
  activityListQuerySchema,
  createActivityRequestSchema,
  createOpportunityRequestSchema,
  loseOpportunityRequestSchema,
  moveStageRequestSchema,
  type OpportunityDetail,
  type OpportunityListItem,
  opportunityListQuerySchema,
  type Page,
  reopenOpportunityRequestSchema,
  updateActivityRequestSchema,
  updateOpportunityRequestSchema,
  winOpportunityRequestSchema,
} from '@ooh/contracts';
import type { FastifyRequest } from 'fastify';
import { CurrentPrincipal, type Principal, RequirePermission } from '../../core/auth/principal';
import { clientInfo } from '../../core/http/client-info';
import { type IfMatch, IfMatchHeader, VersionEtagInterceptor } from '../../core/http/concurrency';
import { parseWith } from '../../core/http/validation';
import { ActivitiesService } from './activities.service';
import { OpportunitiesService } from './opportunities.service';

/**
 * Sales opportunities (docs/architecture/10-api.md): CRUD plus actions move-stage, win, lose and
 * reopen. Changes and actions require If-Match.
 */
@Controller('opportunities')
@UseInterceptors(VersionEtagInterceptor)
export class OpportunitiesController {
  constructor(private readonly opportunities: OpportunitiesService) {}

  @Get()
  @RequirePermission('opportunity.read')
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: unknown,
  ): Promise<Page<OpportunityListItem>> {
    return this.opportunities.list(principal, parseWith(opportunityListQuerySchema, query));
  }

  @Get(':id')
  @RequirePermission('opportunity.read')
  get(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<OpportunityDetail> {
    return this.opportunities.get(principal, id);
  }

  @Post()
  @RequirePermission('opportunity.create')
  create(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<OpportunityDetail> {
    return this.opportunities.create(
      principal,
      parseWith(createOpportunityRequestSchema, body),
      clientInfo(request),
    );
  }

  @Patch(':id')
  @RequirePermission('opportunity.update')
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @IfMatchHeader() ifMatch: IfMatch,
    @Req() request: FastifyRequest,
  ): Promise<OpportunityDetail> {
    return this.opportunities.update(
      principal,
      id,
      parseWith(updateOpportunityRequestSchema, body),
      ifMatch,
      clientInfo(request),
    );
  }

  @Post(':id/actions/move-stage')
  @HttpCode(200)
  @RequirePermission('opportunity.update')
  moveStage(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @IfMatchHeader() ifMatch: IfMatch,
    @Req() request: FastifyRequest,
  ): Promise<OpportunityDetail> {
    const { stageId } = parseWith(moveStageRequestSchema, body);
    return this.opportunities.moveStage(principal, id, stageId, ifMatch, clientInfo(request));
  }

  @Post(':id/actions/win')
  @HttpCode(200)
  @RequirePermission('opportunity.close')
  win(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @IfMatchHeader() ifMatch: IfMatch,
    @Req() request: FastifyRequest,
  ): Promise<OpportunityDetail> {
    return this.opportunities.win(
      principal,
      id,
      parseWith(winOpportunityRequestSchema, body ?? {}),
      ifMatch,
      clientInfo(request),
    );
  }

  @Post(':id/actions/lose')
  @HttpCode(200)
  @RequirePermission('opportunity.close')
  lose(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @IfMatchHeader() ifMatch: IfMatch,
    @Req() request: FastifyRequest,
  ): Promise<OpportunityDetail> {
    const { lostReason } = parseWith(loseOpportunityRequestSchema, body);
    return this.opportunities.lose(principal, id, lostReason, ifMatch, clientInfo(request));
  }

  @Post(':id/actions/reopen')
  @HttpCode(200)
  @RequirePermission('opportunity.reopen')
  reopen(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @IfMatchHeader() ifMatch: IfMatch,
    @Req() request: FastifyRequest,
  ): Promise<OpportunityDetail> {
    return this.opportunities.reopen(
      principal,
      id,
      parseWith(reopenOpportunityRequestSchema, body),
      ifMatch,
      clientInfo(request),
    );
  }
}

/** Company timelines (docs/architecture/10-api.md: GET/POST /activities). */
@Controller('activities')
@UseInterceptors(VersionEtagInterceptor)
export class ActivitiesController {
  constructor(private readonly activities: ActivitiesService) {}

  @Get()
  @RequirePermission('activity.read')
  list(@CurrentPrincipal() principal: Principal, @Query() query: unknown): Promise<Page<ActivityItem>> {
    return this.activities.list(principal, parseWith(activityListQuerySchema, query));
  }

  @Post()
  @RequirePermission('activity.create')
  create(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<ActivityItem> {
    return this.activities.create(
      principal,
      parseWith(createActivityRequestSchema, body),
      clientInfo(request),
    );
  }

  @Patch(':id')
  @RequirePermission('activity.update')
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @IfMatchHeader() ifMatch: IfMatch,
    @Req() request: FastifyRequest,
  ): Promise<ActivityItem> {
    return this.activities.update(
      principal,
      id,
      parseWith(updateActivityRequestSchema, body),
      ifMatch,
      clientInfo(request),
    );
  }
}
