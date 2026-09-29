import { Controller, Get } from '@nestjs/common';
import type { Page, RoleListItem } from '@ooh/contracts';
import { CurrentPrincipal, type Principal, RequirePermission } from '../../core/auth/principal';
import { RolesService } from './roles.service';

@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  /** Roles of the current tenant (Admin → Roles, and the choices when inviting). */
  @Get()
  @RequirePermission('roles.read')
  list(@CurrentPrincipal() principal: Principal): Promise<Page<RoleListItem>> {
    return this.roles.list(principal);
  }
}
