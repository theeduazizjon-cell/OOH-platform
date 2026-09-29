/**
 * CRM organisations end to end (M2a): classifications (nomenclature), companies with duplicate
 * detection, OWN-scoped editing, archive, If-Match, audit and tenant isolation.
 * Roadmap acceptance (12-roadmap.md, M2): "Carrefour + Agency X created once with two classifications".
 */
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type AuthSession,
  type ClassificationItem,
  type DuplicateMatch,
  etagOf,
  type OrganisationDetail,
  type OrganisationListItem,
  type Page,
} from '@ooh/contracts';
import {
  appUser,
  auditEvent,
  createDatabase,
  type DatabaseConnection,
  membership,
  membershipRole,
  organisation,
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

const USERS = ['admin', 'sales1', 'sales2', 'viewer', 'adminB'] as const;
type UserName = (typeof USERS)[number];
const users = {} as Record<UserName, string>;
const members = {} as Record<UserName, string>;

let app: NestFastifyApplication;
let owner: DatabaseConnection;
let tenantA: string;
let tenantB: string;
const tokens = {} as Record<UserName, string>;
const classes: Record<string, string> = {};

async function addMember(tenantId: string, name: UserName, roleKey: string) {
  const [m] = await owner.db
    .insert(membership)
    .values({ tenantId, userId: users[name], status: 'ACTIVE' })
    .returning({ id: membership.id });
  const [r] = await owner.db
    .select({ id: role.id })
    .from(role)
    .where(and(eq(role.tenantId, tenantId), eq(role.key, roleKey)));
  await owner.db.insert(membershipRole).values({ tenantId, membershipId: m!.id, roleId: r!.id });
  members[name] = m!.id;
}

beforeAll(async () => {
  owner = createDatabase(inject('ownerUrl'), { max: 2 });
  ({ tenantId: tenantA } = await provisionTenant(owner.db, { name: 'CRM Alpha', slug: `crma-${suffix}` }));
  ({ tenantId: tenantB } = await provisionTenant(owner.db, { name: 'CRM Beta', slug: `crmb-${suffix}` }));
  const passwordHash = await new PasswordService().hash(PASSWORD);
  for (const name of USERS) {
    const [u] = await owner.db
      .insert(appUser)
      .values({ email: email(name), displayName: name, passwordHash })
      .returning({ id: appUser.id });
    users[name] = u!.id;
  }
  await addMember(tenantA, 'admin', 'company_admin');
  await addMember(tenantA, 'sales1', 'sales');
  await addMember(tenantA, 'sales2', 'sales');
  await addMember(tenantA, 'viewer', 'viewer');
  await addMember(tenantB, 'adminB', 'company_admin');

  app = await createTestApp();
  for (const name of USERS) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: email(name), password: PASSWORD },
    });
    tokens[name] = response.json<AuthSession>().accessToken;
  }
  const list = await get('admin', '/config/classifications');
  for (const c of list.json<Page<ClassificationItem>>().data) classes[c.key] = c.id;
});

afterAll(async () => {
  await app?.close();
  await owner?.close();
});

// ── helpers ──────────────────────────────────────────────────────────────────

const bearer = (who: UserName) => ({ authorization: `Bearer ${tokens[who]}` });
const code = (response: LightMyRequestResponse) => response.json<{ code: string }>().code;
const get = (who: UserName, path: string) =>
  app.inject({ method: 'GET', url: `/api/v1${path}`, headers: bearer(who) });
const createOrg = (who: UserName, payload: object) =>
  app.inject({ method: 'POST', url: '/api/v1/organisations', headers: bearer(who), payload });

async function etag(id: string): Promise<string> {
  const [row] = await owner.db
    .select({ version: organisation.version })
    .from(organisation)
    .where(eq(organisation.id, id));
  return etagOf(row!.version);
}
const patchOrg = async (who: UserName, id: string, payload: object, ifMatch?: string | null) =>
  app.inject({
    method: 'PATCH',
    url: `/api/v1/organisations/${id}`,
    headers: { ...bearer(who), ...(ifMatch === null ? {} : { 'if-match': ifMatch ?? (await etag(id)) }) },
    payload,
  });
const archiveOrg = async (who: UserName, id: string) =>
  app.inject({
    method: 'POST',
    url: `/api/v1/organisations/${id}/actions/archive`,
    headers: { ...bearer(who), 'if-match': await etag(id) },
  });
const listOrgs = (who: UserName, query = '') =>
  get(who, `/organisations${query}`).then((r) => r.json<Page<OrganisationListItem>>());
const matchesOf = (response: LightMyRequestResponse) =>
  response.json<{ meta: { matches: DuplicateMatch[]; canForce: boolean } }>().meta;

// ── tests ────────────────────────────────────────────────────────────────────

describe('classifications (nomenclature)', () => {
  it('every tenant starts with the default classifications, readable by CRM users', async () => {
    const response = await get('sales1', '/config/classifications');
    expect(response.statusCode).toBe(200);
    const keys = response.json<Page<ClassificationItem>>().data.map((c) => c.key);
    expect(keys).toEqual([
      'prospect',
      'client',
      'agency',
      'ooh_supplier',
      'print_supplier',
      'support_owner',
      'subcontractor',
      'partner',
    ]);
    expect((await get('viewer', '/config/classifications')).statusCode).toBe(403);
  });

  it('admins add, rename and disable classifications; others cannot', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/config/classifications',
      headers: bearer('admin'),
      payload: { name: 'Media owner' },
    });
    expect(created.statusCode).toBe(201);
    const item = created.json<ClassificationItem>();
    expect(item).toMatchObject({ key: 'media_owner', active: true, version: 1 });
    classes.media_owner = item.id;

    const denied = await app.inject({
      method: 'POST',
      url: '/api/v1/config/classifications',
      headers: bearer('sales1'),
      payload: { name: 'Nope' },
    });
    expect(denied.statusCode).toBe(403);

    const disabled = await app.inject({
      method: 'PATCH',
      url: `/api/v1/config/classifications/${item.id}`,
      headers: { ...bearer('admin'), 'if-match': etagOf(1) },
      payload: { active: false },
    });
    expect(disabled.json<ClassificationItem>()).toMatchObject({ active: false, version: 2 });
    // A disabled classification is no longer offered for companies.
    const rejected = await createOrg('admin', { displayName: 'Uses disabled', classificationIds: [item.id] });
    expect(rejected.statusCode).toBe(422);
  });
});

describe('creating companies', () => {
  let carrefour: OrganisationDetail;

  it('acceptance: Carrefour and Agency X created once, each with two classifications', async () => {
    const created = await createOrg('admin', {
      displayName: 'Carrefour Romania',
      legalName: 'Carrefour România S.A.',
      vatNumber: 'ro 11588780',
      city: 'Bucharest',
      classificationIds: [classes.client, classes.support_owner],
    });
    expect(created.statusCode).toBe(201);
    carrefour = created.json<OrganisationDetail>();
    expect(carrefour).toMatchObject({
      vatNumber: 'RO11588780',
      country: 'RO',
      version: 1,
      accountOwner: { membershipId: members.admin },
    });
    expect(carrefour.classifications.map((c) => c.key)).toEqual(['client', 'support_owner']);

    const agency = await createOrg('admin', {
      displayName: 'Agency X',
      classificationIds: [classes.agency, classes.client],
    });
    expect(agency.statusCode).toBe(201);
    expect(agency.json<OrganisationDetail>().classifications).toHaveLength(2);

    // "Created once": the same companies again are caught as duplicates.
    const again = await createOrg('sales1', { displayName: 'CARREFOUR ROMANIA S.R.L.' });
    expect(again.statusCode).toBe(409);
    expect(code(again)).toBe('DUPLICATE_SUSPECTED');
    expect(matchesOf(again)).toMatchObject({
      canForce: true,
      matches: [{ id: carrefour.id, reason: 'NAME', similarity: 1 }],
    });
    const agencyAgain = await createOrg('sales1', { displayName: 'AGENCY X S.R.L.' });
    expect(agencyAgain.statusCode).toBe(409);
    expect(matchesOf(agencyAgain).matches[0]?.displayName).toBe('Agency X');
  });

  it('catches containment and typos, but not merely similar names', async () => {
    expect((await createOrg('admin', { displayName: 'Carrefour' })).statusCode).toBe(409);
    expect((await createOrg('admin', { displayName: 'Carefour Romania' })).statusCode).toBe(409);
    expect((await createOrg('admin', { displayName: 'Agency Y' })).statusCode).toBe(201);
  });

  it('a suspected name duplicate can be overridden with a reason, which is audited', async () => {
    const noReason = await createOrg('admin', { displayName: 'Carrefour', force: true });
    expect(noReason.statusCode).toBe(422);
    const forced = await createOrg('admin', {
      displayName: 'Carrefour',
      force: true,
      forceReason: 'Carrefour franchise in Brașov, separate legal entity',
    });
    expect(forced.statusCode).toBe(201);
    const [event] = await owner.db
      .select()
      .from(auditEvent)
      .where(
        and(
          eq(auditEvent.action, 'organisation.created'),
          eq(auditEvent.subjectId, forced.json<OrganisationDetail>().id),
        ),
      );
    expect(event?.metadata).toMatchObject({
      duplicateOverride: { reason: 'Carrefour franchise in Brașov, separate legal entity' },
    });
  });

  it('an identical VAT number is always refused, with or without the RO prefix', async () => {
    for (const vatNumber of ['RO11588780', '11588780']) {
      const response = await createOrg('admin', {
        displayName: 'Totally different name',
        vatNumber,
        force: true,
        forceReason: 'trying to force it',
      });
      expect(response.statusCode).toBe(409);
      expect(matchesOf(response)).toMatchObject({ canForce: false, matches: [{ reason: 'VAT' }] });
    }
  });

  it('validates the payload', async () => {
    for (const payload of [
      { displayName: '' },
      { displayName: 'Bad VAT', vatNumber: 'X' },
      { displayName: 'Bad country', country: 'Romania' },
      { displayName: 'Unknown class', classificationIds: [crypto.randomUUID()] },
      { displayName: 'Foreign owner', accountOwnerMembershipId: members.adminB },
    ]) {
      expect((await createOrg('admin', payload)).statusCode, JSON.stringify(payload)).toBe(422);
    }
    expect((await createOrg('viewer', { displayName: 'No permission' })).statusCode).toBe(403);
  });
});

describe('finding companies', () => {
  it('searches names regardless of accents, case and legal form, and VAT numbers', async () => {
    expect((await createOrg('admin', { displayName: 'Agenția Ștefan SRL' })).statusCode).toBe(201);
    for (const q of ['agentia stefan', 'AGENȚIA', 'Ştefan']) {
      const found = await listOrgs('admin', `?q=${encodeURIComponent(q)}`);
      expect(
        found.data.map((o) => o.displayName),
        q,
      ).toContain('Agenția Ștefan SRL');
    }
    expect((await listOrgs('admin', '?q=romania')).data.map((o) => o.displayName)).toContain(
      'Carrefour Romania',
    );
    expect((await listOrgs('admin', '?q=RO1158')).data.map((o) => o.vatNumber)).toContain('RO11588780');
  });

  it('filters by classification and pages through all companies in name order', async () => {
    const agencies = await listOrgs('admin', `?classificationId=${classes.agency}`);
    expect(agencies.data.map((o) => o.displayName)).toEqual(['Agency X']);

    const all = (await listOrgs('admin', '?limit=100')).data.map((o) => o.id);
    const walked: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await listOrgs('admin', `?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      walked.push(...page.data.map((o) => o.id));
      cursor = page.page.nextCursor;
    } while (cursor);
    expect(walked).toEqual(all);
    expect((await get('admin', '/organisations?cursor=garbage')).statusCode).toBe(422);
  });
});

describe('editing companies', () => {
  let owned: OrganisationDetail;

  it('records field-level changes and requires If-Match', async () => {
    owned = (
      await createOrg('sales1', { displayName: `Sales One Client ${suffix}` })
    ).json<OrganisationDetail>();
    expect(owned.accountOwner?.membershipId).toBe(members.sales1);

    expect((await patchOrg('sales1', owned.id, { city: 'Cluj' }, null)).statusCode).toBe(428);
    expect((await patchOrg('sales1', owned.id, { city: 'Cluj' }, etagOf(9))).statusCode).toBe(412);
    const updated = await patchOrg('sales1', owned.id, {
      city: 'Cluj-Napoca',
      classificationIds: [classes.prospect],
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.headers.etag).toBe(etagOf(2));
    expect(updated.json<OrganisationDetail>().classifications.map((c) => c.key)).toEqual(['prospect']);

    const [event] = await owner.db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.action, 'organisation.updated'), eq(auditEvent.subjectId, owned.id)));
    expect(event?.changes).toMatchObject({ city: { from: null, to: 'Cluj-Napoca' } });
  });

  it('OWN scope: Sales edits only the companies they own', async () => {
    // sales2 can read it (organisation.read@ALL) but not change it (organisation.update@OWN).
    expect((await get('sales2', `/organisations/${owned.id}`)).statusCode).toBe(200);
    const denied = await patchOrg('sales2', owned.id, { city: 'Iași' });
    expect(denied.statusCode).toBe(403);
    expect(denied.json<{ detail: string }>().detail).toMatch(/account owner/);

    // After the admin hands the account over, sales2 can.
    expect((await patchOrg('admin', owned.id, { accountOwnerMembershipId: members.sales2 })).statusCode).toBe(
      200,
    );
    expect((await patchOrg('sales2', owned.id, { city: 'Iași' })).statusCode).toBe(200);
    expect((await patchOrg('sales1', owned.id, { city: 'Cluj' })).statusCode).toBe(403);
  });

  it('refuses a VAT number another company already has', async () => {
    const response = await patchOrg('admin', owned.id, { vatNumber: '11588780' });
    expect(response.statusCode).toBe(409);
    expect(matchesOf(response).canForce).toBe(false);
  });

  it('archives (admins only); archived companies are hidden and read-only', async () => {
    expect((await archiveOrg('sales2', owned.id)).statusCode).toBe(403);
    const archived = await archiveOrg('admin', owned.id);
    expect(archived.json<OrganisationDetail>().archivedAt).not.toBeNull();

    expect((await listOrgs('admin', '?limit=100')).data.map((o) => o.id)).not.toContain(owned.id);
    expect((await listOrgs('admin', '?limit=100&includeArchived=true')).data.map((o) => o.id)).toContain(
      owned.id,
    );
    const edit = await patchOrg('admin', owned.id, { city: 'Timișoara' });
    expect(edit.statusCode).toBe(409);
    expect(code(edit)).toBe('INVALID_TRANSITION');
  });
});

describe('tenant isolation', () => {
  it('companies and classifications of another tenant are unreachable', async () => {
    const [carrefour] = await owner.db
      .select({ id: organisation.id })
      .from(organisation)
      .where(and(eq(organisation.tenantId, tenantA), eq(organisation.displayName, 'Carrefour Romania')));
    expect((await get('adminB', `/organisations/${carrefour!.id}`)).statusCode).toBe(404);
    expect((await patchOrg('adminB', carrefour!.id, { city: 'X' }, '*')).statusCode).toBe(404);
    expect((await listOrgs('adminB')).data).toHaveLength(0);
    // Tenant B can record the same company independently (same VAT number).
    const own = await createOrg('adminB', { displayName: 'Carrefour Romania', vatNumber: 'RO11588780' });
    expect(own.statusCode).toBe(201);
  });
});
