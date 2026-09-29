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
  Req,
  UseInterceptors,
} from '@nestjs/common';
import {
  createRoleRequestSchema,
  type Page,
  type PermissionCatalogItem,
  permissionCatalog,
  type RoleDetail,
  type RoleListItem,
  updateRoleRequestSchema,
} from '@ooh/contracts';
import type { FastifyRequest } from 'fastify';
import { CurrentPrincipal, type Principal, RequirePermission } from '../../core/auth/principal';
import { clientInfo } from '../../core/http/client-info';
import { type IfMatch, IfMatchHeader, VersionEtagInterceptor } from '../../core/http/concurrency';
import { parseWith } from '../../core/http/validation';
import { RolesService } from './roles.service';

/** Admin → Roles. Changes to an existing role require If-Match with its version (412/428). */
@Controller('roles')
@UseInterceptors(VersionEtagInterceptor)
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  /** Roles of the current tenant (Admin → Roles, and the choices when inviting). */
  @Get()
  @RequirePermission('roles.read')
  list(@CurrentPrincipal() principal: Principal): Promise<Page<RoleListItem>> {
    return this.roles.list(principal);
  }

  @Get(':id')
  @RequirePermission('roles.read')
  get(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string): Promise<RoleDetail> {
    return this.roles.get(principal, id);
  }

  @Post()
  @RequirePermission('roles.manage')
  create(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<RoleDetail> {
    return this.roles.create(principal, parseWith(createRoleRequestSchema, body), clientInfo(request));
  }

  @Patch(':id')
  @RequirePermission('roles.manage')
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @IfMatchHeader() ifMatch: IfMatch,
    @Req() request: FastifyRequest,
  ): Promise<RoleDetail> {
    return this.roles.update(
      principal,
      id,
      parseWith(updateRoleRequestSchema, body),
      ifMatch,
      clientInfo(request),
    );
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('roles.manage')
  remove(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @IfMatchHeader() ifMatch: IfMatch,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    return this.roles.remove(principal, id, ifMatch, clientInfo(request));
  }
}

/** The code-defined permission catalog roles are built from (docs/architecture/03-rbac.md §2). */
@Controller('permissions')
export class PermissionsController {
  @Get()
  @RequirePermission('roles.read')
  list(): { data: PermissionCatalogItem[] } {
    return { data: permissionCatalog() };
  }
}
