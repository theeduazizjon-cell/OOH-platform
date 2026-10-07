/**
 * Work (docs/architecture/05-domain-model.md §work): the task core. A task's subject is polymorphic
 * (no FK, allowed for tasks by §3 "Polymorphism policy"), but its company is a real composite FK so
 * tasks show on the Company 360° and can never point at another tenant's company.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { primaryId, tenantIdColumn, timestamps, versionColumn } from './columns';
import { campaign } from './briefs';
import { organisation } from './crm';
import { membership, tenant } from './identity';

export const taskStatus = pgEnum('task_status', ['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED']);
export const taskPriority = pgEnum('task_priority', ['LOW', 'NORMAL', 'HIGH']);
export const taskSource = pgEnum('task_source', ['USER', 'SYSTEM']);

export const task = pgTable(
  'task',
  {
    id: primaryId(),
    tenantId: tenantIdColumn().references(() => tenant.id),
    title: text('title').notNull(),
    notes: text('notes'),
    status: taskStatus('status').notNull().default('OPEN'),
    priority: taskPriority('priority').notNull().default('NORMAL'),
    source: taskSource('source').notNull().default('USER'),
    /** 'organisation' | 'opportunity' | 'campaign' | 'campaign_location' (jobs… later). */
    subjectType: text('subject_type'),
    subjectId: uuid('subject_id'),
    organisationId: uuid('organisation_id'),
    /** Denormalised so the task shows on its campaign (05-domain-model §work). */
    campaignId: uuid('campaign_id'),
    /** Drives the ASSIGNED permission scope; null = not assigned yet. */
    assigneeMembershipId: uuid('assignee_membership_id'),
    dueAt: timestamp('due_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    /** Platform tasks are created at most once per key (e.g. `opportunity.won:<id>`). */
    dedupeKey: text('dedupe_key'),
    createdByMembershipId: uuid('created_by_membership_id'),
    ...timestamps(),
    version: versionColumn(),
  },
  (t) => [
    unique('task_tenant_id_id_uq').on(t.tenantId, t.id),
    uniqueIndex('task_dedupe_key_uq')
      .on(t.tenantId, t.dedupeKey)
      .where(sql`${t.dedupeKey} IS NOT NULL`),
    foreignKey({
      name: 'task_organisation_fk',
      columns: [t.tenantId, t.organisationId],
      foreignColumns: [organisation.tenantId, organisation.id],
    }),
    foreignKey({
      name: 'task_campaign_fk',
      columns: [t.tenantId, t.campaignId],
      foreignColumns: [campaign.tenantId, campaign.id],
    }),
    foreignKey({
      name: 'task_assignee_fk',
      columns: [t.tenantId, t.assigneeMembershipId],
      foreignColumns: [membership.tenantId, membership.id],
    }),
    foreignKey({
      name: 'task_created_by_fk',
      columns: [t.tenantId, t.createdByMembershipId],
      foreignColumns: [membership.tenantId, membership.id],
    }),
    index('task_assignee_idx').on(t.tenantId, t.assigneeMembershipId, t.status),
    index('task_organisation_idx').on(t.tenantId, t.organisationId),
    index('task_campaign_idx').on(t.tenantId, t.campaignId),
    index('task_subject_idx').on(t.tenantId, t.subjectType, t.subjectId),
    check('task_title_ck', sql`length(btrim(${t.title})) > 0`),
    check(
      'task_subject_ck',
      sql`(${t.subjectType} IS NULL) = (${t.subjectId} IS NULL) AND (${t.subjectType} IS NULL OR ${t.subjectType} IN ('organisation', 'opportunity', 'campaign', 'campaign_location'))`,
    ),
    // A subject always comes with its company (so the task shows on the Company 360°).
    check('task_subject_company_ck', sql`${t.subjectType} IS NULL OR ${t.organisationId} IS NOT NULL`),
    check(
      'task_subject_campaign_ck',
      sql`${t.subjectType} NOT IN ('campaign', 'campaign_location') OR ${t.campaignId} IS NOT NULL`,
    ),
    check('task_completed_ck', sql`(${t.status} = 'DONE') = (${t.completedAt} IS NOT NULL)`),
  ],
);
