/**
 * Roles admin contract (Admin → Roles). System roles come from ROLE_TEMPLATES and are read-only
 * except for enabling/disabling (OPD-27); tenants customise by duplicating into custom roles.
 * Design: docs/architecture/03-rbac.md §2–3, 10-api.md.
 */
import { z } from 'zod';
import type { RoleListItem } from './auth';
import {
  PERMISSION_KEYS,
  PERMISSION_SCOPES,
  type PermissionDefinition,
  type PermissionKey,
  type PermissionScope,
  PERMISSIONS,
} from './permissions';

export const roleGrantSchema = z.object({
  permission: z.string().min(1).max(100),
  scope: z.enum(PERMISSION_SCOPES),
});

const roleNameSchema = z.string().trim().min(1).max(80);
const roleDescriptionSchema = z.string().trim().max(500).nullable();
const roleGrantsSchema = z.array(roleGrantSchema).min(1).max(PERMISSION_KEYS.length);

/** POST /roles: a custom (internal) role. The key is derived from the name by the API. */
export const createRoleRequestSchema = z.object({
  name: roleNameSchema,
  description: roleDescriptionSchema.optional(),
  grants: roleGrantsSchema,
});
export type CreateRoleRequest = z.infer<typeof createRoleRequestSchema>;

/** PATCH /roles/{id} (If-Match required). System roles accept `active` only. */
export const updateRoleRequestSchema = z
  .object({
    name: roleNameSchema.optional(),
    description: roleDescriptionSchema.optional(),
    grants: roleGrantsSchema.optional(),
    active: z.boolean().optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), 'Nothing to change');
export type UpdateRoleRequest = z.infer<typeof updateRoleRequestSchema>;

export interface RoleGrant {
  permission: PermissionKey;
  scope: PermissionScope;
}

export interface RoleDetail extends RoleListItem {
  grants: RoleGrant[];
}

/** GET /permissions: the code-defined catalog roles are built from. */
export interface PermissionCatalogItem {
  key: PermissionKey;
  module: string;
  description: string;
  scopes: readonly PermissionScope[];
  internalOnly: boolean;
}

export function permissionCatalog(): PermissionCatalogItem[] {
  return PERMISSION_KEYS.map((key) => {
    const definition: PermissionDefinition = PERMISSIONS[key];
    return {
      key,
      module: definition.module,
      description: definition.description,
      scopes: definition.scopes,
      internalOnly: definition.internalOnly ?? false,
    };
  });
}
