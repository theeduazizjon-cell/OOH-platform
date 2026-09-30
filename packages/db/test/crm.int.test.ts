/**
 * Database guarantees the CRM relies on: name normalisation, VAT uniqueness, tenant isolation of
 * organisations and their classifications, and the membership → organisation reference.
 */
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { provisionTenant } from '../src/provisioning';
import {
  appUser,
  contact,
  membership,
  organisation,
  organisationClassification,
  organisationClassificationLink,
} from '../src/schema';
import { withTenantTx } from '../src/tenant-context';
import { appConnection, expectPgError, ownerConnection, SQLSTATE } from './helpers';

const owner = ownerConnection();
const app = appConnection();
const suffix = Date.now().toString(36);
const UNIQUE_VIOLATION = '23505';

let tenantA: string;
let tenantB: string;

const inTenant = <T>(tenantId: string, fn: Parameters<typeof withTenantTx<T>>[2]) =>
  withTenantTx(app.db, { tenantId, actorUserId: null }, fn);

const createOrg = (tenantId: string, values: Partial<typeof organisation.$inferInsert> = {}) =>
  inTenant(tenantId, (tx) =>
    tx
      .insert(organisation)
      .values({ tenantId, displayName: 'Company', ...values })
      .returning(),
  ).then((rows) => rows[0]!);

async function classificationId(tenantId: string, key: string) {
  const [row] = await owner.db
    .select({ id: organisationClassification.id })
    .from(organisationClassification)
    .where(and(eq(organisationClassification.tenantId, tenantId), eq(organisationClassification.key, key)));
  return row!.id;
}

beforeAll(async () => {
  ({ tenantId: tenantA } = await provisionTenant(owner.db, { name: 'CRM A', slug: `crm-a-${suffix}` }));
  ({ tenantId: tenantB } = await provisionTenant(owner.db, { name: 'CRM B', slug: `crm-b-${suffix}` }));
});

afterAll(async () => {
  await app.close();
  await owner.close();
});

describe('provisioning', () => {
  it('installs the default classifications once, without overwriting tenant edits', async () => {
    await owner.db
      .update(organisationClassification)
      .set({ name: 'Customer' })
      .where(
        and(eq(organisationClassification.tenantId, tenantA), eq(organisationClassification.key, 'client')),
      );
    await provisionTenant(owner.db, { name: 'CRM A', slug: `crm-a-${suffix}` });

    const rows = await owner.db
      .select()
      .from(organisationClassification)
      .where(eq(organisationClassification.tenantId, tenantA));
    expect(rows).toHaveLength(8);
    expect(rows.find((r) => r.key === 'client')?.name).toBe('Customer');
  });
});

describe('organisation', () => {
  it('derives a comparable name key (case, diacritics and legal forms ignored)', async () => {
    const org = await createOrg(tenantA, { displayName: 'Agenția Ștefan S.R.L.' });
    expect(org.nameKey).toBe('agentia stefan');
    const [row] = await app.db.execute<{ k: string }>(sql`SELECT crm_name_key('CARREFOUR România SA') AS k`);
    expect(row?.k).toBe('carrefour romania');
  });

  it('keeps VAT numbers unique per tenant among live companies only', async () => {
    const vatNumber = `RO${Date.now() % 1e8}`;
    const first = await createOrg(tenantA, { displayName: 'First', vatNumber });
    await expectPgError(createOrg(tenantA, { displayName: 'Second', vatNumber }), UNIQUE_VIOLATION);
    // Another tenant may have the same company.
    await createOrg(tenantB, { displayName: 'Elsewhere', vatNumber });
    // Once archived, the company can be recorded again.
    await inTenant(tenantA, (tx) =>
      tx.update(organisation).set({ archivedAt: new Date() }).where(eq(organisation.id, first.id)),
    );
    await createOrg(tenantA, { displayName: 'Recreated', vatNumber });
  });

  it('rejects malformed VAT numbers and blank names at the database level', async () => {
    await expectPgError(createOrg(tenantA, { vatNumber: 'ro 123' }), '23514');
    await expectPgError(createOrg(tenantA, { displayName: '   ' }), '23514');
  });

  it('is tenant-isolated and never deleted by the app', async () => {
    const org = await createOrg(tenantA, { displayName: 'Isolated' });
    const seenByB = await inTenant(tenantB, (tx) =>
      tx.select().from(organisation).where(eq(organisation.id, org.id)),
    );
    expect(seenByB).toHaveLength(0);
    await expectPgError(
      inTenant(tenantA, (tx) => tx.delete(organisation).where(eq(organisation.id, org.id))),
      SQLSTATE.INSUFFICIENT_PRIVILEGE,
    );
  });

  it('can only be classified with its own tenant’s classifications', async () => {
    const org = await createOrg(tenantA, { displayName: 'Classified' });
    const client = await classificationId(tenantA, 'client');
    const agency = await classificationId(tenantA, 'agency');
    await inTenant(tenantA, (tx) =>
      tx.insert(organisationClassificationLink).values([
        {
          tenantId: tenantA,
          organisationId: org.id,
          classificationId: client,
        },
        {
          tenantId: tenantA,
          organisationId: org.id,
          classificationId: agency,
        },
      ]),
    );
    // A classification id of tenant B, even written by a role that bypasses RLS.
    await expectPgError(
      owner.db.insert(organisationClassificationLink).values({
        tenantId: tenantA,
        organisationId: org.id,
        classificationId: await classificationId(tenantB, 'client'),
      }),
      SQLSTATE.FOREIGN_KEY_VIOLATION,
    );
  });
});

describe('membership → organisation', () => {
  it('lets a member represent an organisation of the same tenant only', async () => {
    const [user] = await owner.db
      .insert(appUser)
      .values({ email: `ext-${suffix}@example.com`, displayName: 'External' })
      .returning({ id: appUser.id });
    const orgA = await createOrg(tenantA, { displayName: 'Their company' });
    const orgB = await createOrg(tenantB, { displayName: 'Other tenant company' });

    await expectPgError(
      owner.db
        .insert(membership)
        .values({ tenantId: tenantA, userId: user!.id, kind: 'EXTERNAL', organisationId: orgB.id }),
      SQLSTATE.FOREIGN_KEY_VIOLATION,
    );
    const [m] = await owner.db
      .insert(membership)
      .values({ tenantId: tenantA, userId: user!.id, kind: 'EXTERNAL', organisationId: orgA.id })
      .returning({ organisationId: membership.organisationId });
    expect(m?.organisationId).toBe(orgA.id);
  });
});

describe('contact', () => {
  const addContact = (
    tenantId: string,
    values: Partial<typeof contact.$inferInsert> & { organisationId: string },
  ) =>
    inTenant(tenantId, (tx) =>
      tx
        .insert(contact)
        .values({ tenantId, firstName: 'Ana', ...values })
        .returning(),
    ).then((rows) => rows[0]!);

  it('allows one live primary contact and one live contact per email per organisation', async () => {
    const org = await createOrg(tenantA, { displayName: `Contacts Co ${suffix}` });
    const primary = await addContact(tenantA, { organisationId: org.id, isPrimary: true, email: 'ana@x.ro' });
    await expectPgError(addContact(tenantA, { organisationId: org.id, isPrimary: true }), UNIQUE_VIOLATION);
    // Email comparison is case-insensitive (citext).
    await expectPgError(addContact(tenantA, { organisationId: org.id, email: 'ANA@X.RO' }), UNIQUE_VIOLATION);
    // Once archived, both are free again.
    await inTenant(tenantA, (tx) =>
      tx.update(contact).set({ archivedAt: new Date() }).where(eq(contact.id, primary.id)),
    );
    await addContact(tenantA, { organisationId: org.id, isPrimary: true, email: 'ana@x.ro' });
  });

  it('requires a source and time once consent is stated, and derives newsletter eligibility', async () => {
    const org = await createOrg(tenantA, { displayName: `Consent Co ${suffix}` });
    await expectPgError(addContact(tenantA, { organisationId: org.id, consentStatus: 'OPTED_IN' }), '23514');
    const optedIn = await addContact(tenantA, {
      organisationId: org.id,
      consentStatus: 'OPTED_IN',
      consentSource: 'event form',
      consentAt: new Date(),
    });
    expect(optedIn.newsletterEligible).toBe(true);
    const [unsubscribed] = await inTenant(tenantA, (tx) =>
      tx.update(contact).set({ unsubscribedAt: new Date() }).where(eq(contact.id, optedIn.id)).returning(),
    );
    expect(unsubscribed?.newsletterEligible).toBe(false);
    expect(
      (await addContact(tenantA, { organisationId: org.id, firstName: 'Ștefan', lastName: 'Popescu' }))
        .nameKey,
    ).toBe('stefan popescu');
  });

  it('belongs to an organisation of the same tenant, is isolated, and is never deleted by the app', async () => {
    const orgB = await createOrg(tenantB, { displayName: `B Co ${suffix}` });
    await expectPgError(
      owner.db.insert(contact).values({ tenantId: tenantA, organisationId: orgB.id, firstName: 'X' }),
      SQLSTATE.FOREIGN_KEY_VIOLATION,
    );
    const org = await createOrg(tenantA, { displayName: `Private Co ${suffix}` });
    const person = await addContact(tenantA, { organisationId: org.id });
    expect(
      await inTenant(tenantB, (tx) => tx.select().from(contact).where(eq(contact.id, person.id))),
    ).toHaveLength(0);
    await expectPgError(
      inTenant(tenantA, (tx) => tx.delete(contact).where(eq(contact.id, person.id))),
      SQLSTATE.INSUFFICIENT_PRIVILEGE,
    );
  });
});
