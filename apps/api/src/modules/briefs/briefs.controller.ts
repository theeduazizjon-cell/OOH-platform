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
  type BriefAction,
  type BriefDetail,
  type BriefListItem,
  briefListQuerySchema,
  createBriefRequestSchema,
  discardBriefRequestSchema,
  type Page,
  putBriefLinesRequestSchema,
  updateBriefRequestSchema,
} from '@ooh/contracts';
import type { FastifyRequest } from 'fastify';
import { CurrentPrincipal, type Principal, RequirePermission } from '../../core/auth/principal';
import { clientInfo } from '../../core/http/client-info';
import { type IfMatch, IfMatchHeader, VersionEtagInterceptor } from '../../core/http/concurrency';
import { parseWith } from '../../core/http/validation';
import { BriefsService } from './briefs.service';

/**
 * Briefs (docs/architecture/10-api.md): CRUD, lines, and actions confirm / reopen / discard
 * (convert arrives with campaigns). Changes and actions require If-Match.
 */
@Controller()
@UseInterceptors(VersionEtagInterceptor)
export class BriefsController {
  constructor(private readonly briefs: BriefsService) {}

  @Get('briefs')
  @RequirePermission('brief.read')
  list(@CurrentPrincipal() principal: Principal, @Query() query: unknown): Promise<Page<BriefListItem>> {
    return this.briefs.list(principal, parseWith(briefListQuerySchema, query));
  }

  @Get('briefs/:id')
  @RequirePermission('brief.read')
  get(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<BriefDetail> {
    return this.briefs.get(principal, id);
  }

  @Post('briefs')
  @RequirePermission('brief.create')
  create(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<BriefDetail> {
    return this.briefs.create(principal, parseWith(createBriefRequestSchema, body), clientInfo(request));
  }

  /** A draft brief from a won opportunity (04-user-flows.md A2'). */
  @Post('opportunities/:id/brief')
  @RequirePermission('brief.create')
  fromOpportunity(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() request: FastifyRequest,
  ): Promise<BriefDetail> {
    return this.briefs.createFromOpportunity(principal, id, clientInfo(request));
  }

  @Patch('briefs/:id')
  @RequirePermission('brief.update')
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @IfMatchHeader() ifMatch: IfMatch,
    @Req() request: FastifyRequest,
  ): Promise<BriefDetail> {
    return this.briefs.update(
      principal,
      id,
      parseWith(updateBriefRequestSchema, body),
      ifMatch,
      clientInfo(request),
    );
  }

  @Put('briefs/:id/lines')
  @RequirePermission('brief.update')
  replaceLines(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @IfMatchHeader() ifMatch: IfMatch,
    @Req() request: FastifyRequest,
  ): Promise<BriefDetail> {
    const { lines } = parseWith(putBriefLinesRequestSchema, body);
    return this.briefs.replaceLines(principal, id, lines, ifMatch, clientInfo(request));
  }

  @Post('briefs/:id/actions/confirm')
  @HttpCode(200)
  @RequirePermission('brief.confirm')
  confirm(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @IfMatchHeader() ifMatch: IfMatch,
    @Req() request: FastifyRequest,
  ): Promise<BriefDetail> {
    return this.act(principal, id, 'confirm', {}, ifMatch, request);
  }

  @Post('briefs/:id/actions/reopen')
  @HttpCode(200)
  @RequirePermission('brief.confirm')
  reopen(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @IfMatchHeader() ifMatch: IfMatch,
    @Req() request: FastifyRequest,
  ): Promise<BriefDetail> {
    return this.act(principal, id, 'reopen', {}, ifMatch, request);
  }

  @Post('briefs/:id/actions/discard')
  @HttpCode(200)
  @RequirePermission('brief.discard')
  discard(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @IfMatchHeader() ifMatch: IfMatch,
    @Req() request: FastifyRequest,
  ): Promise<BriefDetail> {
    return this.act(principal, id, 'discard', parseWith(discardBriefRequestSchema, body), ifMatch, request);
  }

  private act(
    principal: Principal,
    id: string,
    action: BriefAction,
    input: { reason?: string },
    ifMatch: IfMatch,
    request: FastifyRequest,
  ): Promise<BriefDetail> {
    return this.briefs.transition(principal, id, action, input, ifMatch, clientInfo(request));
  }
}
