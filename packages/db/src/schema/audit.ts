/**
 * Audit trail [R§40]. The table is created by a HAND-WRITTEN migration because it is
 * range-partitioned by month, which drizzle-kit can't express. This file is intentionally NOT
 * listed in drizzle.config.ts; it only gives the application a typed handle for inserts/queries.
 *
 * Rules (enforced in the DB): the app role may INSERT and SELECT only (no UPDATE/DELETE);
 * rows are tenant-isolated by RLS; tenant_id may be NULL for pre-tenant events such as login.
 */
import { sql } from 'drizzle-orm';
import { inet, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const actorType = pgEnum('actor_type', ['USER', 'SYSTEM', 'AI', 'API']);

export const auditEvent = pgTable(
  'audit_event',
  {
    id: uuid('id')
      .notNull()
      .default(sql`uuidv7()`),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    tenantId: uuid('tenant_id'),
    actorType: actorType('actor_type').notNull(),
    actorUserId: uuid('actor_user_id'),
    actorMembershipId: uuid('actor_membership_id'),
    /** Dotted verb, e.g. `auth.login`, `client_decision.recorded`, `tariff.published`. */
    action: text('action').notNull(),
    subjectType: text('subject_type'),
    subjectId: uuid('subject_id'),
    /** Changed fields only: `{ field: { from, to } }`. */
    changes: jsonb('changes').$type<Record<string, { from: unknown; to: unknown }>>(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    requestId: text('request_id'),
    ip: inet('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [primaryKey({ name: 'audit_event_pk', columns: [t.id, t.occurredAt] })],
);
