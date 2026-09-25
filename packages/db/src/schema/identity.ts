/**
 * Identity & access: tenants, global users, per-tenant memberships, configurable roles.
 * Design: docs/architecture/03-rbac.md, 07-database.md §2.
 *
 * Tenant-isolation rules that apply to EVERY tenant-owned table in this project:
 *   1. `tenant_id uuid NOT NULL`
 *   2. `UNIQUE (tenant_id, id)`, so children can reference it with a composite FK
 *   3. references to other tenant-owned tables are composite: (tenant_id, x_id) → x(tenant_id, id)
 *   4. RLS enabled + forced with a policy (hand-written migration). Tests enforce 1–4.
 */
import { PERMISSION_SCOPES } from '@ooh/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  inet,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { archivedAt, citext, primaryId, tenantIdColumn, timestamps, versionColumn } from './columns';

export const tenantStatus = pgEnum('tenant_status', ['ACTIVE', 'SUSPENDED']);
export const membershipKind = pgEnum('membership_kind', ['INTERNAL', 'EXTERNAL']);
export const membershipStatus = pgEnum('membership_status', ['INVITED', 'ACTIVE', 'SUSPENDED']);
export const permissionScope = pgEnum('permission_scope', PERMISSION_SCOPES);

/** The OOH company using the platform. Global table (the tenant is the isolation boundary itself). */
export const tenant = pgTable('tenant', {
  id: primaryId(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique('tenant_slug_uq'),
  status: tenantStatus('status').notNull().default('ACTIVE'),
  locale: text('locale').notNull().default('ro-RO'),
  timezone: text('timezone').notNull().default('Europe/Bucharest'),
  defaultCurrency: text('default_currency').notNull().default('RON'),
  settings: jsonb('settings')
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  ...timestamps(),
  version: versionColumn(),
});

/** A person. Global: one login may belong to several tenants (e.g. a decorator firm or agency). */
export const appUser = pgTable(
  'app_user',
  {
    id: primaryId(),
    email: citext('email').notNull(),
    /** argon2id hash; null until the invitation is accepted (or for magic-link-only users). */
    passwordHash: text('password_hash'),
    displayName: text('display_name').notNull(),
    phone: text('phone'),
    locale: text('locale'),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    archivedAt: archivedAt(),
    ...timestamps(),
    version: versionColumn(),
  },
  (t) => [unique('app_user_email_uq').on(t.email)],
);

/** A user's membership in one tenant. External memberships represent a client/agency/supplier/decorator. */
export const membership = pgTable(
  'membership',
  {
    id: primaryId(),
    tenantId: tenantIdColumn().references(() => tenant.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUser.id),
    kind: membershipKind('kind').notNull().default('INTERNAL'),
    status: membershipStatus('status').notNull().default('INVITED'),
    /**
     * CRM organisation an EXTERNAL member represents (drives ORGANISATION scope).
     * The composite FK to organisation(tenant_id, id) is added with the CRM module (M2).
     */
    organisationId: uuid('organisation_id'),
    /** Bumped whenever roles/permissions change, which forces access-token refresh. */
    permsVersion: integer('perms_version').notNull().default(1),
    archivedAt: archivedAt(),
    ...timestamps(),
    version: versionColumn(),
  },
  (t) => [
    unique('membership_tenant_id_id_uq').on(t.tenantId, t.id),
    unique('membership_tenant_user_uq').on(t.tenantId, t.userId),
    index('membership_user_idx').on(t.userId),
    check(
      'membership_external_has_organisation_ck',
      // Enforced once the CRM exists; until then external members may be created without one.
      sql`${t.kind} = 'INTERNAL' OR ${t.organisationId} IS NOT NULL OR ${t.status} = 'INVITED'`,
    ),
  ],
);

/** Tenant-configurable role. System roles are seeded from ROLE_TEMPLATES and cannot be deleted. */
export const role = pgTable(
  'role',
  {
    id: primaryId(),
    tenantId: tenantIdColumn().references(() => tenant.id),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    isSystem: boolean('is_system').notNull().default(false),
    isExternal: boolean('is_external').notNull().default(false),
    active: boolean('active').notNull().default(true),
    ...timestamps(),
    version: versionColumn(),
  },
  (t) => [
    unique('role_tenant_id_id_uq').on(t.tenantId, t.id),
    unique('role_tenant_key_uq').on(t.tenantId, t.key),
    check('role_key_format_ck', sql`${t.key} ~ '^[a-z][a-z0-9_]*$'`),
  ],
);

/** Grant of one catalog permission (packages/contracts) at a scope. */
export const rolePermission = pgTable(
  'role_permission',
  {
    tenantId: tenantIdColumn(),
    roleId: uuid('role_id').notNull(),
    permissionKey: text('permission_key').notNull(),
    scope: permissionScope('scope').notNull().default('ALL'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'role_permission_pk', columns: [t.roleId, t.permissionKey] }),
    foreignKey({
      name: 'role_permission_role_fk',
      columns: [t.tenantId, t.roleId],
      foreignColumns: [role.tenantId, role.id],
    }).onDelete('cascade'),
    check('role_permission_key_format_ck', sql`${t.permissionKey} ~ '^[a-z_]+(\\.[a-z_]+)+$'`),
  ],
);

export const membershipRole = pgTable(
  'membership_role',
  {
    tenantId: tenantIdColumn(),
    membershipId: uuid('membership_id').notNull(),
    roleId: uuid('role_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'membership_role_pk', columns: [t.membershipId, t.roleId] }),
    foreignKey({
      name: 'membership_role_membership_fk',
      columns: [t.tenantId, t.membershipId],
      foreignColumns: [membership.tenantId, membership.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'membership_role_role_fk',
      columns: [t.tenantId, t.roleId],
      foreignColumns: [role.tenantId, role.id],
    }).onDelete('cascade'),
    index('membership_role_role_idx').on(t.tenantId, t.roleId),
  ],
);

/**
 * Refresh tokens (rotating, one row per issued token). Not tenant-owned: it belongs to a user and
 * records which tenant the session is currently in. Visible only in user mode to its own user (RLS).
 * Only a SHA-256 hash of the high-entropy secret is stored.
 */
export const refreshToken = pgTable(
  'refresh_token',
  {
    id: primaryId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUser.id),
    /** All tokens rotated from one login share a family; reuse of a rotated token revokes the family. */
    familyId: uuid('family_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    activeTenantId: uuid('active_tenant_id')
      .notNull()
      .references(() => tenant.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    replacedById: uuid('replaced_by_id'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('refresh_token_family_idx').on(t.familyId), index('refresh_token_user_idx').on(t.userId)],
);
