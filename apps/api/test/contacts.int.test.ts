/**
 * CRM contacts end to end (M2b): primary contact, per-company email uniqueness, marketing consent,
 * OWN scope through the company's account owner, archive, GDPR anonymisation (including the audit
 * trail never holding personal data), If-Match and tenant isolation.
 */
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type AuthSession,
  type ContactDetail,
  type ContactListItem,
  etagOf,
  type OrganisationDetail,
  type Page,
} from '@ooh/contracts';
import {
  appUser,
  auditEvent,
  contact,
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

const USERS = ['admin', 'sales1', 'sales2', 'buyer', 'adminB'] as const;
type UserName = (typeof USERS)[number];
const users = {} as Record<UserName, string>;
const tokens = {} as Record<UserName, string>;

let app: NestFastifyApplication;
let owner: DatabaseConnection;
let tenantA: string;
let tenantB: string;
let carrefour: OrganisationDetail;
let salesCompany: OrganisationDetail;

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
}

beforeAll(async () => {
  owner = createDatabase(inject('ownerUrl'), { max: 2 });
  ({ tenantId: tenantA } = await provisionTenant(owner.db, { name: 'Contacts A', slug: `cta-${suffix}` }));
  ({ tenantId: tenantB } = await provisionTenant(owner.db, { name: 'Contacts B', slug: `ctb-${suffix}` }));
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
  await addMember(tenantA, 'buyer', 'ooh_buyer');
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
  const org = (who: UserName, displayName: string) =>
    app
      .inject({
        method: 'POST',
        url: '/api/v1/organisations',
        headers: bearer(who),
        payload: { displayName },
      })
      .then((r) => r.json<OrganisationDetail>());
  carrefour = await org('admin', `Carrefour Contacts ${suffix}`);
  salesCompany = await org('sales1', `Sales Owned ${suffix}`);
});

afterAll(async () => {
  await app?.close();
  await owner?.close();
});

// ── helpers ──────────────────────────────────────────────────────────────────

const bearer = (who: UserName) => ({ authorization: `Bearer ${tokens[who]}` });
const code = (response: LightMyRequestResponse) => response.json<{ code: string }>().code;
const createContact = (who: UserName, payload: object) =>
  app.inject({ method: 'POST', url: '/api/v1/contacts', headers: bearer(who), payload });
async function etag(id: string) {
  const [row] = await owner.db.select({ version: contact.version }).from(contact).where(eq(contact.id, id));
  return etagOf(row!.version);
}
const patchContact = async (who: UserName, id: string, payload: object, ifMatch?: string | null) =>
  app.inject({
    method: 'PATCH',
    url: `/api/v1/contacts/${id}`,
    headers: { ...bearer(who), ...(ifMatch === null ? {} : { 'if-match': ifMatch ?? (await etag(id)) }) },
    payload,
  });
const act = async (who: UserName, id: string, action: 'archive' | 'anonymise') =>
  app.inject({
    method: 'POST',
    url: `/api/v1/contacts/${id}/actions/${action}`,
    headers: { ...bearer(who), 'if-match': await etag(id) },
  });
const listContacts = (who: UserName, query: string) =>
  app
    .inject({ method: 'GET', url: `/api/v1/contacts${query}`, headers: bearer(who) })
    .then((r) => r.json<Page<ContactListItem>>());
const auditRowsFor = (subjectId: string) =>
  owner.db.select().from(auditEvent).where(eq(auditEvent.subjectId, subjectId));

// ── tests ────────────────────────────────────────────────────────────────────

describe('creating contacts', () => {
  it('adds a contact to a company, the creation audit holding no personal data', async () => {
    const created = await createContact('buyer', {
      organisationId: carrefour.id,
      firstName: 'Ioana',
      lastName: 'Popescu',
      position: 'Marketing Director',
      email: 'Ioana.Popescu@carrefour.ro',
      phone: '+40 721 000 000',
      isPrimary: true,
      isDecisionMaker: true,
      tags: ['retail', 'retail', 'vip'],
    });
    expect(created.statusCode).toBe(201);
    const person = created.json<ContactDetail>();
    expect(person).toMatchObject({
      organisation: { id: carrefour.id },
      isPrimary: true,
      tags: ['retail', 'vip'],
      consentStatus: 'UNKNOWN',
      newsletterEligible: false,
      version: 1,
    });
    const audit = JSON.stringify(await auditRowsFor(person.id));
    expect(audit).not.toMatch(/Ioana|Popescu|carrefour\.ro/i);
  });

  it('a new primary contact takes over from the previous one', async () => {
    const second = await createContact('buyer', {
      organisationId: carrefour.id,
      firstName: 'Mihai',
      isPrimary: true,
    });
    expect(second.json<ContactDetail>().isPrimary).toBe(true);
    const all = await listContacts('buyer', `?organisationId=${carrefour.id}`);
    expect(all.data.filter((c) => c.isPrimary).map((c) => c.firstName)).toEqual(['Mihai']);
  });

  it('refuses a duplicate email within a company (case-insensitive), but not across companies', async () => {
    const same = await createContact('buyer', {
      organisationId: carrefour.id,
      firstName: 'Copy',
      email: 'IOANA.POPESCU@CARREFOUR.RO',
    });
    expect(same.statusCode).toBe(409);
    expect(code(same)).toBe('CONFLICT');
    const elsewhere = await createContact('buyer', {
      organisationId: salesCompany.id,
      firstName: 'Ioana',
      email: 'ioana.popescu@carrefour.ro',
    });
    expect(elsewhere.statusCode).toBe(201);
  });

  it('validates input, the company and permissions', async () => {
    for (const payload of [
      { organisationId: carrefour.id, firstName: '' },
      { organisationId: carrefour.id, firstName: 'X', email: 'not-an-email' },
      { organisationId: carrefour.id, firstName: 'X', consentStatus: 'OPTED_IN' }, // no source
      { organisationId: crypto.randomUUID(), firstName: 'X' },
    ]) {
      expect((await createContact('admin', payload)).statusCode, JSON.stringify(payload)).toBe(422);
    }
    const [tenantBOrg] = await app
      .inject({
        method: 'POST',
        url: '/api/v1/organisations',
        headers: bearer('adminB'),
        payload: { displayName: `B only ${suffix}` },
      })
      .then((r) => [r.json<OrganisationDetail>()]);
    expect(
      (await createContact('admin', { organisationId: tenantBOrg!.id, firstName: 'X' })).statusCode,
    ).toBe(422);
  });
});

describe('marketing consent', () => {
  it('requires a source, stamps the time, and derives newsletter eligibility', async () => {
    const person = (
      await createContact('buyer', {
        organisationId: carrefour.id,
        firstName: 'Elena',
        email: 'elena@carrefour.ro',
        consentStatus: 'OPTED_IN',
        consentSource: 'Trade fair form 2026',
      })
    ).json<ContactDetail>();
    expect(person).toMatchObject({ consentStatus: 'OPTED_IN', newsletterEligible: true });
    expect(person.consentAt).not.toBeNull();

    const optedOut = await patchContact('buyer', person.id, {
      consentStatus: 'OPTED_OUT',
      consentSource: 'Email reply',
    });
    expect(optedOut.json<ContactDetail>()).toMatchObject({
      consentStatus: 'OPTED_OUT',
      newsletterEligible: false,
    });

    // Consent values are audited (they're the point of the trail); personal fields are not.
    await patchContact('buyer', person.id, { email: 'elena.new@carrefour.ro', position: 'CMO' });
    const updates = (await auditRowsFor(person.id)).filter((e) => e.action === 'contact.updated');
    expect(updates[0]?.changes).toMatchObject({ consentStatus: { from: 'OPTED_IN', to: 'OPTED_OUT' } });
    expect(updates[1]?.changes).toEqual({
      email: { from: '[personal data]', to: '[personal data]' },
      position: { from: '[personal data]', to: '[personal data]' },
    });
    expect(JSON.stringify(updates)).not.toMatch(/elena|CMO/i);
  });
});

describe('finding contacts', () => {
  it('searches names regardless of accents, and email prefixes; pages in name order', async () => {
    await createContact('buyer', { organisationId: carrefour.id, firstName: 'Ștefan', lastName: 'Ionescu' });
    expect((await listContacts('buyer', '?q=stefan')).data.map((c) => c.lastName)).toContain('Ionescu');
    expect((await listContacts('buyer', '?q=IOANA.pop')).data.map((c) => c.firstName)).toContain('Ioana');

    const all = (await listContacts('buyer', '?limit=100')).data.map((c) => c.id);
    const walked: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await listContacts('buyer', `?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      walked.push(...page.data.map((c) => c.id));
      cursor = page.page.nextCursor;
    } while (cursor);
    expect(walked).toEqual(all);
  });
});

describe('changing contacts', () => {
  it('requires If-Match', async () => {
    const person = (
      await createContact('buyer', { organisationId: carrefour.id, firstName: 'Radu' })
    ).json<ContactDetail>();
    expect((await patchContact('buyer', person.id, { position: 'X' }, null)).statusCode).toBe(428);
    expect((await patchContact('buyer', person.id, { position: 'X' }, etagOf(7))).statusCode).toBe(412);
  });

  it('OWN scope follows the company: Sales edits contacts of the companies they own', async () => {
    const person = (
      await createContact('sales2', { organisationId: salesCompany.id, firstName: 'Owned' })
    ).json<ContactDetail>();
    // sales2 may create (contact.create@ALL) and read, but not edit outside their companies.
    const denied = await patchContact('sales2', person.id, { position: 'Buyer' });
    expect(denied.statusCode).toBe(403);
    expect(denied.json<{ detail: string }>().detail).toMatch(/account owner/);
    expect((await patchContact('sales1', person.id, { position: 'Buyer' })).statusCode).toBe(200);
  });

  it('archives (contact.archive); archived contacts are hidden and read-only', async () => {
    const person = (
      await createContact('buyer', { organisationId: carrefour.id, firstName: 'Temp' })
    ).json<ContactDetail>();
    expect((await act('buyer', person.id, 'archive')).statusCode).toBe(403);
    expect((await act('admin', person.id, 'archive')).json<ContactDetail>().archivedAt).not.toBeNull();
    expect((await listContacts('admin', '?limit=100')).data.map((c) => c.id)).not.toContain(person.id);
    const edit = await patchContact('admin', person.id, { position: 'X' });
    expect(code(edit)).toBe('INVALID_TRANSITION');
  });
});

describe('GDPR anonymisation', () => {
  it('wipes personal data in place, stops marketing, and leaves no trace in the audit trail', async () => {
    const person = (
      await createContact('buyer', {
        organisationId: carrefour.id,
        firstName: 'Gabriela',
        lastName: 'Vasilescu',
        email: 'gabriela.vasilescu@carrefour.ro',
        phone: '+40 733 111 222',
        linkedin: 'https://linkedin.com/in/gvasilescu',
        tags: ['vip'],
        consentStatus: 'OPTED_IN',
        consentSource: 'Newsletter signup',
      })
    ).json<ContactDetail>();
    await patchContact('buyer', person.id, { position: 'Head of Media' });

    expect((await act('buyer', person.id, 'anonymise')).statusCode).toBe(403);
    const erased = await act('admin', person.id, 'anonymise');
    expect(erased.statusCode).toBe(200);
    expect(erased.json<ContactDetail>()).toMatchObject({
      firstName: 'Anonymised contact',
      lastName: null,
      email: null,
      phone: null,
      linkedin: null,
      position: null,
      tags: [],
      consentStatus: 'OPTED_OUT',
      newsletterEligible: false,
    });
    expect(erased.json<ContactDetail>().anonymisedAt).not.toBeNull();

    // Nothing personal survives: not in the row, not in search, not in any audit event.
    const [row] = await owner.db.select().from(contact).where(eq(contact.id, person.id));
    expect(JSON.stringify(row)).not.toMatch(/Gabriela|Vasilescu|gvasilescu|733 111|Head of Media/i);
    expect((await listContacts('admin', '?q=vasilescu&includeArchived=true')).data).toHaveLength(0);
    const trail = await auditRowsFor(person.id);
    expect(trail.map((e) => e.action)).toEqual(['contact.created', 'contact.updated', 'contact.anonymised']);
    expect(JSON.stringify(trail)).not.toMatch(/Gabriela|Vasilescu|gvasilescu|733 111|Head of Media|signup/i);

    // Final: no further changes.
    expect(code(await act('admin', person.id, 'anonymise'))).toBe('INVALID_TRANSITION');
    expect(code(await patchContact('admin', person.id, { firstName: 'Back' }))).toBe('INVALID_TRANSITION');
  });
});

describe('tenant isolation', () => {
  it('contacts of another tenant are unreachable', async () => {
    const [someone] = await owner.db
      .select({ id: contact.id })
      .from(contact)
      .where(eq(contact.tenantId, tenantA))
      .limit(1);
    expect(
      (await app.inject({ method: 'GET', url: `/api/v1/contacts/${someone!.id}`, headers: bearer('adminB') }))
        .statusCode,
    ).toBe(404);
    expect((await patchContact('adminB', someone!.id, { position: 'X' }, '*')).statusCode).toBe(404);
    expect((await listContacts('adminB', '')).data).toHaveLength(0);
    void tenantB;
  });
});
