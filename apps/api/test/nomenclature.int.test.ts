/**
 * Sales nomenclatures (M2c.3): pipeline stages (add, rename, reorder, disable) and activity types,
 * written by admins only (config.manage), with If-Match, audit and tenant isolation.
 */
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type ActivityTypeItem,
  type AuthSession,
  etagOf,
  type OpportunityDetail,
  type OrganisationDetail,
  type PipelineItem,
  type PipelineStageItem,
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
} from '@ooh/db';
import { and, eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PasswordService } from '../src/core/auth/password.service';
import { createTestApp } from './support';

const PASSWORD = 'correct horse battery staple';
const suffix = Date.now().toString(36);
const email = (name: string) => `${name}-${suffix}@example.com`;

const USERS = ['admin', 'sales', 'adminB'] as const;
type UserName = (typeof USERS)[number];
const users = {} as Record<UserName, string>;
const tokens = {} as Record<UserName, string>;

let app: NestFastifyApplication;
let owner: DatabaseConnection;
let tenantA: string;
let company: OrganisationDetail;

beforeAll(async () => {
  owner = createDatabase(inject('ownerUrl'), { max: 2 });
  ({ tenantId: tenantA } = await provisionTenant(owner.db, { name: 'Nomen Alpha', slug: `nma-${suffix}` }));
  const { tenantId: tenantB } = await provisionTenant(owner.db, {
    name: 'Nomen Beta',
    slug: `nmb-${suffix}`,
  });
  const passwordHash = await new PasswordService().hash(PASSWORD);
  const add = async (tenantId: string, name: UserName, roleKey: string) => {
    const [u] = await owner.db
      .insert(appUser)
      .values({ email: email(name), displayName: name, passwordHash })
      .returning({ id: appUser.id });
    users[name] = u!.id;
    const [m] = await owner.db
      .insert(membership)
      .values({ tenantId, userId: u!.id, status: 'ACTIVE' })
      .returning({ id: membership.id });
    const [r] = await owner.db
      .select({ id: role.id })
      .from(role)
      .where(and(eq(role.tenantId, tenantId), eq(role.key, roleKey)));
    await owner.db.insert(membershipRole).values({ tenantId, membershipId: m!.id, roleId: r!.id });
  };
  await add(tenantA, 'admin', 'company_admin');
  await add(tenantA, 'sales', 'sales');
  await add(tenantB, 'adminB', 'company_admin');

  app = await createTestApp();
  for (const name of USERS) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: email(name), password: PASSWORD },
    });
    tokens[name] = response.json<AuthSession>().accessToken;
  }
  company = (await send('admin', 'POST', '/organisations', { displayName: `Nomen Co ${suffix}` })).json();
});

afterAll(async () => {
  await app?.close();
  await owner?.close();
});

// ── helpers ──────────────────────────────────────────────────────────────────

function send(
  who: UserName,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  path: string,
  payload?: object,
  version?: number | string,
) {
  return app.inject({
    method,
    url: `/api/v1${path}`,
    headers: {
      authorization: `Bearer ${tokens[who]}`,
      ...(version === undefined
        ? {}
        : { 'if-match': typeof version === 'number' ? etagOf(version) : version }),
    },
    ...(payload ? { payload } : {}),
  });
}
const code = (response: LightMyRequestResponse) => response.json<{ code: string }>().code;
const pipelines = async (who: UserName = 'admin') =>
  (await send(who, 'GET', '/config/pipelines')).json<PipelineItem[]>();
const defaultPipeline = async (who: UserName = 'admin') => (await pipelines(who)).find((p) => p.isDefault)!;
const stageNamed = (p: PipelineItem, name: string) => p.stages.find((s) => s.name === name)!;
const openNames = (p: PipelineItem) => p.stages.filter((s) => s.kind === 'OPEN').map((s) => s.name);

/** Positions are 1…n with the open stages first, then Won, then Lost. */
function expectTidy(p: PipelineItem) {
  expect(p.stages.map((s) => s.position)).toEqual(p.stages.map((_, i) => i + 1));
  expect(p.stages.slice(-2).map((s) => s.kind)).toEqual(['WON', 'LOST']);
}

// ── stages ───────────────────────────────────────────────────────────────────

describe('pipeline stages', () => {
  it('only admins change stages; sales can read them', async () => {
    const p = await defaultPipeline('sales');
    const lead = stageNamed(p, 'Lead');
    expect((await send('sales', 'POST', `/config/pipelines/${p.id}/stages`, { name: 'X' })).statusCode).toBe(
      403,
    );
    expect(
      (await send('sales', 'PATCH', `/config/stages/${lead.id}`, { name: 'X' }, lead.version)).statusCode,
    ).toBe(403);
    expect(
      (
        await send(
          'sales',
          'PUT',
          `/config/pipelines/${p.id}/stage-order`,
          { stageIds: [lead.id] },
          p.version,
        )
      ).statusCode,
    ).toBe(403);
  });

  it('adds an open stage after the open ones, keeping Won and Lost last; names are unique', async () => {
    const p = await defaultPipeline();
    const created = await send('admin', 'POST', `/config/pipelines/${p.id}/stages`, {
      name: 'Site visit',
      probability: 60,
    });
    expect(created.statusCode).toBe(201);
    const stage = created.json<PipelineStageItem>();
    expect(stage).toMatchObject({ name: 'Site visit', kind: 'OPEN', probability: 60, active: true });

    const after = await defaultPipeline();
    expect(openNames(after)).toEqual([
      'Lead',
      'Contacted',
      'Qualified',
      'Proposal',
      'Negotiation',
      'Site visit',
    ]);
    expectTidy(after);

    const duplicate = await send('admin', 'POST', `/config/pipelines/${p.id}/stages`, { name: 'site VISIT' });
    expect(duplicate.statusCode).toBe(409);
    const [audit] = await owner.db
      .select({ metadata: auditEvent.metadata })
      .from(auditEvent)
      .where(and(eq(auditEvent.action, 'config.stage_created'), eq(auditEvent.subjectId, stage.id)));
    expect(audit?.metadata).toMatchObject({ name: 'Site visit' });
  });

  it('reorders the open stages with If-Match on the pipeline', async () => {
    const p = await defaultPipeline();
    const open = p.stages.filter((s) => s.kind === 'OPEN');
    const reversed = [...open].reverse().map((s) => s.id);
    const url = `/config/pipelines/${p.id}/stage-order`;

    expect((await send('admin', 'PUT', url, { stageIds: reversed })).statusCode).toBe(428);
    const partial = await send('admin', 'PUT', url, { stageIds: reversed.slice(1) }, p.version);
    expect(partial.statusCode).toBe(422);
    const withWon = await send(
      'admin',
      'PUT',
      url,
      { stageIds: [...reversed.slice(1), p.stages.at(-2)!.id] },
      p.version,
    );
    expect(withWon.statusCode).toBe(422);
    expect((await send('admin', 'PUT', url, { stageIds: reversed }, p.version + 1)).statusCode).toBe(412);

    const ok = await send('admin', 'PUT', url, { stageIds: reversed }, p.version);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers.etag).toBe(etagOf(p.version + 1));
    const reordered = ok.json<PipelineItem>();
    expect(openNames(reordered)).toEqual([...openNames(p)].reverse());
    expectTidy(reordered);

    // Restore the original order for the next tests.
    const back = await send('admin', 'PUT', url, { stageIds: open.map((s) => s.id) }, p.version + 1);
    expect(openNames(back.json<PipelineItem>())).toEqual(openNames(p));
  });

  it('renames and sets the default probability with If-Match', async () => {
    const p = await defaultPipeline();
    const proposal = stageNamed(p, 'Proposal');
    const url = `/config/stages/${proposal.id}`;
    expect((await send('admin', 'PATCH', url, { name: 'Offer sent' })).statusCode).toBe(428);
    expect((await send('admin', 'PATCH', url, { name: 'Contacted' }, proposal.version)).statusCode).toBe(409);
    const renamed = await send(
      'admin',
      'PATCH',
      url,
      { name: 'Offer sent', probability: 55 },
      proposal.version,
    );
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<PipelineStageItem>()).toMatchObject({ name: 'Offer sent', probability: 55 });
    expect((await send('admin', 'PATCH', url, { name: 'Again' }, proposal.version)).statusCode).toBe(412);

    // Won and Lost can be renamed but never disabled.
    const won = stageNamed(p, 'Won');
    expect(
      code(await send('admin', 'PATCH', `/config/stages/${won.id}`, { active: false }, won.version)),
    ).toBe('VALIDATION_FAILED');
    const signed = await send('admin', 'PATCH', `/config/stages/${won.id}`, { name: 'Signed' }, won.version);
    expect(signed.json<PipelineStageItem>().name).toBe('Signed');
  });

  it('disables a stage only when empty; new opportunities then start in the next active stage', async () => {
    let p = await defaultPipeline();
    const lead = stageNamed(p, 'Lead');
    const opp = (
      await send('admin', 'POST', '/opportunities', { organisationId: company.id, name: `Deal ${suffix}` })
    ).json<OpportunityDetail>();
    expect(opp.stage.name).toBe('Lead');

    const blocked = await send(
      'admin',
      'PATCH',
      `/config/stages/${lead.id}`,
      { active: false },
      lead.version,
    );
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json<{ detail: string }>().detail).toContain('1 open opportunity');

    const contacted = stageNamed(p, 'Contacted');
    const moved = await send(
      'admin',
      'POST',
      `/opportunities/${opp.id}/actions/move-stage`,
      { stageId: contacted.id },
      opp.version,
    );
    expect(moved.statusCode).toBe(200);
    const disabled = await send(
      'admin',
      'PATCH',
      `/config/stages/${lead.id}`,
      { active: false },
      lead.version,
    );
    expect(disabled.statusCode).toBe(200);

    const next = (
      await send('admin', 'POST', '/opportunities', { organisationId: company.id, name: `Next ${suffix}` })
    ).json<OpportunityDetail>();
    expect(next.stage.name).toBe('Contacted');
    // A disabled stage is no longer a move target.
    const intoDisabled = await send(
      'admin',
      'POST',
      `/opportunities/${next.id}/actions/move-stage`,
      { stageId: lead.id },
      next.version,
    );
    expect(intoDisabled.statusCode).toBe(422);

    p = await defaultPipeline();
    expect(stageNamed(p, 'Lead').active).toBe(false);
  });

  it('keeps at least one active open stage', async () => {
    const p = await defaultPipeline('adminB');
    const open = p.stages.filter((s) => s.kind === 'OPEN');
    for (const s of open.slice(1)) {
      expect(
        (await send('adminB', 'PATCH', `/config/stages/${s.id}`, { active: false }, s.version)).statusCode,
      ).toBe(200);
    }
    const last = open[0]!;
    const refused = await send(
      'adminB',
      'PATCH',
      `/config/stages/${last.id}`,
      { active: false },
      last.version,
    );
    expect(refused.statusCode).toBe(409);
  });

  it('never reaches another tenant', async () => {
    const lead = stageNamed(await defaultPipeline(), 'Contacted');
    const p = await defaultPipeline();
    expect(
      (await send('adminB', 'PATCH', `/config/stages/${lead.id}`, { name: 'Hijack' }, lead.version))
        .statusCode,
    ).toBe(404);
    expect(
      (await send('adminB', 'POST', `/config/pipelines/${p.id}/stages`, { name: 'Hijack' })).statusCode,
    ).toBe(404);
  });
});

// ── activity types ───────────────────────────────────────────────────────────

describe('activity types', () => {
  const types = async () => (await send('admin', 'GET', '/config/activity-types')).json<ActivityTypeItem[]>();

  it('admins add types with unique keys; sales cannot', async () => {
    expect((await send('sales', 'POST', '/config/activity-types', { name: 'Site visit' })).statusCode).toBe(
      403,
    );
    const first = await send('admin', 'POST', '/config/activity-types', { name: 'Site visit' });
    expect(first.statusCode).toBe(201);
    expect(first.json<ActivityTypeItem>()).toMatchObject({
      key: 'site_visit',
      isSystem: false,
      active: true,
    });
    const second = await send('admin', 'POST', '/config/activity-types', { name: 'Site visit' });
    expect(second.json<ActivityTypeItem>().key).toBe('site_visit_2');
  });

  it('disabling a type stops it being logged; platform types are read-only', async () => {
    const visit = (await types()).find((t) => t.key === 'site_visit')!;
    const url = `/config/activity-types/${visit.id}`;
    expect((await send('admin', 'PATCH', url, { active: false })).statusCode).toBe(428);
    const disabled = await send('admin', 'PATCH', url, { active: false, name: 'Field visit' }, visit.version);
    expect(disabled.json<ActivityTypeItem>()).toMatchObject({ active: false, name: 'Field visit' });
    expect((await send('admin', 'PATCH', url, { active: true }, visit.version)).statusCode).toBe(412);

    const logged = await send('admin', 'POST', '/activities', {
      organisationId: company.id,
      activityTypeId: visit.id,
      subject: 'Walked the site',
    });
    expect(logged.statusCode).toBe(422);

    const system = (await types()).find((t) => t.isSystem)!;
    expect(
      code(
        await send('admin', 'PATCH', `/config/activity-types/${system.id}`, { name: 'X' }, system.version),
      ),
    ).toBe('CONFLICT');
    expect((await send('adminB', 'PATCH', url, { name: 'Hijack' }, visit.version + 1)).statusCode).toBe(404);
  });
});
