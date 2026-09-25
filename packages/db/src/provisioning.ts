import { ROLE_TEMPLATES } from '@ooh/contracts';
import { and, eq } from 'drizzle-orm';
import type { Database, Transaction } from './client';
import { role, rolePermission, tenant } from './schema';

export interface ProvisionTenantInput {
  readonly name: string;
  readonly slug: string;
}

/**
 * Creates a tenant (if missing) and installs/refreshes the system role templates.
 * Platform-level operation: requires a connection that bypasses RLS (owner/platform role).
 * Idempotent: re-running updates system roles to the current templates.
 */
export async function provisionTenant(
  db: Database,
  input: ProvisionTenantInput,
): Promise<{ tenantId: string }> {
  return db.transaction(async (tx) => {
    await tx
      .insert(tenant)
      .values({ name: input.name, slug: input.slug })
      .onConflictDoNothing({ target: tenant.slug });
    const [row] = await tx.select({ id: tenant.id }).from(tenant).where(eq(tenant.slug, input.slug));
    if (!row) throw new Error(`Tenant ${input.slug} could not be created`);
    await installSystemRoles(tx, row.id);
    return { tenantId: row.id };
  });
}

async function installSystemRoles(tx: Transaction, tenantId: string): Promise<void> {
  for (const template of ROLE_TEMPLATES) {
    const [saved] = await tx
      .insert(role)
      .values({
        tenantId,
        key: template.key,
        name: template.name,
        description: template.description,
        isSystem: true,
        isExternal: template.external,
      })
      .onConflictDoUpdate({
        target: [role.tenantId, role.key],
        set: { name: template.name, description: template.description, isExternal: template.external },
      })
      .returning({ id: role.id });
    if (!saved) throw new Error(`Role ${template.key} could not be saved`);

    await tx
      .delete(rolePermission)
      .where(and(eq(rolePermission.tenantId, tenantId), eq(rolePermission.roleId, saved.id)));
    await tx.insert(rolePermission).values(
      template.grants.map((grant) => ({
        tenantId,
        roleId: saved.id,
        permissionKey: grant.permission,
        scope: grant.scope,
      })),
    );
  }
}
