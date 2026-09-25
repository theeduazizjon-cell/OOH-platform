import { Controller, Get, Query } from '@nestjs/common';
import { type MembershipListItem, type Page, pageQuerySchema } from '@ooh/contracts';
import { CurrentPrincipal, type Principal, RequirePermission } from '../../core/auth/principal';
import { parseWith } from '../../core/http/validation';
import { MembershipsService } from './memberships.service';

@Controller('memberships')
export class MembershipsController {
  constructor(private readonly memberships: MembershipsService) {}

  /** Members of the current tenant (Admin → Users). */
  @Get()
  @RequirePermission('users.read')
  list(@CurrentPrincipal() principal: Principal, @Query() query: unknown): Promise<Page<MembershipListItem>> {
    return this.memberships.list(principal, parseWith(pageQuerySchema, query));
  }
}
