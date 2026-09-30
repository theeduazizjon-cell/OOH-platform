/**
 * Database guarantees the CRM relies on: name normalisation, VAT uniqueness, tenant isolation of
 * organisations and their classifications, and the membership → organisation reference.
 */
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { provisionTenant } from '../src/provisioning';
import {
  activity,
  activityType,
  appUser,
  contact,
  membership,
  organisation,
  organisationClassification,
  organisationClassificationLink,
  organisationRelationship,
  opportunity,
  pipeline,
  pipelineStage,
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

describe('organisation relationship', () => {
  it('links two companies of the same tenant once per kind, never a company to itself', async () => {
    const agency = await createOrg(tenantA, { displayName: `Rel Agency ${suffix}` });
    const client = await createOrg(tenantA, { displayName: `Rel Client ${suffix}` });
    const link = (values: Partial<typeof organisationRelationship.$inferInsert>) =>
      inTenant(tenantA, (tx) =>
        tx.insert(organisationRelationship).values({
          tenantId: tenantA,
          fromOrganisationId: agency.id,
          toOrganisationId: client.id,
          kind: 'AGENCY_OF',
          ...values,
        }),
      );
    await link({});
    await expectPgError(link({}), UNIQUE_VIOLATION);
    await link({ kind: 'PARENT_OF' });
    await expectPgError(link({ toOrganisationId: agency.id }), '23514');

    const foreign = await createOrg(tenantB, { displayName: `Rel Foreign ${suffix}` });
    await expectPgError(
      owner.db.insert(organisationRelationship).values({
        tenantId: tenantA,
        fromOrganisationId: agency.id,
        toOrganisationId: foreign.id,
        kind: 'AGENCY_OF',
      }),
      SQLSTATE.FOREIGN_KEY_VIOLATION,
    );
    expect(await inTenant(tenantB, (tx) => tx.select().from(organisationRelationship))).toHaveLength(0);
  });
});

describe('sales pipeline', () => {
  const stagesOf = async (tenantId: string) => {
    const [p] = await owner.db.select().from(pipeline).where(eq(pipeline.tenantId, tenantId));
    const stages = await owner.db.select().from(pipelineStage).where(eq(pipelineStage.pipelineId, p!.id));
    const byName = (name: string) => stages.find((s) => s.name === name)!;
    return { pipelineId: p!.id, lead: byName('Lead'), won: byName('Won'), lost: byName('Lost') };
  };

  it('provisions one default pipeline with lead stages first, and the activity types', async () => {
    const pipelines = await owner.db.select().from(pipeline).where(eq(pipeline.tenantId, tenantA));
    expect(pipelines).toEqual([expect.objectContaining({ name: 'Sales pipeline', isDefault: true })]);
    const stages = await owner.db
      .select({ name: pipelineStage.name, kind: pipelineStage.kind })
      .from(pipelineStage)
      .where(eq(pipelineStage.pipelineId, pipelines[0]!.id))
      .orderBy(pipelineStage.position);
    expect(stages.map((s) => s.name)).toEqual([
      'Lead',
      'Contacted',
      'Qualified',
      'Proposal',
      'Negotiation',
      'Won',
      'Lost',
    ]);
    // Provisioning again adds nothing.
    await provisionTenant(owner.db, { name: 'CRM A', slug: `crm-a-${suffix}` });
    expect(await owner.db.select().from(pipeline).where(eq(pipeline.tenantId, tenantA))).toHaveLength(1);
    const types = await owner.db
      .select({ key: activityType.key })
      .from(activityType)
      .where(eq(activityType.tenantId, tenantA));
    expect(types.map((t) => t.key)).toEqual(expect.arrayContaining(['call', 'meeting', 'stage_change']));
  });

  it('allows exactly one WON and one LOST stage per pipeline', async () => {
    const { pipelineId } = await stagesOf(tenantA);
    await expectPgError(
      owner.db
        .insert(pipelineStage)
        .values({ tenantId: tenantA, pipelineId, name: 'Won again', kind: 'WON', position: 99 }),
      UNIQUE_VIOLATION,
    );
  });

  it('enforces the opportunity state machine preconditions in the database', async () => {
    const { lead, won, lost } = await stagesOf(tenantA);
    const org = await createOrg(tenantA, { displayName: `Pipeline Co ${suffix}` });
    const [m] = await owner.db
      .select({ id: membership.id })
      .from(membership)
      .where(eq(membership.tenantId, tenantA))
      .limit(1);
    const [user] = m
      ? [m]
      : await owner.db
          .insert(appUser)
          .values({ email: `owner-${suffix}@example.com`, displayName: 'Owner' })
          .returning({ id: appUser.id })
          .then(async ([u]) =>
            owner.db
              .insert(membership)
              .values({ tenantId: tenantA, userId: u!.id, status: 'ACTIVE' })
              .returning({ id: membership.id }),
          );
    const base = { tenantId: tenantA, organisationId: org.id, ownerMembershipId: user!.id, name: 'Deal' };
    const insert = (values: Partial<typeof opportunity.$inferInsert>) =>
      inTenant(tenantA, (tx) =>
        tx
          .insert(opportunity)
          .values({ ...base, pipelineStageId: lead.id, stageKind: 'OPEN', ...values })
          .returning(),
      ).then((rows) => rows[0]!);

    const open = await insert({});
    const CHECK = '23514';
    // The kind copy must match the stage (composite FK).
    // (Valid WON data, so only the stage/kind mismatch can fail: CHECKs fire before FKs.)
    await expectPgError(
      insert({
        pipelineStageId: lead.id,
        stageKind: 'WON',
        estimatedValue: '1.00',
        expectedCloseDate: '2026-12-01',
        closedAt: new Date(),
      }),
      SQLSTATE.FOREIGN_KEY_VIOLATION,
    );
    // WON needs a value and a close date, and closed_at.
    await expectPgError(insert({ pipelineStageId: won.id, stageKind: 'WON', closedAt: new Date() }), CHECK);
    await insert({
      pipelineStageId: won.id,
      stageKind: 'WON',
      estimatedValue: '12000.00',
      expectedCloseDate: '2026-12-01',
      closedAt: new Date(),
    });
    // LOST needs a reason; OPEN can't have closed_at.
    await expectPgError(insert({ pipelineStageId: lost.id, stageKind: 'LOST', closedAt: new Date() }), CHECK);
    await expectPgError(insert({ closedAt: new Date() }), CHECK);
    await expectPgError(insert({ currency: 'USD' }), CHECK);
    expect(open.stageKind).toBe('OPEN');
  });

  it('keeps contact, opportunity and activity on the same company', async () => {
    const { lead } = await stagesOf(tenantA);
    const orgA = await createOrg(tenantA, { displayName: `Same Co ${suffix}` });
    const orgOther = await createOrg(tenantA, { displayName: `Other Co ${suffix}` });
    const [person] = await inTenant(tenantA, (tx) =>
      tx
        .insert(contact)
        .values({ tenantId: tenantA, organisationId: orgOther.id, firstName: 'Elsewhere' })
        .returning(),
    );
    const [m] = await owner.db
      .select({ id: membership.id })
      .from(membership)
      .where(eq(membership.tenantId, tenantA))
      .limit(1);
    // A contact of another company can't be the opportunity's contact.
    await expectPgError(
      inTenant(tenantA, (tx) =>
        tx.insert(opportunity).values({
          tenantId: tenantA,
          organisationId: orgA.id,
          contactId: person!.id,
          ownerMembershipId: m!.id,
          name: 'Mismatch',
          pipelineStageId: lead.id,
          stageKind: 'OPEN',
        }),
      ),
      SQLSTATE.FOREIGN_KEY_VIOLATION,
    );
    const [note] = await owner.db
      .select({ id: activityType.id })
      .from(activityType)
      .where(and(eq(activityType.tenantId, tenantA), eq(activityType.key, 'note')));
    await expectPgError(
      inTenant(tenantA, (tx) =>
        tx.insert(activity).values({
          tenantId: tenantA,
          organisationId: orgA.id,
          contactId: person!.id,
          activityTypeId: note!.id,
          subject: 'Mismatch',
        }),
      ),
      SQLSTATE.FOREIGN_KEY_VIOLATION,
    );
  });
});
