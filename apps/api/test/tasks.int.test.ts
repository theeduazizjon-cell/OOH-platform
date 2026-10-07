/**
 * Tasks core end to end (M2d): create about a company or an opportunity, the status machine
 * (start / complete / cancel / reopen), If-Match, ASSIGNED scope, audit, tenant isolation, and the
 * platform's "Create brief" task when an opportunity is won (06-state-machines.md §2).
 */
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type AuthSession,
  etagOf,
  type OpportunityDetail,
  type OrganisationDetail,
  type Page,
  type TaskAssigneeCandidate,
  type TaskItem,
} from '@ooh/contracts';
import {
  appUser,
  auditEvent,
  createDatabase,
  type DatabaseConnection,
  membership,
  membershipRole,
  provisionTenant,
  role,
  task,
} from '@ooh/db';
import { and, eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PasswordService } from '../src/core/auth/password.service';
import { createTestApp, drainOutbox } from './support';

const PASSWORD = 'correct horse battery staple';
const suffix = Date.now().toString(36);
const email = (name: string) => `${name}-${suffix}@example.com`;

type UserName = 'admin' | 'sales1' | 'sales2' | 'decorator' | 'client' | 'adminB';
const members = {} as Record<UserName, string>;
const tokens = {} as Record<UserName, string>;

let app: NestFastifyApplication;
let owner: DatabaseConnection;
let company: OrganisationDetail;
let foreignCompany: OrganisationDetail;

beforeAll(async () => {
  owner = createDatabase(inject('ownerUrl'), { max: 2 });
  const { tenantId: tenantA } = await provisionTenant(owner.db, {
    name: 'Tasks Alpha',
    slug: `tka-${suffix}`,
  });
  const { tenantId: tenantB } = await provisionTenant(owner.db, {
    name: 'Tasks Beta',
    slug: `tkb-${suffix}`,
  });
  const passwordHash = await new PasswordService().hash(PASSWORD);
  const add = async (
    tenantId: string,
    name: UserName,
    roleKey: string,
    extra: Partial<typeof membership.$inferInsert> = {},
  ) => {
    const [u] = await owner.db
      .insert(appUser)
      .values({ email: email(name), displayName: name, passwordHash })
      .returning({ id: appUser.id });
    const [m] = await owner.db
      .insert(membership)
      .values({ tenantId, userId: u!.id, status: 'ACTIVE', ...extra })
      .returning({ id: membership.id });
    const [r] = await owner.db
      .select({ id: role.id })
      .from(role)
      .where(and(eq(role.tenantId, tenantId), eq(role.key, roleKey)));
    await owner.db.insert(membershipRole).values({ tenantId, membershipId: m!.id, roleId: r!.id });
    members[name] = m!.id;
  };
  await add(tenantA, 'admin', 'company_admin');
  await add(tenantA, 'sales1', 'sales');
  await add(tenantA, 'sales2', 'sales');
  await add(tenantB, 'adminB', 'company_admin');

  app = await createTestApp();
  const login = async (name: UserName) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: email(name), password: PASSWORD },
    });
    tokens[name] = response.json<AuthSession>().accessToken;
  };
  for (const name of ['admin', 'sales1', 'sales2', 'adminB'] as const) await login(name);
  company = (await send('admin', 'POST', '/organisations', { displayName: `Task Client ${suffix}` })).json();
  foreignCompany = (
    await send('adminB', 'POST', '/organisations', { displayName: `Other ${suffix}` })
  ).json();
  // An installation team member: external, sees only tasks assigned to them.
  await add(tenantA, 'decorator', 'decorator', { kind: 'EXTERNAL', organisationId: company.id });
  // A client contact on the portal: a member, but tasks are not for them.
  await add(tenantA, 'client', 'end_client', { kind: 'EXTERNAL', organisationId: company.id });
  await login('decorator');
});

afterAll(async () => {
  await app?.close();
  await owner?.close();
});

// ── helpers ──────────────────────────────────────────────────────────────────

function send(
  who: UserName,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  payload?: object,
  version?: number,
) {
  return app.inject({
    method,
    url: `/api/v1${path}`,
    headers: {
      authorization: `Bearer ${tokens[who]}`,
      ...(version === undefined ? {} : { 'if-match': etagOf(version) }),
    },
    ...(payload ? { payload } : {}),
  });
}
const code = (response: LightMyRequestResponse) => response.json<{ code: string }>().code;
const createTask = (who: UserName, payload: object) => send(who, 'POST', '/tasks', payload);
const act = (who: UserName, t: TaskItem, action: string) =>
  send(who, 'POST', `/tasks/${t.id}/actions/${action}`, undefined, t.version);
const list = async (who: UserName, query = '') =>
  (await send(who, 'GET', `/tasks${query}`)).json<Page<TaskItem>>();

// ── tests ────────────────────────────────────────────────────────────────────

describe('tasks', () => {
  it('creates a task about a company, assigned to the creator by default', async () => {
    const response = await createTask('sales1', {
      title: '  Call about the spring campaign ',
      organisationId: company.id,
      dueAt: '2026-10-10T09:00:00Z',
      priority: 'HIGH',
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers.etag).toBe(etagOf(1));
    expect(response.json<TaskItem>()).toMatchObject({
      title: 'Call about the spring campaign',
      status: 'OPEN',
      priority: 'HIGH',
      source: 'USER',
      dueAt: '2026-10-10T09:00:00.000Z',
      assignee: { membershipId: members.sales1, displayName: 'sales1' },
      organisation: { id: company.id },
      subject: { type: 'organisation', id: company.id, name: company.displayName },
      createdBy: { membershipId: members.sales1 },
    });
  });

  it('offers as assignees only active members who can see tasks', async () => {
    const response = await send('sales1', 'GET', '/tasks/assignees');
    expect(response.statusCode).toBe(200);
    const ids = response.json<TaskAssigneeCandidate[]>().map((c) => c.membershipId);
    expect(ids).toEqual(
      expect.arrayContaining([members.admin, members.sales1, members.sales2, members.decorator]),
    );
    expect(ids).not.toContain(members.client);
    expect(ids).not.toContain(members.adminB);
    expect(code(await createTask('sales1', { title: 'X', assigneeMembershipId: members.client }))).toBe(
      'VALIDATION_FAILED',
    );
    expect((await send('decorator', 'GET', '/tasks/assignees')).statusCode).toBe(403);
  });

  it('validates the subject and the assignee', async () => {
    expect(code(await createTask('sales1', { title: 'X', organisationId: foreignCompany.id }))).toBe(
      'VALIDATION_FAILED',
    );
    expect(code(await createTask('sales1', { title: 'X', opportunityId: crypto.randomUUID() }))).toBe(
      'VALIDATION_FAILED',
    );
    expect(code(await createTask('sales1', { title: 'X', assigneeMembershipId: members.adminB }))).toBe(
      'VALIDATION_FAILED',
    );
    expect(
      (await createTask('sales1', { title: 'X', organisationId: company.id, opportunityId: company.id }))
        .statusCode,
    ).toBe(422);
    expect((await createTask('decorator', { title: 'X' })).statusCode).toBe(403);
  });

  it('runs the status machine with If-Match and audits every step', async () => {
    let t = (await createTask('sales1', { title: `Machine ${suffix}` })).json<TaskItem>();
    expect((await send('sales1', 'POST', `/tasks/${t.id}/actions/start`)).statusCode).toBe(428);
    expect((await send('sales1', 'POST', `/tasks/${t.id}/actions/explode`, undefined, 1)).statusCode).toBe(
      404,
    );
    expect(code(await act('sales1', t, 'reopen'))).toBe('INVALID_TRANSITION');

    t = (await act('sales1', t, 'start')).json<TaskItem>();
    expect(t.status).toBe('IN_PROGRESS');
    expect((await act('sales1', { ...t, version: t.version - 1 }, 'complete')).statusCode).toBe(412);
    t = (await act('sales1', t, 'complete')).json<TaskItem>();
    expect(t.status).toBe('DONE');
    expect(t.completedAt).toEqual(expect.any(String));

    // Closed tasks are read-only until reopened.
    expect(code(await send('sales1', 'PATCH', `/tasks/${t.id}`, { title: 'New' }, t.version))).toBe(
      'INVALID_TRANSITION',
    );
    t = (await act('sales1', t, 'reopen')).json<TaskItem>();
    expect(t).toMatchObject({ status: 'OPEN', completedAt: null });
    t = (await act('sales1', t, 'cancel')).json<TaskItem>();
    expect(t.status).toBe('CANCELLED');

    const actions = await owner.db
      .select({ action: auditEvent.action })
      .from(auditEvent)
      .where(eq(auditEvent.subjectId, t.id));
    expect(actions.map((a) => a.action).sort()).toEqual(
      ['task.cancelled', 'task.completed', 'task.created', 'task.reopened', 'task.started'].sort(),
    );
  });

  it('edits open tasks and records the changed fields', async () => {
    const t = (await createTask('sales1', { title: `Edit ${suffix}` })).json<TaskItem>();
    const edited = await send(
      'sales1',
      'PATCH',
      `/tasks/${t.id}`,
      { title: 'Edited', dueAt: '2026-11-01T08:00:00Z', assigneeMembershipId: members.sales2, notes: 'n' },
      t.version,
    );
    expect(edited.statusCode).toBe(200);
    expect(edited.json<TaskItem>()).toMatchObject({
      title: 'Edited',
      notes: 'n',
      dueAt: '2026-11-01T08:00:00.000Z',
      assignee: { membershipId: members.sales2 },
      version: 2,
    });
    const [audit] = await owner.db
      .select({ changes: auditEvent.changes })
      .from(auditEvent)
      .where(and(eq(auditEvent.action, 'task.updated'), eq(auditEvent.subjectId, t.id)));
    expect(Object.keys(audit!.changes as object).sort()).toEqual([
      'assigneeMembershipId',
      'dueAt',
      'notes',
      'title',
    ]);
  });

  it('lists open tasks by due date (undated last) and pages without gaps', async () => {
    const mine = `Order ${suffix}`;
    for (const [i, due] of [
      null,
      '2026-12-03T00:00:00Z',
      '2026-12-01T00:00:00Z',
      '2026-12-02T00:00:00Z',
    ].entries())
      await createTask('sales2', { title: `${mine} ${i}`, ...(due ? { dueAt: due } : {}) });
    const seen: TaskItem[] = [];
    let cursor: string | null = null;
    do {
      const page: Page<TaskItem> = await list(
        'sales2',
        `?assignee=me&limit=2${cursor ? `&cursor=${cursor}` : ''}`,
      );
      seen.push(...page.data);
      cursor = page.page.nextCursor;
    } while (cursor);
    const ordered = seen.filter((t) => t.title.startsWith(mine)).map((t) => t.title.slice(-1));
    expect(ordered).toEqual(['2', '3', '1', '0']);
    expect(new Set(seen.map((t) => t.id)).size).toBe(seen.length);
    expect(seen.every((t) => t.assignee?.membershipId === members.sales2)).toBe(true);

    const closed = await list('sales1', '?state=closed');
    expect(closed.data.every((t) => t.status === 'DONE' || t.status === 'CANCELLED')).toBe(true);
    const forCompany = await list('admin', `?organisationId=${company.id}&state=all`);
    expect(forCompany.data.length).toBeGreaterThan(0);
    expect(forCompany.data.every((t) => t.organisation?.id === company.id)).toBe(true);
  });

  it('ASSIGNED scope: a decorator sees and changes only their tasks, and cannot hand them on', async () => {
    const theirs = (
      await createTask('admin', { title: `Install ${suffix}`, assigneeMembershipId: members.decorator })
    ).json<TaskItem>();
    const other = (await createTask('admin', { title: `Office ${suffix}` })).json<TaskItem>();

    const visible = await list('decorator', '?state=all&limit=100');
    expect(visible.data.map((t) => t.id)).toEqual([theirs.id]);
    expect((await send('decorator', 'GET', `/tasks/${other.id}`)).statusCode).toBe(404);
    expect((await act('decorator', other, 'start')).statusCode).toBe(404);

    const started = await act('decorator', theirs, 'start');
    expect(started.json<TaskItem>().status).toBe('IN_PROGRESS');
    const handOff = await send(
      'decorator',
      'PATCH',
      `/tasks/${theirs.id}`,
      { assigneeMembershipId: members.admin },
      theirs.version + 1,
    );
    expect(handOff.statusCode).toBe(403);
  });

  it('never reaches another tenant', async () => {
    const t = (await createTask('sales1', { title: `Private ${suffix}` })).json<TaskItem>();
    expect((await send('adminB', 'GET', `/tasks/${t.id}`)).statusCode).toBe(404);
    expect((await act('adminB', t, 'complete')).statusCode).toBe(404);
    expect((await list('adminB', '?state=all&limit=100')).data.some((x) => x.id === t.id)).toBe(false);
  });
});

describe('opportunity won → "Create brief" task', () => {
  it('creates one task for the owner, about the opportunity, even if it is won again', async () => {
    let opp = (
      await send('sales1', 'POST', '/opportunities', {
        organisationId: company.id,
        name: `Autumn ${suffix}`,
        estimatedValue: '45000',
        expectedCloseDate: '2026-10-15',
      })
    ).json<OpportunityDetail>();
    opp = (await send('sales1', 'POST', `/opportunities/${opp.id}/actions/win`, {}, opp.version)).json();
    await drainOutbox(app);

    const tasks = await list('sales1', `?opportunityId=${opp.id}&state=all`);
    expect(tasks.data).toHaveLength(1);
    const brief = tasks.data[0]!;
    expect(brief).toMatchObject({
      title: `Create brief: Autumn ${suffix}`,
      source: 'SYSTEM',
      status: 'OPEN',
      assignee: { membershipId: members.sales1 },
      organisation: { id: company.id },
      subject: { type: 'opportunity', id: opp.id, name: `Autumn ${suffix}` },
    });
    const dueInMs = new Date(brief.dueAt!).getTime() - Date.now();
    expect(dueInMs).toBeGreaterThan(47 * 3600e3);
    expect(dueInMs).toBeLessThan(49 * 3600e3);

    // Reopen (Management only: admin) and win again: still one task.
    opp = (
      await send(
        'admin',
        'POST',
        `/opportunities/${opp.id}/actions/reopen`,
        { reason: 'Client came back' },
        opp.version,
      )
    ).json();
    await send('admin', 'POST', `/opportunities/${opp.id}/actions/win`, {}, opp.version);
    await drainOutbox(app);
    const rows = await owner.db.select({ id: task.id }).from(task).where(eq(task.subjectId, opp.id));
    expect(rows).toHaveLength(1);
  });
});
