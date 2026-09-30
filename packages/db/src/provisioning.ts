import {
  DEFAULT_ACTIVITY_TYPES,
  DEFAULT_ORGANISATION_CLASSIFICATIONS,
  DEFAULT_PIPELINE,
  ROLE_TEMPLATES,
} from '@ooh/contracts';
import { and, eq } from 'drizzle-orm';
import type { Database, Transaction } from './client';
import {
  activityType,
  organisationClassification,
  pipeline,
  pipelineStage,
  role,
  rolePermission,
  tenant,
} from './schema';

export interface ProvisionTenantInput {
  readonly name: string;
  readonly slug: string;
}

/**
 * Creates a tenant (if missing), installs/refreshes the system role templates and installs the
 * default nomenclatures. Platform-level operation: requires a connection that bypasses RLS
 * (owner/platform role). Idempotent: re-running updates system roles to the current templates and
 * adds missing defaults, but never overwrites nomenclatures the tenant edited.
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
    await installDefaultClassifications(tx, row.id);
    await installDefaultActivityTypes(tx, row.id);
    await installDefaultPipeline(tx, row.id);
    return { tenantId: row.id };
  });
}

async function installDefaultClassifications(tx: Transaction, tenantId: string): Promise<void> {
  await tx
    .insert(organisationClassification)
    .values(
      DEFAULT_ORGANISATION_CLASSIFICATIONS.map((c, index) => ({
        tenantId,
        key: c.key,
        name: c.name,
        sortOrder: (index + 1) * 10,
      })),
    )
    .onConflictDoNothing({ target: [organisationClassification.tenantId, organisationClassification.key] });
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

async function installDefaultActivityTypes(tx: Transaction, tenantId: string): Promise<void> {
  await tx
    .insert(activityType)
    .values(
      DEFAULT_ACTIVITY_TYPES.map((t, index) => ({
        tenantId,
        key: t.key,
        name: t.name,
        isSystem: t.isSystem,
        sortOrder: (index + 1) * 10,
      })),
    )
    .onConflictDoNothing({ target: [activityType.tenantId, activityType.key] });
}

/** Only for a tenant without any pipeline: the tenant owns its pipelines after that. */
async function installDefaultPipeline(tx: Transaction, tenantId: string): Promise<void> {
  const [existing] = await tx
    .select({ id: pipeline.id })
    .from(pipeline)
    .where(eq(pipeline.tenantId, tenantId))
    .limit(1);
  if (existing) return;
  const [created] = await tx
    .insert(pipeline)
    .values({ tenantId, name: DEFAULT_PIPELINE.name, isDefault: true })
    .returning({ id: pipeline.id });
  await tx.insert(pipelineStage).values(
    DEFAULT_PIPELINE.stages.map((stage, index) => ({
      tenantId,
      pipelineId: created!.id,
      name: stage.name,
      kind: stage.kind,
      probability: stage.probability,
      position: (index + 1) * 10,
    })),
  );
}
