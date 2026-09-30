/**
 * Who may hand out which roles, shared by invitations and role changes (docs/architecture/03-rbac.md
 * §5, "no privilege escalation"). Runs inside the caller's tenant transaction, so RLS already scopes
 * every query to the actor's tenant (a role id from another tenant is simply "unknown").
 */
import { EXTERNAL_PARTY_PERMISSIONS, isPermissionKey, type PermissionScope } from '@ooh/contracts';
import { membership, membershipRole, role, rolePermission, type Transaction } from '@ooh/db';
import { and, eq, inArray } from 'drizzle-orm';
import { SCOPE_RANK } from '../../core/auth/access.service';
import { type Principal } from '../../core/auth/principal';
import { AppError } from '../../core/http/app-error';

export type MemberKind = 'INTERNAL' | 'EXTERNAL';

export interface AssignableRole {
  readonly id: string;
  readonly key: string;
  readonly name: string;
}

type Grant = { permission: string; scope: PermissionScope };

/**
 * Roles must exist in this tenant, be active, match the member kind (internal roles for internal
 * members, external roles for members representing an organisation), and grant nothing beyond what
 * the actor holds. Sorted by name.
 */
export async function loadAssignableRoles(
  tx: Transaction,
  principal: Principal,
  roleIds: readonly string[],
  kind: MemberKind,
): Promise<AssignableRole[]> {
  const roles = await tx
    .select({ id: role.id, key: role.key, name: role.name, active: role.active, isExternal: role.isExternal })
    .from(role)
    .where(inArray(role.id, [...roleIds]));
  if (roles.length !== roleIds.length || roles.some((r) => !r.active)) {
    throw new AppError('VALIDATION_FAILED', 'Unknown or disabled role.', {
      errors: [{ path: 'roleIds', message: 'Unknown or disabled role' }],
    });
  }
  const external = kind === 'EXTERNAL';
  if (roles.some((r) => r.isExternal !== external)) {
    throw new AppError(
      'VALIDATION_FAILED',
      external
        ? 'People representing a company only get external roles (client, agency, supplier…).'
        : 'External roles are for people representing a company: choose the company they belong to.',
      { errors: [{ path: 'roleIds', message: external ? 'Internal role' : 'External role' }] },
    );
  }

  const grants = await tx
    .select({ permission: rolePermission.permissionKey, scope: rolePermission.scope })
    .from(rolePermission)
    .where(inArray(rolePermission.roleId, [...roleIds]));
  const exceeding = exceedingPermissions(principal, forEscalationCheck(grants, kind));
  if (exceeding.length > 0) {
    throw new AppError('FORBIDDEN', 'You cannot grant permissions you do not have yourself.', {
      meta: { permissions: exceeding },
    });
  }
  return roles.map(({ id, key, name }) => ({ id, key, name })).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The actor may only manage (suspend, reactivate, change roles of) members whose current
 * permissions they hold themselves: a limited user administrator can't act on a Company Admin.
 */
export async function assertCanManageMember(
  tx: Transaction,
  principal: Principal,
  membershipId: string,
): Promise<void> {
  const [member] = await tx
    .select({ kind: membership.kind })
    .from(membership)
    .where(eq(membership.id, membershipId));
  const grants = await tx
    .select({ permission: rolePermission.permissionKey, scope: rolePermission.scope })
    .from(membershipRole)
    .innerJoin(role, and(eq(role.tenantId, membershipRole.tenantId), eq(role.id, membershipRole.roleId)))
    .innerJoin(rolePermission, eq(rolePermission.roleId, role.id))
    .where(and(eq(membershipRole.membershipId, membershipId), eq(role.active, true)));
  // Keys unknown to the catalog grant nothing at runtime (AccessService ignores them).
  const exceeding = exceedingPermissions(
    principal,
    forEscalationCheck(
      grants.filter((g) => isPermissionKey(g.permission)),
      member?.kind ?? 'INTERNAL',
    ),
  );
  if (exceeding.length > 0) {
    throw new AppError(
      'FORBIDDEN',
      'This member has permissions you do not have, so you cannot manage them.',
      {
        meta: { permissions: exceeding },
      },
    );
  }
}

/**
 * Throws 403 unless the actor holds every grant (same or wider scope). Used when defining roles:
 * nobody can create or edit a role granting more than they have, nor edit one that does.
 */
export function assertHoldsGrants(principal: Principal, grants: readonly Grant[], message: string): void {
  const exceeding = exceedingPermissions(
    principal,
    grants.filter((g) => isPermissionKey(g.permission)),
  );
  if (exceeding.length > 0) throw new AppError('FORBIDDEN', message, { meta: { permissions: exceeding } });
}

/**
 * External-party actions (a client deciding on a study, a supplier updating its order) belong to the
 * external party by design, so internal admins never hold them. They are exempt from the escalation
 * check only for EXTERNAL members and only at ORGANISATION scope, i.e. acting for their own company.
 */
function forEscalationCheck(grants: readonly Grant[], kind: MemberKind): Grant[] {
  if (kind === 'INTERNAL') return [...grants];
  return grants.filter(
    (g) =>
      !(
        g.scope === 'ORGANISATION' &&
        isPermissionKey(g.permission) &&
        EXTERNAL_PARTY_PERMISSIONS.includes(g.permission)
      ),
  );
}

function exceedingPermissions(principal: Principal, grants: readonly Grant[]): string[] {
  const exceeding = grants.filter((grant) => !holds(principal, grant.permission, grant.scope));
  return [...new Set(exceeding.map((g) => g.permission))].sort();
}

function holds(principal: Principal, permission: string, scope: PermissionScope): boolean {
  if (!isPermissionKey(permission)) return false;
  const held = principal.permissions.get(permission);
  return held !== undefined && SCOPE_RANK[held] >= SCOPE_RANK[scope];
}
