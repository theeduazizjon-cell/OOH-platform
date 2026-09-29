/**
 * Who may hand out which roles, shared by invitations and role changes (docs/architecture/03-rbac.md
 * §5, "no privilege escalation"). Runs inside the caller's tenant transaction, so RLS already scopes
 * every query to the actor's tenant (a role id from another tenant is simply "unknown").
 */
import { isPermissionKey, type PermissionScope } from '@ooh/contracts';
import { membershipRole, role, rolePermission, type Transaction } from '@ooh/db';
import { and, eq, inArray } from 'drizzle-orm';
import { SCOPE_RANK } from '../../core/auth/access.service';
import { type Principal } from '../../core/auth/principal';
import { AppError } from '../../core/http/app-error';

export interface AssignableRole {
  readonly id: string;
  readonly key: string;
  readonly name: string;
}

/**
 * Roles must exist in this tenant, be active and internal (external members need an organisation,
 * which arrives with the CRM), and grant nothing beyond what the actor holds. Sorted by name.
 */
export async function loadAssignableRoles(
  tx: Transaction,
  principal: Principal,
  roleIds: readonly string[],
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
  if (roles.some((r) => r.isExternal)) {
    throw new AppError(
      'VALIDATION_FAILED',
      'External roles can be assigned once organisations are available.',
      {
        errors: [{ path: 'roleIds', message: 'External roles are not supported yet' }],
      },
    );
  }

  const grants = await tx
    .select({ permission: rolePermission.permissionKey, scope: rolePermission.scope })
    .from(rolePermission)
    .where(inArray(rolePermission.roleId, [...roleIds]));
  const exceeding = exceedingPermissions(principal, grants);
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
  const grants = await tx
    .select({ permission: rolePermission.permissionKey, scope: rolePermission.scope })
    .from(membershipRole)
    .innerJoin(role, and(eq(role.tenantId, membershipRole.tenantId), eq(role.id, membershipRole.roleId)))
    .innerJoin(rolePermission, eq(rolePermission.roleId, role.id))
    .where(and(eq(membershipRole.membershipId, membershipId), eq(role.active, true)));
  // Keys unknown to the catalog grant nothing at runtime (AccessService ignores them).
  const exceeding = exceedingPermissions(
    principal,
    grants.filter((g) => isPermissionKey(g.permission)),
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

function exceedingPermissions(
  principal: Principal,
  grants: readonly { permission: string; scope: PermissionScope }[],
): string[] {
  const exceeding = grants.filter((grant) => !holds(principal, grant.permission, grant.scope));
  return [...new Set(exceeding.map((g) => g.permission))].sort();
}

function holds(principal: Principal, permission: string, scope: PermissionScope): boolean {
  if (!isPermissionKey(permission)) return false;
  const held = principal.permissions.get(permission);
  return held !== undefined && SCOPE_RANK[held] >= SCOPE_RANK[scope];
}
