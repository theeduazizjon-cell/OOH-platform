import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import {
  campaignHoldRequestSchema,
  type CampaignDetail,
  type CampaignListItem,
  campaignListQuerySchema,
  cancelRequestSchema,
  createCampaignRequestSchema,
  createLocationRequestSchema,
  locationHoldRequestSchema,
  type LocationItem,
  type Page,
  storePointRequestSchema,
  updateCampaignRequestSchema,
  updateLocationRequestSchema,
} from '@ooh/contracts';
import type { FastifyRequest } from 'fastify';
import { CurrentPrincipal, type Principal, RequirePermission } from '../../core/auth/principal';
import { clientInfo } from '../../core/http/client-info';
import { type IfMatch, IfMatchHeader, VersionEtagInterceptor } from '../../core/http/concurrency';
import { parseWith } from '../../core/http/validation';
import { CampaignsService } from './campaigns.service';

/** Campaigns (docs/architecture/10-api.md): CRUD and actions hold / resume / cancel (If-Match). */
@Controller('campaigns')
@UseInterceptors(VersionEtagInterceptor)
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Get()
  @RequirePermission('campaign.read')
  list(@CurrentPrincipal() principal: Principal, @Query() query: unknown): Promise<Page<CampaignListItem>> {
    return this.campaigns.list(principal, parseWith(campaignListQuerySchema, query));
  }

  @Get(':id')
  @RequirePermission('campaign.read')
  get(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CampaignDetail> {
    return this.campaigns.get(principal, id);
  }

  @Post()
  @RequirePermission('campaign.create')
  create(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<CampaignDetail> {
    return this.campaigns.create(
      principal,
      parseWith(createCampaignRequestSchema, body),
      clientInfo(request),
    );
  }

  @Patch(':id')
  @RequirePermission('campaign.update')
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @IfMatchHeader() ifMatch: IfMatch,
    @Req() request: FastifyRequest,
  ): Promise<CampaignDetail> {
    return this.campaigns.update(
      principal,
      id,
      parseWith(updateCampaignRequestSchema, body),
      ifMatch,
      clientInfo(request),
    );
  }

  @Post(':id/actions/hold')
  @HttpCode(200)
  @RequirePermission('campaign.update')
  hold(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @IfMatchHeader() ifMatch: IfMatch,
    @Req() request: FastifyRequest,
  ): Promise<CampaignDetail> {
    const input = parseWith(campaignHoldRequestSchema, body ?? {});
    return this.campaigns.transition(principal, id, 'hold', input, ifMatch, clientInfo(request));
  }

  @Post(':id/actions/resume')
  @HttpCode(200)
  @RequirePermission('campaign.update')
  resume(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @IfMatchHeader() ifMatch: IfMatch,
    @Req() request: FastifyRequest,
  ): Promise<CampaignDetail> {
    return this.campaigns.transition(principal, id, 'resume', {}, ifMatch, clientInfo(request));
  }

  @Post(':id/actions/cancel')
  @HttpCode(200)
  @RequirePermission('campaign.cancel')
  cancel(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @IfMatchHeader() ifMatch: IfMatch,
    @Req() request: FastifyRequest,
  ): Promise<CampaignDetail> {
    const input = parseWith(cancelRequestSchema, body);
    return this.campaigns.transition(principal, id, 'cancel', input, ifMatch, clientInfo(request));
  }

  @Get(':id/locations')
  @RequirePermission('campaign_location.read')
  async locations(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<LocationItem[]> {
    return (await this.campaigns.get(principal, id)).locationItems;
  }

  @Post(':id/locations')
  @RequirePermission('campaign_location.manage')
  addLocation(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<LocationItem> {
    return this.campaigns.addLocation(
      principal,
      id,
      parseWith(createLocationRequestSchema, body),
      clientInfo(request),
    );
  }
}

/** Campaign locations (docs/architecture/10-api.md): edit and actions hold / resume / cancel. */
@Controller('locations')
@UseInterceptors(VersionEtagInterceptor)
export class LocationsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Get(':id')
  @RequirePermission('campaign_location.read')
  get(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<LocationItem> {
    return this.campaigns.getLocation(principal, id);
  }

  @Patch(':id')
  @RequirePermission('campaign_location.manage')
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @IfMatchHeader() ifMatch: IfMatch,
    @Req() request: FastifyRequest,
  ): Promise<LocationItem> {
    return this.campaigns.updateLocation(
      principal,
      id,
      parseWith(updateLocationRequestSchema, body),
      ifMatch,
      clientInfo(request),
    );
  }

  /** A person places or accepts the store pin (04-user-flows.md A7). */
  @Put(':id/store-point')
  @RequirePermission('campaign_location.manage')
  storePoint(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @IfMatchHeader() ifMatch: IfMatch,
    @Req() request: FastifyRequest,
  ): Promise<LocationItem> {
    return this.campaigns.setStorePoint(
      principal,
      id,
      parseWith(storePointRequestSchema, body),
      ifMatch,
      clientInfo(request),
    );
  }

  /** DRAFT → RESEARCH; needs a confirmed store pin. */
  @Post(':id/actions/start-research')
  @HttpCode(200)
  @RequirePermission('campaign_location.manage')
  startResearch(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @IfMatchHeader() ifMatch: IfMatch,
    @Req() request: FastifyRequest,
  ): Promise<LocationItem> {
    return this.campaigns.transitionLocation(
      principal,
      id,
      'start-research',
      {},
      ifMatch,
      clientInfo(request),
    );
  }

  @Post(':id/actions/hold')
  @HttpCode(200)
  @RequirePermission('campaign_location.manage')
  hold(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @IfMatchHeader() ifMatch: IfMatch,
    @Req() request: FastifyRequest,
  ): Promise<LocationItem> {
    const input = parseWith(locationHoldRequestSchema, body);
    return this.campaigns.transitionLocation(principal, id, 'hold', input, ifMatch, clientInfo(request));
  }

  @Post(':id/actions/resume')
  @HttpCode(200)
  @RequirePermission('campaign_location.manage')
  resume(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @IfMatchHeader() ifMatch: IfMatch,
    @Req() request: FastifyRequest,
  ): Promise<LocationItem> {
    return this.campaigns.transitionLocation(principal, id, 'resume', {}, ifMatch, clientInfo(request));
  }

  @Post(':id/actions/cancel')
  @HttpCode(200)
  @RequirePermission('campaign_location.manage')
  cancel(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @IfMatchHeader() ifMatch: IfMatch,
    @Req() request: FastifyRequest,
  ): Promise<LocationItem> {
    const input = parseWith(cancelRequestSchema, body);
    return this.campaigns.transitionLocation(principal, id, 'cancel', input, ifMatch, clientInfo(request));
  }
}
