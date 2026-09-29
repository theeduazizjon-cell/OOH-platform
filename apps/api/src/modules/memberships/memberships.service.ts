import { Injectable } from '@nestjs/common';
import type { MembershipListItem, Page, PageQuery } from '@ooh/contracts';
import { appUser, invitation, membership, membershipRole, role } from '@ooh/db';
import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm';
import { type Principal } from '../../core/auth/principal';
import { DatabaseService } from '../../core/database/database.service';
import { decodeIdCursor, encodeIdCursor } from '../../core/http/cursor';

@Injectable()
export class MembershipsService {
  constructor(private readonly database: DatabaseService) {}

  /** No tenant filter in the query: RLS scopes it to the principal's tenant. */
  list(principal: Principal, query: PageQuery): Promise<Page<MembershipListItem>> {
    const after = query.cursor ? decodeIdCursor(query.cursor) : undefined;
    return this.database.withTenant(
      { tenantId: principal.tenantId, actorUserId: principal.userId },
      async (tx) => {
        const rows = await tx
          .select({
            id: membership.id,
            userId: membership.userId,
            displayName: appUser.displayName,
            email: appUser.email,
            kind: membership.kind,
            status: membership.status,
            invitationExpiresAt: invitation.expiresAt,
          })
          .from(membership)
          .innerJoin(appUser, eq(appUser.id, membership.userId))
          // At most one pending invitation per membership (partial unique index), so no duplicates.
          .leftJoin(
            invitation,
            and(
              eq(invitation.tenantId, membership.tenantId),
              eq(invitation.membershipId, membership.id),
              isNull(invitation.acceptedAt),
              isNull(invitation.revokedAt),
            ),
          )
          .where(and(isNull(membership.archivedAt), after ? gt(membership.id, after) : undefined))
          .orderBy(asc(membership.id))
          .limit(query.limit + 1);

        const hasMore = rows.length > query.limit;
        const pageRows = rows.slice(0, query.limit);
        const roleRows = pageRows.length
          ? await tx
              .select({ membershipId: membershipRole.membershipId, key: role.key, name: role.name })
              .from(membershipRole)
              .innerJoin(
                role,
                and(eq(role.tenantId, membershipRole.tenantId), eq(role.id, membershipRole.roleId)),
              )
              .where(
                inArray(
                  membershipRole.membershipId,
                  pageRows.map((r) => r.id),
                ),
              )
              .orderBy(asc(role.name))
          : [];

        return {
          data: pageRows.map(({ invitationExpiresAt, ...row }) => ({
            ...row,
            invitation: invitationExpiresAt ? { expiresAt: invitationExpiresAt.toISOString() } : null,
            roles: roleRows.filter((r) => r.membershipId === row.id).map(({ key, name }) => ({ key, name })),
          })),
          page: { nextCursor: hasMore ? encodeIdCursor(pageRows.at(-1)!.id) : null, hasMore },
        };
      },
    );
  }
}
