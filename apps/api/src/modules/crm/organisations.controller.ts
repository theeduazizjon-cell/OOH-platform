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
  createOrganisationRequestSchema,
  type OrganisationDetail,
  type OrganisationListItem,
  organisationListQuerySchema,
  type Page,
  updateOrganisationRequestSchema,
} from '@ooh/contracts';
import type { FastifyRequest } from 'fastify';
import { CurrentPrincipal, type Principal, RequirePermission } from '../../core/auth/principal';
import { clientInfo } from '../../core/http/client-info';
import { type IfMatch, IfMatchHeader, VersionEtagInterceptor } from '../../core/http/concurrency';
import { parseWith } from '../../core/http/validation';
import { OrganisationsService } from './organisations.service';

/**
 * CRM companies (docs/architecture/10-api.md). POST runs duplicate detection: 409
 * DUPLICATE_SUSPECTED with `meta.matches` unless `force: true` with a `forceReason` (not possible for
 * an identical VAT number). Changes require If-Match.
 */
@Controller('organisations')
@UseInterceptors(VersionEtagInterceptor)
export class OrganisationsController {
  constructor(private readonly organisations: OrganisationsService) {}

  @Get()
  @RequirePermission('organisation.read')
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: unknown,
  ): Promise<Page<OrganisationListItem>> {
    return this.organisations.list(principal, parseWith(organisationListQuerySchema, query));
  }

  @Get(':id')
  @RequirePermission('organisation.read')
  get(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<OrganisationDetail> {
    return this.organisations.get(principal, id);
  }

  @Post()
  @RequirePermission('organisation.create')
  create(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<OrganisationDetail> {
    return this.organisations.create(
      principal,
      parseWith(createOrganisationRequestSchema, body),
      clientInfo(request),
    );
  }

  @Patch(':id')
  @RequirePermission('organisation.update')
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @IfMatchHeader() ifMatch: IfMatch,
    @Req() request: FastifyRequest,
  ): Promise<OrganisationDetail> {
    return this.organisations.update(
      principal,
      id,
      parseWith(updateOrganisationRequestSchema, body),
      ifMatch,
      clientInfo(request),
    );
  }

  @Post(':id/actions/archive')
  @HttpCode(200)
  @RequirePermission('organisation.archive')
  archive(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @IfMatchHeader() ifMatch: IfMatch,
    @Req() request: FastifyRequest,
  ): Promise<OrganisationDetail> {
    return this.organisations.archive(principal, id, ifMatch, clientInfo(request));
  }
}
