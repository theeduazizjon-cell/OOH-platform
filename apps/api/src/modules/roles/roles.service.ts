import { Injectable } from '@nestjs/common';
import type { Page, RoleListItem } from '@ooh/contracts';
import { role } from '@ooh/db';
import { asc } from 'drizzle-orm';
import { type Principal } from '../../core/auth/principal';
import { DatabaseService } from '../../core/database/database.service';

@Injectable()
export class RolesService {
  constructor(private readonly database: DatabaseService) {}

  /**
   * All roles of the current tenant (RLS scopes the query). A tenant has a bounded number of roles
   * (the system templates plus its own), so they are returned in a single page.
   */
  list(principal: Principal): Promise<Page<RoleListItem>> {
    return this.database.withTenant(
      { tenantId: principal.tenantId, actorUserId: principal.userId },
      async (tx) => {
        const data = await tx
          .select({
            id: role.id,
            key: role.key,
            name: role.name,
            description: role.description,
            isSystem: role.isSystem,
            isExternal: role.isExternal,
            active: role.active,
          })
          .from(role)
          .orderBy(asc(role.isExternal), asc(role.name));
        return { data, page: { nextCursor: null, hasMore: false } };
      },
    );
  }
}
