import { Injectable } from '@nestjs/common';
import type {
  CreateTaskRequest,
  TaskAssigneeCandidate,
  Page,
  TaskAction,
  TaskItem,
  TaskListQuery,
  TaskStatus,
  TaskSubjectType,
  UpdateTaskRequest,
} from '@ooh/contracts';
import {
  appUser,
  membership,
  membershipRole,
  opportunity,
  organisation,
  role,
  rolePermission,
  task,
  type Transaction,
} from '@ooh/db';
import { and, asc, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { AuditService } from '../../core/audit/audit.service';
import { type Principal } from '../../core/auth/principal';
import { DatabaseService } from '../../core/database/database.service';
import { AppError } from '../../core/http/app-error';
import { type ClientInfo } from '../../core/http/client-info';
import { assertIfMatch, type IfMatch } from '../../core/http/concurrency';
import { decodeKeysetCursor, encodeKeysetCursor } from '../../core/http/cursor';

type Row = typeof task.$inferSelect;
type Changes = Record<string, { from: unknown; to: unknown }>;

const OPEN_STATUSES: TaskStatus[] = ['OPEN', 'IN_PROGRESS'];
const CLOSED_STATUSES: TaskStatus[] = ['DONE', 'CANCELLED'];

/** Allowed transitions (10-api.md: actions start, complete, cancel, reopen). */
export const TASK_TRANSITIONS: Record<TaskAction, { from: TaskStatus[]; to: TaskStatus; audit: string }> = {
  start: { from: ['OPEN'], to: 'IN_PROGRESS', audit: 'task.started' },
  complete: { from: OPEN_STATUSES, to: 'DONE', audit: 'task.completed' },
  cancel: { from: OPEN_STATUSES, to: 'CANCELLED', audit: 'task.cancelled' },
  reopen: { from: CLOSED_STATUSES, to: 'OPEN', audit: 'task.reopened' },
};

/** Undated tasks sort last; the key is PostgreSQL's text so the cursor keeps µs precision. */
const SORT = sql<string>`coalesce(${task.dueAt}, 'infinity'::timestamptz)`;

const notFound = () => new AppError('NOT_FOUND', 'Task not found.');

export interface SystemTask {
  dedupeKey: string;
  title: string;
  notes?: string;
  organisationId: string;
  subject: { type: TaskSubjectType; id: string };
  assigneeMembershipId: string | null;
  dueAt?: Date;
}

/**
 * Tasks core (05-domain-model.md §work). ASSIGNED scope = the assignee: such members see and change
 * only their own tasks and cannot hand them to someone else. Tasks are cancelled, never deleted.
 */
@Injectable()
export class TasksService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  list(principal: Principal, query: TaskListQuery): Promise<Page<TaskItem>> {
    const after = query.cursor ? decodeKeysetCursor(query.cursor) : undefined;
    const statuses =
      query.state === 'open' ? OPEN_STATUSES : query.state === 'closed' ? CLOSED_STATUSES : undefined;
    const assignee =
      query.assignee === undefined
        ? undefined
        : query.assignee === 'unassigned'
          ? isNull(task.assigneeMembershipId)
          : eq(task.assigneeMembershipId, query.assignee === 'me' ? principal.membershipId : query.assignee);
    return this.inTenant(principal, async (tx) => {
      const rows = await this.loadItems(
        tx,
        and(
          this.readScope(principal),
          statuses ? inArray(task.status, statuses) : undefined,
          assignee,
          query.organisationId ? eq(task.organisationId, query.organisationId) : undefined,
          query.opportunityId
            ? and(eq(task.subjectType, 'opportunity'), eq(task.subjectId, query.opportunityId))
            : undefined,
          after ? sql`(${SORT}, ${task.id}) > (${after.sortKey}::timestamptz, ${after.id}::uuid)` : undefined,
        ),
        query.limit + 1,
      );
      const hasMore = rows.length > query.limit;
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        data: page.map((r) => r.item),
        page: {
          nextCursor: hasMore && last ? encodeKeysetCursor(last.sortKey, last.item.id) : null,
          hasMore,
        },
      };
    });
  }

  /** People a task can be given to: active members whose roles let them see tasks. */
  assignees(principal: Principal): Promise<TaskAssigneeCandidate[]> {
    return this.inTenant(principal, (tx) => assigneeCandidates(tx));
  }

  get(principal: Principal, id: string): Promise<TaskItem> {
    return this.inTenant(principal, (tx) => this.loadItem(tx, principal, id));
  }

  create(principal: Principal, input: CreateTaskRequest, client: ClientInfo): Promise<TaskItem> {
    return this.inTenant(principal, async (tx) => {
      const subject = await this.resolveSubject(tx, principal, input);
      const assigneeMembershipId =
        input.assigneeMembershipId === undefined ? principal.membershipId : input.assigneeMembershipId;
      if (assigneeMembershipId) await assertAssignee(tx, assigneeMembershipId);
      const [created] = await tx
        .insert(task)
        .values({
          tenantId: principal.tenantId,
          title: input.title,
          notes: input.notes ?? null,
          priority: input.priority,
          dueAt: input.dueAt ? new Date(input.dueAt) : null,
          assigneeMembershipId,
          organisationId: subject?.organisationId ?? null,
          subjectType: subject?.type ?? null,
          subjectId: subject?.id ?? null,
          createdByMembershipId: principal.membershipId,
        })
        .returning({ id: task.id });
      await this.audit.record(tx, {
        ...actor(principal, client),
        action: 'task.created',
        subjectType: 'task',
        subjectId: created!.id,
        metadata: {
          title: input.title,
          ...(subject ? { subject: { type: subject.type, id: subject.id } } : {}),
        },
      });
      return this.loadItem(tx, principal, created!.id);
    });
  }

  /** Edits an open task; a closed one must be reopened first. */
  update(
    principal: Principal,
    id: string,
    input: UpdateTaskRequest,
    ifMatch: IfMatch,
    client: ClientInfo,
  ): Promise<TaskItem> {
    return this.inTenant(principal, async (tx) => {
      const current = await this.lock(tx, principal, id);
      if (CLOSED_STATUSES.includes(current.status)) {
        throw new AppError('INVALID_TRANSITION', 'This task is closed. Reopen it to change it.');
      }
      if (
        input.assigneeMembershipId !== undefined &&
        input.assigneeMembershipId !== current.assigneeMembershipId
      ) {
        if (principal.permissions.get('task.update') === 'ASSIGNED') {
          throw new AppError('FORBIDDEN', 'You can change your tasks but not hand them to someone else.');
        }
        if (input.assigneeMembershipId) await assertAssignee(tx, input.assigneeMembershipId);
      }
      assertIfMatch(ifMatch, current.version);

      const next = {
        title: input.title,
        notes: input.notes,
        priority: input.priority,
        assigneeMembershipId: input.assigneeMembershipId,
        dueAt: input.dueAt === undefined ? undefined : input.dueAt === null ? null : new Date(input.dueAt),
      };
      const changes: Changes = {};
      for (const [field, value] of Object.entries(next) as [keyof typeof next, unknown][]) {
        if (value === undefined) continue;
        const before = current[field];
        const same =
          value instanceof Date && before instanceof Date
            ? value.getTime() === before.getTime()
            : value === before;
        if (!same) changes[field] = { from: before, to: value };
      }
      if (Object.keys(changes).length === 0) return this.loadItem(tx, principal, id);

      await tx
        .update(task)
        .set({
          ...Object.fromEntries(
            Object.keys(changes).map((field) => [field, next[field as keyof typeof next]]),
          ),
          version: sql`${task.version} + 1`,
        })
        .where(eq(task.id, id));
      await this.audit.record(tx, {
        ...actor(principal, client),
        action: 'task.updated',
        subjectType: 'task',
        subjectId: id,
        changes,
      });
      return this.loadItem(tx, principal, id);
    });
  }

  transition(
    principal: Principal,
    id: string,
    action: TaskAction,
    ifMatch: IfMatch,
    client: ClientInfo,
  ): Promise<TaskItem> {
    const rule = TASK_TRANSITIONS[action];
    return this.inTenant(principal, async (tx) => {
      const current = await this.lock(tx, principal, id);
      if (!rule.from.includes(current.status)) {
        throw new AppError(
          'INVALID_TRANSITION',
          `A ${current.status.toLowerCase().replace('_', ' ')} task can't ${action}.`,
        );
      }
      assertIfMatch(ifMatch, current.version);
      await tx
        .update(task)
        .set({
          status: rule.to,
          completedAt: rule.to === 'DONE' ? new Date() : null,
          version: sql`${task.version} + 1`,
        })
        .where(eq(task.id, id));
      await this.audit.record(tx, {
        ...actor(principal, client),
        action: rule.audit,
        subjectType: 'task',
        subjectId: id,
        changes: { status: { from: current.status, to: rule.to } },
      });
      return this.loadItem(tx, principal, id);
    });
  }

  /**
   * A platform task inside the caller's transaction, at most once per dedupe key (a re-won
   * opportunity doesn't get a second "Create brief"). Returns the new task id, or null if it existed.
   */
  async createSystemTask(
    tx: Transaction,
    principal: Principal,
    client: ClientInfo,
    input: SystemTask,
  ): Promise<string | null> {
    const [created] = await tx
      .insert(task)
      .values({
        tenantId: principal.tenantId,
        title: input.title,
        notes: input.notes ?? null,
        source: 'SYSTEM',
        dedupeKey: input.dedupeKey,
        organisationId: input.organisationId,
        subjectType: input.subject.type,
        subjectId: input.subject.id,
        assigneeMembershipId: input.assigneeMembershipId,
        dueAt: input.dueAt ?? null,
        createdByMembershipId: principal.membershipId,
      })
      .onConflictDoNothing({ target: [task.tenantId, task.dedupeKey], where: sql`dedupe_key IS NOT NULL` })
      .returning({ id: task.id });
    if (!created) return null;
    await this.audit.record(tx, {
      ...actor(principal, client),
      action: 'task.created',
      subjectType: 'task',
      subjectId: created.id,
      metadata: { title: input.title, source: 'SYSTEM', dedupeKey: input.dedupeKey },
    });
    return created.id;
  }

  /**
   * Completes the platform task with this dedupe key when it is still open (e.g. "Create brief" once
   * the brief exists). Returns whether a task was completed.
   */
  async completeSystemTask(
    tx: Transaction,
    principal: Principal,
    client: ClientInfo,
    dedupeKey: string,
  ): Promise<boolean> {
    const [done] = await tx
      .update(task)
      .set({ status: 'DONE', completedAt: new Date(), version: sql`${task.version} + 1` })
      .where(and(eq(task.dedupeKey, dedupeKey), inArray(task.status, OPEN_STATUSES)))
      .returning({ id: task.id, status: task.status });
    if (!done) return false;
    await this.audit.record(tx, {
      ...actor(principal, client),
      action: 'task.completed',
      subjectType: 'task',
      subjectId: done.id,
      metadata: { automatic: true, dedupeKey },
    });
    return true;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private inTenant<T>(principal: Principal, fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.database.withTenant({ tenantId: principal.tenantId, actorUserId: principal.userId }, fn);
  }

  private readScope(principal: Principal): SQL | undefined {
    return principal.permissions.get('task.read') === 'ASSIGNED'
      ? eq(task.assigneeMembershipId, principal.membershipId)
      : undefined;
  }

  /** Outside the read scope a task doesn't exist (404); readable but not changeable is a 403. */
  private async lock(tx: Transaction, principal: Principal, id: string): Promise<Row> {
    const [row] = await tx
      .select()
      .from(task)
      .where(and(eq(task.id, id), this.readScope(principal)))
      .for('update');
    if (!row) throw notFound();
    if (
      principal.permissions.get('task.update') === 'ASSIGNED' &&
      row.assigneeMembershipId !== principal.membershipId
    ) {
      throw new AppError('FORBIDDEN', 'You can only change tasks assigned to you.');
    }
    return row;
  }

  /** The opportunity (its company implied) or the company the task is about, within read scopes. */
  private async resolveSubject(
    tx: Transaction,
    principal: Principal,
    input: CreateTaskRequest,
  ): Promise<{ type: TaskSubjectType; id: string; organisationId: string } | null> {
    if (input.opportunityId) {
      const [deal] = principal.permissions.has('opportunity.read')
        ? await tx
            .select({ organisationId: opportunity.organisationId })
            .from(opportunity)
            .where(
              and(
                eq(opportunity.id, input.opportunityId),
                isNull(opportunity.archivedAt),
                principal.permissions.get('opportunity.read') === 'OWN'
                  ? eq(opportunity.ownerMembershipId, principal.membershipId)
                  : undefined,
              ),
            )
        : [];
      if (!deal) throw invalid('opportunityId', 'Unknown opportunity');
      return { type: 'opportunity', id: input.opportunityId, organisationId: deal.organisationId };
    }
    if (input.organisationId) {
      const [company] = principal.permissions.has('organisation.read')
        ? await tx
            .select({ archivedAt: organisation.archivedAt })
            .from(organisation)
            .where(
              and(
                eq(organisation.id, input.organisationId),
                principal.permissions.get('organisation.read') === 'OWN'
                  ? eq(organisation.accountOwnerMembershipId, principal.membershipId)
                  : undefined,
              ),
            )
        : [];
      if (!company) throw invalid('organisationId', 'Unknown company');
      if (company.archivedAt) throw new AppError('INVALID_TRANSITION', 'This company is archived.');
      return { type: 'organisation', id: input.organisationId, organisationId: input.organisationId };
    }
    return null;
  }

  private async loadItem(tx: Transaction, principal: Principal, id: string): Promise<TaskItem> {
    const [row] = await this.loadItems(tx, and(eq(task.id, id), this.readScope(principal)), 1);
    if (!row) throw notFound();
    return row.item;
  }

  private async loadItems(
    tx: Transaction,
    where: SQL | undefined,
    limit: number,
  ): Promise<{ sortKey: string; item: TaskItem }[]> {
    const assigneeMember = alias(membership, 'assignee_member');
    const assigneeUser = alias(appUser, 'assignee_user');
    const creatorMember = alias(membership, 'creator_member');
    const creatorUser = alias(appUser, 'creator_user');
    const rows = await tx
      .select({
        task,
        sortKey: sql<string>`${SORT}::text`,
        assigneeName: assigneeUser.displayName,
        creatorName: creatorUser.displayName,
        organisationName: organisation.displayName,
        opportunityName: opportunity.name,
      })
      .from(task)
      .leftJoin(assigneeMember, eq(assigneeMember.id, task.assigneeMembershipId))
      .leftJoin(assigneeUser, eq(assigneeUser.id, assigneeMember.userId))
      .leftJoin(creatorMember, eq(creatorMember.id, task.createdByMembershipId))
      .leftJoin(creatorUser, eq(creatorUser.id, creatorMember.userId))
      .leftJoin(organisation, eq(organisation.id, task.organisationId))
      .leftJoin(opportunity, and(eq(task.subjectType, 'opportunity'), eq(opportunity.id, task.subjectId)))
      .where(where)
      .orderBy(asc(SORT), asc(task.id))
      .limit(limit);
    return rows.map((r) => ({
      sortKey: r.sortKey,
      item: {
        id: r.task.id,
        title: r.task.title,
        notes: r.task.notes,
        status: r.task.status,
        priority: r.task.priority,
        source: r.task.source,
        dueAt: r.task.dueAt?.toISOString() ?? null,
        completedAt: r.task.completedAt?.toISOString() ?? null,
        assignee: r.task.assigneeMembershipId
          ? { membershipId: r.task.assigneeMembershipId, displayName: r.assigneeName ?? '' }
          : null,
        organisation:
          r.task.organisationId && r.organisationName
            ? { id: r.task.organisationId, displayName: r.organisationName }
            : null,
        subject:
          r.task.subjectType && r.task.subjectId
            ? {
                type: r.task.subjectType as TaskSubjectType,
                id: r.task.subjectId,
                name: (r.task.subjectType === 'opportunity' ? r.opportunityName : r.organisationName) ?? '',
              }
            : null,
        createdBy: r.task.createdByMembershipId
          ? { membershipId: r.task.createdByMembershipId, displayName: r.creatorName ?? '' }
          : null,
        createdAt: r.task.createdAt.toISOString(),
        version: r.task.version,
      },
    }));
  }
}

/** Active members holding task.read through an active role (anyone else could never see the task). */
function assigneeCandidates(tx: Transaction, membershipId?: string): Promise<TaskAssigneeCandidate[]> {
  return tx
    .selectDistinct({
      membershipId: membership.id,
      displayName: appUser.displayName,
      kind: membership.kind,
    })
    .from(membership)
    .innerJoin(appUser, eq(appUser.id, membership.userId))
    .innerJoin(membershipRole, eq(membershipRole.membershipId, membership.id))
    .innerJoin(role, and(eq(role.id, membershipRole.roleId), eq(role.active, true)))
    .innerJoin(
      rolePermission,
      and(eq(rolePermission.roleId, role.id), eq(rolePermission.permissionKey, 'task.read')),
    )
    .where(and(eq(membership.status, 'ACTIVE'), membershipId ? eq(membership.id, membershipId) : undefined))
    .orderBy(asc(appUser.displayName));
}

async function assertAssignee(tx: Transaction, membershipId: string): Promise<void> {
  const [candidate] = await assigneeCandidates(tx, membershipId);
  if (!candidate) throw invalid('assigneeMembershipId', 'Not an active member who can see tasks');
}

function invalid(path: string, message: string): AppError {
  return new AppError('VALIDATION_FAILED', `${message}.`, { errors: [{ path, message }] });
}

function actor(principal: Principal, client: ClientInfo) {
  return {
    tenantId: principal.tenantId,
    actorType: 'USER' as const,
    actorUserId: principal.userId,
    actorMembershipId: principal.membershipId,
    client,
  };
}
