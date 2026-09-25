/**
 * Permission catalog: the single source of truth for every permission key the API checks.
 *
 * Keys are defined in code (code checks them); roles are tenant data that grant keys at a scope.
 * See docs/architecture/03-rbac.md.
 */

export const PERMISSION_SCOPES = ['ALL', 'OWN', 'ASSIGNED', 'ORGANISATION'] as const;
export type PermissionScope = (typeof PERMISSION_SCOPES)[number];

export interface PermissionDefinition {
  readonly module: string;
  readonly description: string;
  /** Scopes this permission may be granted at. */
  readonly scopes: readonly PermissionScope[];
  /** Never grantable to external (client, agency, supplier, decorator) roles. */
  readonly internalOnly?: boolean;
  /** Human decision required: never available to the AI principal [R§39]. */
  readonly aiForbidden?: boolean;
}

const ALL = ['ALL'] as const;
const ALL_OWN = ['ALL', 'OWN'] as const;
const ALL_ORG = ['ALL', 'ORGANISATION'] as const;
const ALL_ASSIGNED = ['ALL', 'ASSIGNED'] as const;
const ALL_ASSIGNED_ORG = ['ALL', 'ASSIGNED', 'ORGANISATION'] as const;
const ANY = PERMISSION_SCOPES;

export const PERMISSIONS = {
  // ── Administration ────────────────────────────────────────────────────────
  'users.read': {
    module: 'admin',
    description: 'View users and memberships',
    scopes: ALL,
    internalOnly: true,
  },
  'users.invite': {
    module: 'admin',
    description: 'Invite users',
    scopes: ALL,
    internalOnly: true,
    aiForbidden: true,
  },
  'users.update': {
    module: 'admin',
    description: 'Edit memberships and assign roles',
    scopes: ALL,
    internalOnly: true,
    aiForbidden: true,
  },
  'users.suspend': {
    module: 'admin',
    description: 'Suspend or reactivate memberships',
    scopes: ALL,
    internalOnly: true,
    aiForbidden: true,
  },
  'roles.read': {
    module: 'admin',
    description: 'View roles and permissions',
    scopes: ALL,
    internalOnly: true,
  },
  'roles.manage': {
    module: 'admin',
    description: 'Create and edit roles',
    scopes: ALL,
    internalOnly: true,
    aiForbidden: true,
  },
  'settings.read': { module: 'admin', description: 'View company settings', scopes: ALL, internalOnly: true },
  'settings.manage': {
    module: 'admin',
    description: 'Edit company settings',
    scopes: ALL,
    internalOnly: true,
    aiForbidden: true,
  },
  'config.read': {
    module: 'admin',
    description: 'View nomenclatures (asset types, services, stages…)',
    scopes: ALL,
    internalOnly: true,
  },
  'config.manage': {
    module: 'admin',
    description: 'Edit nomenclatures',
    scopes: ALL,
    internalOnly: true,
    aiForbidden: true,
  },
  'audit.read': { module: 'admin', description: 'View the audit trail', scopes: ALL_OWN, internalOnly: true },

  // ── CRM ───────────────────────────────────────────────────────────────────
  'organisation.read': { module: 'crm', description: 'View companies', scopes: ALL_OWN, internalOnly: true },
  'organisation.create': { module: 'crm', description: 'Create companies', scopes: ALL, internalOnly: true },
  'organisation.update': {
    module: 'crm',
    description: 'Edit companies',
    scopes: ALL_OWN,
    internalOnly: true,
  },
  'organisation.archive': {
    module: 'crm',
    description: 'Archive companies',
    scopes: ALL,
    internalOnly: true,
  },
  'organisation.export': {
    module: 'crm',
    description: 'Export companies',
    scopes: ALL_OWN,
    internalOnly: true,
  },
  'contact.read': { module: 'crm', description: 'View contacts', scopes: ALL_OWN, internalOnly: true },
  'contact.create': { module: 'crm', description: 'Create contacts', scopes: ALL, internalOnly: true },
  'contact.update': { module: 'crm', description: 'Edit contacts', scopes: ALL_OWN, internalOnly: true },
  'contact.archive': { module: 'crm', description: 'Archive contacts', scopes: ALL, internalOnly: true },
  'contact.export': { module: 'crm', description: 'Export contacts', scopes: ALL_OWN, internalOnly: true },
  'contact.anonymise': {
    module: 'crm',
    description: 'GDPR-anonymise a contact',
    scopes: ALL,
    internalOnly: true,
    aiForbidden: true,
  },
  'opportunity.read': {
    module: 'crm',
    description: 'View opportunities and pipeline',
    scopes: ALL_OWN,
    internalOnly: true,
  },
  'opportunity.create': {
    module: 'crm',
    description: 'Create opportunities',
    scopes: ALL,
    internalOnly: true,
  },
  'opportunity.update': {
    module: 'crm',
    description: 'Edit opportunities and move stages',
    scopes: ALL_OWN,
    internalOnly: true,
  },
  'opportunity.close': {
    module: 'crm',
    description: 'Mark opportunities won or lost',
    scopes: ALL_OWN,
    internalOnly: true,
    aiForbidden: true,
  },
  'opportunity.reopen': {
    module: 'crm',
    description: 'Reopen won/lost opportunities',
    scopes: ALL,
    internalOnly: true,
    aiForbidden: true,
  },
  'activity.read': {
    module: 'crm',
    description: 'View activity timelines',
    scopes: ALL_OWN,
    internalOnly: true,
  },
  'activity.create': { module: 'crm', description: 'Log activities', scopes: ALL, internalOnly: true },
  'activity.update': { module: 'crm', description: 'Edit activities', scopes: ALL_OWN, internalOnly: true },

  // ── Briefs ────────────────────────────────────────────────────────────────
  'brief.read': {
    module: 'briefs',
    description: 'View briefs and inbound requests',
    scopes: ALL_OWN,
    internalOnly: true,
  },
  'brief.create': { module: 'briefs', description: 'Create briefs', scopes: ALL, internalOnly: true },
  'brief.update': { module: 'briefs', description: 'Edit draft briefs', scopes: ALL_OWN, internalOnly: true },
  'brief.confirm': {
    module: 'briefs',
    description: 'Confirm a brief (incl. AI drafts)',
    scopes: ALL_OWN,
    internalOnly: true,
    aiForbidden: true,
  },
  'brief.convert': {
    module: 'briefs',
    description: 'Convert a brief into a campaign',
    scopes: ALL_OWN,
    internalOnly: true,
    aiForbidden: true,
  },
  'brief.discard': { module: 'briefs', description: 'Discard a brief', scopes: ALL_OWN, internalOnly: true },

  // ── Campaigns ─────────────────────────────────────────────────────────────
  'campaign.read': { module: 'campaigns', description: 'View campaigns', scopes: ALL_ORG },
  'campaign.create': {
    module: 'campaigns',
    description: 'Create campaigns',
    scopes: ALL,
    internalOnly: true,
  },
  'campaign.update': {
    module: 'campaigns',
    description: 'Edit campaigns',
    scopes: ALL_OWN,
    internalOnly: true,
  },
  'campaign.cancel': {
    module: 'campaigns',
    description: 'Cancel campaigns',
    scopes: ALL_OWN,
    internalOnly: true,
    aiForbidden: true,
  },
  'campaign.export': { module: 'campaigns', description: 'Export campaign data', scopes: ALL_ORG },
  'campaign_location.read': { module: 'campaigns', description: 'View campaign locations', scopes: ALL_ORG },
  'campaign_location.manage': {
    module: 'campaigns',
    description: 'Create/edit campaign locations and change dates',
    scopes: ALL_OWN,
    internalOnly: true,
    aiForbidden: true,
  },

  // ── Inventory ─────────────────────────────────────────────────────────────
  'asset.read': { module: 'inventory', description: 'View OOH inventory', scopes: ALL_ASSIGNED_ORG },
  'asset.create': {
    module: 'inventory',
    description: 'Create assets (incl. map candidates)',
    scopes: ALL,
    internalOnly: true,
  },
  'asset.update': {
    module: 'inventory',
    description: 'Edit assets, mount positions and faces',
    scopes: ALL,
    internalOnly: true,
  },
  'asset.archive': {
    module: 'inventory',
    description: 'Archive or decommission assets',
    scopes: ALL,
    internalOnly: true,
    aiForbidden: true,
  },
  'asset.export': { module: 'inventory', description: 'Export inventory', scopes: ALL, internalOnly: true },
  'asset.terms.read': {
    module: 'inventory',
    description: 'View ownership, supplier and rent terms',
    scopes: ALL,
    internalOnly: true,
  },
  'asset.terms.manage': {
    module: 'inventory',
    description: 'Edit ownership, supplier and rent terms',
    scopes: ALL,
    internalOnly: true,
    aiForbidden: true,
  },
  'asset.verify': {
    module: 'inventory',
    description: 'Record physical field verification',
    scopes: ALL_ASSIGNED,
    aiForbidden: true,
  },
  'asset.availability.manage': {
    module: 'inventory',
    description: 'Block/unblock availability, activate or suspend assets',
    scopes: ALL,
    internalOnly: true,
    aiForbidden: true,
  },

  // ── Research & studies ────────────────────────────────────────────────────
  'research.read': {
    module: 'research',
    description: 'View research and candidate positions',
    scopes: ALL_OWN,
    internalOnly: true,
  },
  'research.manage': {
    module: 'research',
    description: 'Add, edit and select candidate positions',
    scopes: ALL_OWN,
    internalOnly: true,
  },
  'study.read': { module: 'research', description: 'View studies', scopes: ALL_ORG },
  'study.manage': {
    module: 'research',
    description: 'Build and edit studies',
    scopes: ALL_OWN,
    internalOnly: true,
  },
  'study.publish': {
    module: 'research',
    description: 'Approve a study internally and publish it to the client',
    scopes: ALL_OWN,
    internalOnly: true,
    aiForbidden: true,
  },
  'study.decide': {
    module: 'research',
    description: 'Approve or reject proposed positions (client/agency)',
    scopes: ['ORGANISATION'],
    aiForbidden: true,
  },
  'study.decide_on_behalf': {
    module: 'research',
    description: 'Record a client decision on the client’s behalf',
    scopes: ALL_OWN,
    internalOnly: true,
    aiForbidden: true,
  },
  'study.revoke_decision': {
    module: 'research',
    description: 'Revoke an approval before production is sent',
    scopes: ALL,
    internalOnly: true,
    aiForbidden: true,
  },

  // ── Production ────────────────────────────────────────────────────────────
  'production.read': { module: 'production', description: 'View production orders', scopes: ALL_ORG },
  'production.manage': {
    module: 'production',
    description: 'Edit production orders and artwork',
    scopes: ALL,
    internalOnly: true,
  },
  'production.send': {
    module: 'production',
    description: 'Send production orders to suppliers',
    scopes: ALL,
    internalOnly: true,
    aiForbidden: true,
  },
  'production.update_status': {
    module: 'production',
    description: 'Update production progress',
    scopes: ALL_ORG,
    aiForbidden: true,
  },
  'production.complete': {
    module: 'production',
    description: 'Mark production completed',
    scopes: ALL,
    internalOnly: true,
    aiForbidden: true,
  },

  // ── Field operations ──────────────────────────────────────────────────────
  'field_job.read': {
    module: 'field',
    description: 'View installation/maintenance/removal jobs',
    scopes: ALL_ASSIGNED,
  },
  'field_job.manage': {
    module: 'field',
    description: 'Create and edit field jobs',
    scopes: ALL,
    internalOnly: true,
  },
  'field_job.assign': {
    module: 'field',
    description: 'Assign jobs to decorators',
    scopes: ALL,
    internalOnly: true,
    aiForbidden: true,
  },
  'field_job.execute': {
    module: 'field',
    description: 'Work on and submit assigned jobs',
    scopes: ALL_ASSIGNED,
    aiForbidden: true,
  },
  'evidence.read': { module: 'field', description: 'View photo/video evidence', scopes: ANY },
  'evidence.upload': {
    module: 'field',
    description: 'Upload photo/video evidence',
    scopes: ALL_ASSIGNED,
    aiForbidden: true,
  },
  'evidence.review': {
    module: 'field',
    description: 'Accept or reject evidence',
    scopes: ALL,
    internalOnly: true,
    aiForbidden: true,
  },

  // ── Commercial ────────────────────────────────────────────────────────────
  'tariff.read': { module: 'commercial', description: 'View tariffs', scopes: ALL, internalOnly: true },
  'tariff.manage': {
    module: 'commercial',
    description: 'Create and edit draft tariffs',
    scopes: ALL,
    internalOnly: true,
  },
  'tariff.publish': {
    module: 'commercial',
    description: 'Publish, revise and retire tariffs',
    scopes: ALL,
    internalOnly: true,
    aiForbidden: true,
  },
  'commercial.cost.read': {
    module: 'commercial',
    description: 'View internal costs',
    scopes: ALL_OWN,
    internalOnly: true,
  },
  'commercial.revenue.read': {
    module: 'commercial',
    description: 'View revenue lines',
    scopes: ALL_OWN,
    internalOnly: true,
  },
  'commercial.margin.read': {
    module: 'commercial',
    description: 'View gross profit and margin',
    scopes: ALL_OWN,
    internalOnly: true,
  },
  'commercial.write': {
    module: 'commercial',
    description: 'Create, edit and override cost/revenue lines',
    scopes: ALL_OWN,
    internalOnly: true,
    aiForbidden: true,
  },
  'commercial.lock': {
    module: 'commercial',
    description: 'Lock lines and prepare billable items',
    scopes: ALL,
    internalOnly: true,
    aiForbidden: true,
  },

  // ── Work: tasks, calendar ────────────────────────────────────────────────
  'task.read': { module: 'work', description: 'View tasks', scopes: ALL_ASSIGNED },
  'task.create': { module: 'work', description: 'Create tasks', scopes: ALL, internalOnly: true },
  'task.update': { module: 'work', description: 'Update and complete tasks', scopes: ALL_ASSIGNED },
  'calendar.read': { module: 'work', description: 'View the operational calendar', scopes: ALL_ASSIGNED },

  // ── Reporting ─────────────────────────────────────────────────────────────
  'dashboard.read': {
    module: 'reporting',
    description: 'View the operations dashboard',
    scopes: ALL,
    internalOnly: true,
  },
  'report.read': { module: 'reporting', description: 'View reports', scopes: ALL_ORG },
  'report.export': { module: 'reporting', description: 'Export reports', scopes: ALL_ORG },

  // ── Cross-cutting ─────────────────────────────────────────────────────────
  'file.read': { module: 'files', description: 'Download files linked to visible records', scopes: ANY },
  'file.upload': { module: 'files', description: 'Upload files', scopes: ALL_ASSIGNED },
  'comment.read': {
    module: 'collab',
    description: 'Read external (client-visible) comments',
    scopes: ALL_ORG,
  },
  'comment.create': { module: 'collab', description: 'Write comments', scopes: ALL_ORG },
  'comment.internal': {
    module: 'collab',
    description: 'Read and write internal-only comments',
    scopes: ALL,
    internalOnly: true,
  },
  'ai.assistant.use': { module: 'ai', description: 'Use the AI assistant', scopes: ALL, internalOnly: true },
  'ai.suggestion.resolve': {
    module: 'ai',
    description: 'Accept or reject AI suggestions',
    scopes: ALL,
    internalOnly: true,
    aiForbidden: true,
  },
} as const satisfies Record<string, PermissionDefinition>;

export type PermissionKey = keyof typeof PERMISSIONS;

export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as PermissionKey[];

export function isPermissionKey(value: string): value is PermissionKey {
  return Object.prototype.hasOwnProperty.call(PERMISSIONS, value);
}

/** Permissions the AI principal can never hold, whatever the role configuration says [R§39]. */
export const AI_FORBIDDEN_PERMISSIONS: readonly PermissionKey[] = PERMISSION_KEYS.filter(
  (key) => (PERMISSIONS[key] as PermissionDefinition).aiForbidden === true,
);

export interface PermissionGrant {
  readonly permission: PermissionKey;
  readonly scope: PermissionScope;
}

export interface GrantViolation {
  readonly permission: string;
  readonly reason: 'UNKNOWN_PERMISSION' | 'SCOPE_NOT_ALLOWED' | 'INTERNAL_ONLY' | 'DUPLICATE';
}

/**
 * Validates grants for a role. Used by role templates (tests) and, later, by the roles API
 * so a Company Admin can't configure an invalid or unsafe role.
 */
export function validateGrants(
  grants: readonly { permission: string; scope: string }[],
  options: { external: boolean },
): GrantViolation[] {
  const violations: GrantViolation[] = [];
  const seen = new Set<string>();
  for (const grant of grants) {
    if (seen.has(grant.permission)) {
      violations.push({ permission: grant.permission, reason: 'DUPLICATE' });
      continue;
    }
    seen.add(grant.permission);
    if (!isPermissionKey(grant.permission)) {
      violations.push({ permission: grant.permission, reason: 'UNKNOWN_PERMISSION' });
      continue;
    }
    const definition: PermissionDefinition = PERMISSIONS[grant.permission];
    if (!(definition.scopes as readonly string[]).includes(grant.scope)) {
      violations.push({ permission: grant.permission, reason: 'SCOPE_NOT_ALLOWED' });
    }
    if (options.external && definition.internalOnly) {
      violations.push({ permission: grant.permission, reason: 'INTERNAL_ONLY' });
    }
  }
  return violations;
}
