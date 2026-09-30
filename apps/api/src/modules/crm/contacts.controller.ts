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
  type ContactDetail,
  type ContactListItem,
  contactListQuerySchema,
  createContactRequestSchema,
  type Page,
  updateContactRequestSchema,
} from '@ooh/contracts';
import type { FastifyRequest } from 'fastify';
import { CurrentPrincipal, type Principal, RequirePermission } from '../../core/auth/principal';
import { clientInfo } from '../../core/http/client-info';
import { type IfMatch, IfMatchHeader, VersionEtagInterceptor } from '../../core/http/concurrency';
import { parseWith } from '../../core/http/validation';
import { ContactsService } from './contacts.service';

/** CRM contacts (docs/architecture/10-api.md). Changes and actions require If-Match. */
@Controller('contacts')
@UseInterceptors(VersionEtagInterceptor)
export class ContactsController {
  constructor(private readonly contacts: ContactsService) {}

  @Get()
  @RequirePermission('contact.read')
  list(@CurrentPrincipal() principal: Principal, @Query() query: unknown): Promise<Page<ContactListItem>> {
    return this.contacts.list(principal, parseWith(contactListQuerySchema, query));
  }

  @Get(':id')
  @RequirePermission('contact.read')
  get(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ContactDetail> {
    return this.contacts.get(principal, id);
  }

  @Post()
  @RequirePermission('contact.create')
  create(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<ContactDetail> {
    return this.contacts.create(principal, parseWith(createContactRequestSchema, body), clientInfo(request));
  }

  @Patch(':id')
  @RequirePermission('contact.update')
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @IfMatchHeader() ifMatch: IfMatch,
    @Req() request: FastifyRequest,
  ): Promise<ContactDetail> {
    return this.contacts.update(
      principal,
      id,
      parseWith(updateContactRequestSchema, body),
      ifMatch,
      clientInfo(request),
    );
  }

  @Post(':id/actions/archive')
  @HttpCode(200)
  @RequirePermission('contact.archive')
  archive(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @IfMatchHeader() ifMatch: IfMatch,
    @Req() request: FastifyRequest,
  ): Promise<ContactDetail> {
    return this.contacts.archive(principal, id, ifMatch, clientInfo(request));
  }

  /** GDPR erasure: irreversible. */
  @Post(':id/actions/anonymise')
  @HttpCode(200)
  @RequirePermission('contact.anonymise')
  anonymise(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @IfMatchHeader() ifMatch: IfMatch,
    @Req() request: FastifyRequest,
  ): Promise<ContactDetail> {
    return this.contacts.anonymise(principal, id, ifMatch, clientInfo(request));
  }
}
