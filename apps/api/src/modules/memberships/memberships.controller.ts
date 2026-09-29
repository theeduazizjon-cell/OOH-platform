import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import {
  type InviteMemberResponse,
  inviteMemberRequestSchema,
  type IssuedInvitation,
  type MembershipListItem,
  type Page,
  pageQuerySchema,
  setMemberRolesRequestSchema,
} from '@ooh/contracts';
import type { FastifyRequest } from 'fastify';
import { CurrentPrincipal, type Principal, RequirePermission } from '../../core/auth/principal';
import { clientInfo } from '../../core/http/client-info';
import { parseWith } from '../../core/http/validation';
import { InvitationsService } from './invitations.service';
import { MembershipsService } from './memberships.service';

@Controller('memberships')
export class MembershipsController {
  constructor(
    private readonly memberships: MembershipsService,
    private readonly invitations: InvitationsService,
  ) {}

  /** Members of the current tenant (Admin → Users). */
  @Get()
  @RequirePermission('users.read')
  list(@CurrentPrincipal() principal: Principal, @Query() query: unknown): Promise<Page<MembershipListItem>> {
    return this.memberships.list(principal, parseWith(pageQuerySchema, query));
  }

  /** Invites a person by email: creates an INVITED membership and returns its one-time link token. */
  @Post()
  @RequirePermission('users.invite')
  invite(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<InviteMemberResponse> {
    return this.invitations.invite(
      principal,
      parseWith(inviteMemberRequestSchema, body),
      clientInfo(request),
    );
  }

  @Post(':id/actions/resend-invitation')
  @HttpCode(200)
  @RequirePermission('users.invite')
  resendInvitation(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() request: FastifyRequest,
  ): Promise<IssuedInvitation> {
    return this.invitations.resend(principal, id, clientInfo(request));
  }

  @Post(':id/actions/cancel-invitation')
  @HttpCode(204)
  @RequirePermission('users.invite')
  cancelInvitation(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    return this.invitations.cancel(principal, id, clientInfo(request));
  }

  @Post(':id/actions/suspend')
  @HttpCode(200)
  @RequirePermission('users.suspend')
  suspend(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() request: FastifyRequest,
  ): Promise<MembershipListItem> {
    return this.memberships.suspend(principal, id, clientInfo(request));
  }

  @Post(':id/actions/reactivate')
  @HttpCode(200)
  @RequirePermission('users.suspend')
  reactivate(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() request: FastifyRequest,
  ): Promise<MembershipListItem> {
    return this.memberships.reactivate(principal, id, clientInfo(request));
  }

  /** Replaces the member's roles (the member's sessions pick up the change on their next request). */
  @Put(':id/roles')
  @RequirePermission('users.update')
  setRoles(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<MembershipListItem> {
    return this.memberships.setRoles(
      principal,
      id,
      parseWith(setMemberRolesRequestSchema, body),
      clientInfo(request),
    );
  }
}
