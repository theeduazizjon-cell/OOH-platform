/**
 * The outbox worker (M3c.1, 08-system-architecture.md): events written by business transactions are
 * dispatched later, in their tenant's context; handlers are idempotent and atomic per event; failures
 * retry with backoff and are parked after MAX_ATTEMPTS. Event-driven tasks: "Create brief" after a
 * win, "Research {store}" for each new campaign location.
 */
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type AuthSession,
  type BriefDetail,
  type CampaignDetail,
  etagOf,
  type OpportunityDetail,
  type OrganisationDetail,
  type Page,
  type TaskItem,
} from '@ooh/contracts';
import {
  appUser,
  auditEvent,
  createDatabase,
  type DatabaseConnection,
  membership,
  membershipRole,
  outboxEvent,
  provisionTenant,
  role,
  task,
} from '@ooh/db';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PasswordService } from '../src/core/auth/password.service';
import { backoffSeconds, MAX_ATTEMPTS } from '../src/core/outbox/outbox.dispatcher';
import { OutboxHandlers } from '../src/core/outbox/outbox-handlers';
import { createTestApp, drainOutbox } from './support';

const PASSWORD = 'correct horse battery staple';
const suffix = Date.now().toString(36);
const email = (name: string) => `${name}-${suffix}@example.com`;

type UserName = 'admin' | 'buyer' | 'sales';
const members = {} as Record<UserName, string>;
const tokens = {} as Record<UserName, string>;

let app: NestFastifyApplication;
let owner: DatabaseConnection;
let tenantId: string;
let client: OrganisationDetail;

beforeAll(async () => {
  owner = createDatabase(inject('ownerUrl'), { max: 2 });
  ({ tenantId } = await provisionTenant(owner.db, { name: 'Outbox Alpha', slug: `oxa-${suffix}` }));
  const passwordHash = await new PasswordService().hash(PASSWORD);
  for (const [name, roleKey] of [
    ['admin', 'company_admin'],
    ['buyer', 'ooh_buyer'],
    ['sales', 'sales'],
  ] as const) {
    const [u] = await owner.db
      .insert(appUser)
      .values({ email: email(name), displayName: name, passwordHash })
      .returning({ id: appUser.id });
    const [m] = await owner.db
      .insert(membership)
      .values({ tenantId, userId: u!.id, status: 'ACTIVE' })
      .returning({ id: membership.id });
    const [r] = await owner.db
      .select({ id: role.id })
      .from(role)
      .where(and(eq(role.tenantId, tenantId), eq(role.key, roleKey)));
    await owner.db.insert(membershipRole).values({ tenantId, membershipId: m!.id, roleId: r!.id });
    members[name] = m!.id;
  }
  app = await createTestApp();
  for (const name of ['admin', 'buyer', 'sales'] as const) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: email(name), password: PASSWORD },
    });
    tokens[name] = response.json<AuthSession>().accessToken;
  }
  client = (await send('admin', 'POST', '/organisations', { displayName: `Outbox Client ${suffix}` })).json();
  await drainOutbox(app); // start from a quiet outbox
});

afterAll(async () => {
  await app?.close();
  await owner?.close();
});

function send(who: UserName, method: 'GET' | 'POST', path: string, payload?: object, version?: number) {
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
const tasksFor = async (query: string) =>
  (await send('admin', 'GET', `/tasks?state=all&limit=100&${query}`)).json<Page<TaskItem>>().data;

async function wonDeal(name: string) {
  const opp = (
    await send('sales', 'POST', '/opportunities', {
      organisationId: client.id,
      name,
      estimatedValue: '1000',
      expectedCloseDate: '2026-12-01',
    })
  ).json<OpportunityDetail>();
  return (
    await send('sales', 'POST', `/opportunities/${opp.id}/actions/win`, {}, opp.version)
  ).json<OpportunityDetail>();
}
const publish = (eventType: string, payload: Record<string, unknown> = {}) =>
  owner.db
    .insert(outboxEvent)
    .values({ tenantId, eventType, payload })
    .returning({ id: outboxEvent.id })
    .then((rows) => rows[0]!.id);
const eventRow = async (id: string) =>
  (await owner.db.select().from(outboxEvent).where(eq(outboxEvent.id, id)))[0]!;

describe('delivery', () => {
  it('a win publishes opportunity.won; the worker creates "Create brief" as the platform', async () => {
    const opp = await wonDeal(`Delivered ${suffix}`);
    expect(await tasksFor(`opportunityId=${opp.id}`)).toEqual([]); // nothing until the worker runs
    const [event] = await owner.db
      .select()
      .from(outboxEvent)
      .where(
        and(
          eq(outboxEvent.eventType, 'opportunity.won'),
          sql`${outboxEvent.payload}->>'opportunityId' = ${opp.id}`,
        ),
      );
    expect(event).toMatchObject({ dispatchedAt: null, attempts: 0 });

    expect(await drainOutbox(app)).toBeGreaterThan(0);
    const [created] = await tasksFor(`opportunityId=${opp.id}`);
    expect(created).toMatchObject({
      title: `Create brief: Delivered ${suffix}`,
      source: 'SYSTEM',
      assignee: { membershipId: members.sales },
      createdBy: { membershipId: members.sales },
    });
    expect((await eventRow(event!.id)).dispatchedAt).not.toBeNull();
    const [audit] = await owner.db
      .select({ actorType: auditEvent.actorType })
      .from(auditEvent)
      .where(and(eq(auditEvent.action, 'task.created'), eq(auditEvent.subjectId, created!.id)));
    expect(audit?.actorType).toBe('SYSTEM');

    // Delivered again (e.g. after a crash): still one task.
    await owner.db.update(outboxEvent).set({ dispatchedAt: null }).where(eq(outboxEvent.id, event!.id));
    await drainOutbox(app);
    expect(await tasksFor(`opportunityId=${opp.id}`)).toHaveLength(1);
  });

  it('a deal reopened before the worker runs gets no "Create brief"', async () => {
    const opp = await wonDeal(`Reopened ${suffix}`);
    await send(
      'admin',
      'POST',
      `/opportunities/${opp.id}/actions/reopen`,
      { reason: 'Mistake' },
      opp.version,
    );
    await drainOutbox(app);
    expect(await tasksFor(`opportunityId=${opp.id}`)).toEqual([]);
  });

  it('each new campaign location gets a research task for its buyer, due on the brief deadline', async () => {
    let b = (
      await send('buyer', 'POST', '/briefs', {
        title: `Research ${suffix}`,
        clientOrganisationId: client.id,
        datesTbd: true,
        deadline: '2026-11-20',
        lines: [
          { storeName: 'Store One', city: 'Sinaia' },
          { storeName: 'Store Two', city: 'Brașov' },
        ],
      })
    ).json<BriefDetail>();
    b = (await send('buyer', 'POST', `/briefs/${b.id}/actions/confirm`, {}, b.version)).json();
    b = (await send('buyer', 'POST', `/briefs/${b.id}/actions/convert`, {}, b.version)).json();
    const c = (await send('buyer', 'GET', `/campaigns/${b.convertedCampaign!.id}`)).json<CampaignDetail>();
    // Cancelled before the worker gets to it: no research needed.
    const [, two] = c.locationItems;
    await send('buyer', 'POST', `/locations/${two!.id}/actions/cancel`, { reason: 'Dropped' }, two!.version);

    await drainOutbox(app);
    const research = await tasksFor(`campaignId=${c.id}`);
    expect(research).toEqual([
      expect.objectContaining({
        title: 'Research Store One',
        source: 'SYSTEM',
        dueAt: '2026-11-20T15:00:00.000Z', // 17:00 in Bucharest (EET)
        assignee: { membershipId: members.buyer, displayName: 'buyer' },
        campaign: { id: c.id, code: c.code, name: c.name },
        subject: { type: 'campaign_location', id: c.locationItems[0]!.id, name: 'Store One' },
        organisation: { id: client.id, displayName: client.displayName },
      }),
    ]);
  });
});

describe('failures', () => {
  it('retries with backoff, then parks the event', async () => {
    app
      .get(OutboxHandlers)
      .on(`test.fail.${suffix}`, 'test', () => Promise.reject(new Error('provider down')));
    const id = await publish(`test.fail.${suffix}`);
    await drainOutbox(app);
    const first = await eventRow(id);
    expect(first).toMatchObject({
      attempts: 1,
      lastError: 'provider down',
      dispatchedAt: null,
      failedAt: null,
    });
    const delay = (first.nextAttemptAt.getTime() - Date.now()) / 1000;
    expect(delay).toBeGreaterThan(backoffSeconds(1) - 2);

    // Not due yet: left alone.
    expect(await drainOutbox(app)).toBe(0);
    await owner.db
      .update(outboxEvent)
      .set({ attempts: MAX_ATTEMPTS - 1, nextAttemptAt: sql`now()` })
      .where(eq(outboxEvent.id, id));
    await drainOutbox(app);
    const parked = await eventRow(id);
    expect(parked.attempts).toBe(MAX_ATTEMPTS);
    expect(parked.failedAt).not.toBeNull();
  });

  it('an event is atomic: one failing handler rolls back the others', async () => {
    const handlers = app.get(OutboxHandlers);
    const marker = `atomic-${suffix}`;
    handlers.on(`test.atomic.${suffix}`, 'writes', async (tx, event) => {
      await tx.insert(task).values({ tenantId: event.tenantId, title: marker });
    });
    handlers.on(`test.atomic.${suffix}`, 'fails', () => Promise.reject(new Error('second handler failed')));
    const id = await publish(`test.atomic.${suffix}`);
    await drainOutbox(app);
    expect(await owner.db.select().from(task).where(eq(task.title, marker))).toEqual([]);
    expect((await eventRow(id)).attempts).toBe(1);
  });

  it('events without handlers are simply marked dispatched', async () => {
    const id = await publish(`test.nobody.${suffix}`);
    await drainOutbox(app);
    expect((await eventRow(id)).dispatchedAt).not.toBeNull();
  });
});
