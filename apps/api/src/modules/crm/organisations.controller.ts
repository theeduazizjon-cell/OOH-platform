import {
  Body,
  Controller,
  Delete,
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
  type AccountOwnerCandidate,
  createOrganisationRequestSchema,
  createRelationshipRequestSchema,
  type OrganisationRelationshipItem,
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
import { RelationshipsService } from './relationships.service';

/**
 * CRM companies (docs/architecture/10-api.md). POST runs duplicate detection: 409
 * DUPLICATE_SUSPECTED with `meta.matches` unless `force: true` with a `forceReason` (not possible for
 * an identical VAT number). Changes require If-Match.
 */
@Controller('organisations')
@UseInterceptors(VersionEtagInterceptor)
export class OrganisationsController {
  constructor(
    private readonly organisations: OrganisationsService,
    private readonly relationships: RelationshipsService,
  ) {}

  @Get()
  @RequirePermission('organisation.read')
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: unknown,
  ): Promise<Page<OrganisationListItem>> {
    return this.organisations.list(principal, parseWith(organisationListQuerySchema, query));
  }

  /** Declared before ':id'. Active internal members, for the account owner picker. */
  @Get('account-owners')
  @RequirePermission('organisation.update')
  accountOwners(@CurrentPrincipal() principal: Principal): Promise<AccountOwnerCandidate[]> {
    return this.organisations.accountOwners(principal);
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

  // ── relationships (agency ↔ client, supplier, parent) ─────────────────────

  @Get(':id/relationships')
  @RequirePermission('organisation.read')
  listRelationships(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<OrganisationRelationshipItem[]> {
    return this.relationships.list(principal, id);
  }

  /** {id} is the "from" side: {id} is the agency of / supplier to / parent of toOrganisationId. */
  @Post(':id/relationships')
  @RequirePermission('organisation.update')
  addRelationship(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<OrganisationRelationshipItem[]> {
    return this.relationships.create(
      principal,
      id,
      parseWith(createRelationshipRequestSchema, body),
      clientInfo(request),
    );
  }

  @Delete(':id/relationships/:relationshipId')
  @HttpCode(204)
  @RequirePermission('organisation.update')
  removeRelationship(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('relationshipId', ParseUUIDPipe) relationshipId: string,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    return this.relationships.remove(principal, id, relationshipId, clientInfo(request));
  }
}
