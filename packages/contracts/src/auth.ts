/**
 * Authentication contract shared by the API and the web app.
 * Design: docs/architecture/03-rbac.md §1, 08-system-architecture.md §7, ADR-0006.
 */
import { z } from 'zod';
import type { PermissionKey, PermissionScope } from './permissions';

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/** httpOnly cookie carrying the refresh token; scoped to the auth endpoints only. */
export const REFRESH_COOKIE_NAME = 'ooh_rt';
export const REFRESH_COOKIE_PATH = '/api/v1/auth';
/**
 * Custom header required on cookie-authenticated endpoints (refresh, logout, switch-tenant).
 * Browsers can't send it cross-site without a CORS preflight, which only allowed origins pass.
 */
export const CSRF_HEADER = 'x-ooh-csrf';

export const loginRequestSchema = z.object({
  email: z.email().max(254),
  // Only a max length on login: policy is enforced when passwords are set, not when checked.
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  /** Optional tenant to sign into; defaults to the user's first active membership. */
  tenantId: z.uuid().optional(),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const switchTenantRequestSchema = z.object({ tenantId: z.uuid() });
export type SwitchTenantRequest = z.infer<typeof switchTenantRequestSchema>;

/** Returned by login, refresh and switch-tenant. The refresh token travels only in the cookie. */
export interface AuthSession {
  accessToken: string;
  /** ISO timestamp; the client refreshes shortly before. */
  accessTokenExpiresAt: string;
  tenantId: string;
  membershipId: string;
}

export interface MembershipSummary {
  membershipId: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  kind: 'INTERNAL' | 'EXTERNAL';
}

export interface MeResponse {
  user: { id: string; email: string; displayName: string; locale: string | null };
  tenant: {
    id: string;
    name: string;
    slug: string;
    locale: string;
    timezone: string;
    defaultCurrency: string;
  };
  membership: { id: string; kind: 'INTERNAL' | 'EXTERNAL'; roles: { key: string; name: string }[] };
  /** Effective permissions (union of roles, widest scope wins). */
  permissions: Partial<Record<PermissionKey, PermissionScope>>;
  /** All tenants the user can switch to. */
  memberships: MembershipSummary[];
}

export interface MembershipListItem {
  id: string;
  userId: string;
  displayName: string;
  email: string;
  kind: 'INTERNAL' | 'EXTERNAL';
  status: 'INVITED' | 'ACTIVE' | 'SUSPENDED';
  roles: { id: string; key: string; name: string }[];
  /** The pending invitation of an INVITED member (null once accepted, or when none is pending). */
  invitation: { expiresAt: string } | null;
  /** Optimistic-locking version; send it back as `If-Match: etagOf(version)` when changing the member. */
  version: number;
}

/** A tenant role (Admin → Roles; also the choices when inviting). */
export interface RoleListItem {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  /** External roles are for client/agency/supplier/decorator members. */
  isExternal: boolean;
  active: boolean;
}

/** Roles given to a member (invitation or role change): 1–10 distinct role ids of the tenant. */
export const memberRoleIdsSchema = z
  .array(z.uuid())
  .min(1)
  .max(10)
  .refine((ids) => new Set(ids).size === ids.length, 'Role ids must be unique');

/** PUT /memberships/{id}/roles: replaces the member's roles. */
export const setMemberRolesRequestSchema = z.object({ roleIds: memberRoleIdsSchema });
export type SetMemberRolesRequest = z.infer<typeof setMemberRolesRequestSchema>;
