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
  brief,
  briefLine,
  campaign,
  campaignLocation,
  statusHistory,
  task,
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

describe('task', () => {
  const insert = (tenantId: string, values: Partial<typeof task.$inferInsert>) =>
    inTenant(tenantId, (tx) =>
      tx
        .insert(task)
        .values({ tenantId, title: 'Call back', ...values })
        .returning(),
    ).then((rows) => rows[0]!);

  it('enforces subject, completion and dedupe rules', async () => {
    const org = await createOrg(tenantA, { displayName: `Task Co ${suffix}` });
    const plain = await insert(tenantA, {});
    expect(plain).toMatchObject({ status: 'OPEN', priority: 'NORMAL', source: 'USER' });
    // A subject needs its type, id and company.
    await expectPgError(insert(tenantA, { subjectType: 'organisation' }), '23514');
    await expectPgError(insert(tenantA, { subjectType: 'opportunity', subjectId: org.id }), '23514');
    await expectPgError(
      insert(tenantA, { subjectType: 'campaign', subjectId: org.id, organisationId: org.id }),
      '23514',
    );
    // DONE exactly when completed_at is set.
    await expectPgError(insert(tenantA, { status: 'DONE' }), '23514');
    await expectPgError(insert(tenantA, { completedAt: new Date() }), '23514');
    await expectPgError(insert(tenantA, { title: '  ' }), '23514');

    const key = `opportunity.won:${org.id}`;
    await insert(tenantA, { dedupeKey: key, source: 'SYSTEM' });
    await expectPgError(insert(tenantA, { dedupeKey: key }), UNIQUE_VIOLATION);
    // The same key is free in another tenant.
    await insert(tenantB, { dedupeKey: key });
  });

  it("never points at another tenant's company", async () => {
    const orgB = await createOrg(tenantB, { displayName: `Task B ${suffix}` });
    await expectPgError(insert(tenantA, { organisationId: orgB.id }), SQLSTATE.FOREIGN_KEY_VIOLATION);
  });

  it('cannot be deleted by the application', async () => {
    const row = await insert(tenantA, {});
    await expectPgError(
      inTenant(tenantA, (tx) => tx.delete(task).where(eq(task.id, row.id))),
      SQLSTATE.INSUFFICIENT_PRIVILEGE,
    );
  });
});

describe('brief', () => {
  const anyMember = async (tenantId: string) => {
    const [m] = await owner.db
      .select({ id: membership.id })
      .from(membership)
      .where(eq(membership.tenantId, tenantId))
      .limit(1);
    if (m) return m.id;
    const [u] = await owner.db
      .insert(appUser)
      .values({ email: `brief-${tenantId.slice(-6)}-${suffix}@example.com`, displayName: 'Buyer' })
      .returning({ id: appUser.id });
    const [created] = await owner.db
      .insert(membership)
      .values({ tenantId, userId: u!.id, status: 'ACTIVE' })
      .returning({ id: membership.id });
    return created!.id;
  };
  const insert = async (tenantId: string, values: Partial<typeof brief.$inferInsert>) => {
    const ownerMembershipId = await anyMember(tenantId);
    return inTenant(tenantId, (tx) =>
      tx
        .insert(brief)
        .values({ tenantId, title: 'Store openings', ownerMembershipId, ...values })
        .returning(),
    ).then((rows) => rows[0]!);
  };

  it('enforces the brief state rules in the database', async () => {
    const draft = await insert(tenantA, {});
    expect(draft).toMatchObject({ status: 'DRAFT', source: 'MANUAL', datesTbd: false, fieldProvenance: {} });
    await expectPgError(insert(tenantA, { status: 'CONFIRMED' }), '23514'); // needs confirmed_at
    await expectPgError(insert(tenantA, { status: 'DISCARDED' }), '23514'); // needs a reason
    await expectPgError(insert(tenantA, { discardReason: 'x' }), '23514'); // reason only when discarded
    await expectPgError(insert(tenantA, { source: 'OPPORTUNITY' }), '23514'); // needs the opportunity
    await expectPgError(
      insert(tenantA, { requestedStart: '2026-11-10', requestedEnd: '2026-11-01' }),
      '23514',
    );
    await expectPgError(insert(tenantA, { currency: 'USD' }), '23514');
  });

  it('keeps lines ordered and never mixes tenants', async () => {
    const draft = await insert(tenantA, {});
    const line = (values: Partial<typeof briefLine.$inferInsert>) =>
      inTenant(tenantA, (tx) =>
        tx
          .insert(briefLine)
          .values({ tenantId: tenantA, briefId: draft.id, position: 1, storeName: 'Sinaia', ...values }),
      );
    await line({});
    await expectPgError(line({ storeName: 'Duplicate position' }), UNIQUE_VIOLATION);
    await expectPgError(line({ position: 2, requestedUnits: 0 }), '23514');
    const orgB = await createOrg(tenantB, { displayName: `Brief B ${suffix}` });
    await expectPgError(insert(tenantA, { clientOrganisationId: orgB.id }), SQLSTATE.FOREIGN_KEY_VIOLATION);
    await expectPgError(
      inTenant(tenantA, (tx) => tx.delete(brief).where(eq(brief.id, draft.id))),
      SQLSTATE.INSUFFICIENT_PRIVILEGE,
    );
  });

  it('status history is append-only', async () => {
    const draft = await insert(tenantA, {});
    const [row] = await inTenant(tenantA, (tx) =>
      tx
        .insert(statusHistory)
        .values({
          tenantId: tenantA,
          subjectType: 'brief',
          subjectId: draft.id,
          toStatus: 'DRAFT',
          action: 'create',
          actorType: 'USER',
        })
        .returning(),
    );
    await expectPgError(
      inTenant(tenantA, (tx) =>
        tx.update(statusHistory).set({ reason: 'x' }).where(eq(statusHistory.id, row!.id)),
      ),
      SQLSTATE.INSUFFICIENT_PRIVILEGE,
    );
    await expectPgError(
      inTenant(tenantA, (tx) => tx.delete(statusHistory).where(eq(statusHistory.id, row!.id))),
      SQLSTATE.INSUFFICIENT_PRIVILEGE,
    );
  });
});

describe('campaign and location', () => {
  const member = async () => {
    const [m] = await owner.db
      .select({ id: membership.id })
      .from(membership)
      .where(eq(membership.tenantId, tenantA))
      .limit(1);
    return m!.id;
  };
  const newCampaign = async (values: Partial<typeof campaign.$inferInsert> = {}) => {
    const client = await createOrg(tenantA, { displayName: `Campaign client ${Math.random()}` });
    const ownerMembershipId = await member();
    return inTenant(tenantA, (tx) =>
      tx
        .insert(campaign)
        .values({
          tenantId: tenantA,
          code: `T-${Math.random().toString(36).slice(2, 10)}`,
          name: 'Openings',
          clientOrganisationId: client.id,
          ownerMembershipId,
          ...values,
        })
        .returning(),
    ).then((rows) => rows[0]!);
  };

  it('enforces campaign rules', async () => {
    const c = await newCampaign();
    expect(c.status).toBe('ACTIVE');
    await expectPgError(newCampaign({ code: c.code }), UNIQUE_VIOLATION);
    await expectPgError(newCampaign({ status: 'CANCELLED' }), '23514');
    await expectPgError(
      newCampaign({
        agencyOrganisationId: c.clientOrganisationId,
        clientOrganisationId: c.clientOrganisationId,
      }),
      '23514',
    );
  });

  it('enforces the location hold and cancel rules', async () => {
    const c = await newCampaign();
    const add = (values: Partial<typeof campaignLocation.$inferInsert>) =>
      inTenant(tenantA, (tx) =>
        tx
          .insert(campaignLocation)
          .values({ tenantId: tenantA, campaignId: c.id, name: 'Sinaia', ...values })
          .returning(),
      ).then((rows) => rows[0]!);
    expect((await add({})).status).toBe('DRAFT');
    await expectPgError(add({ status: 'ON_HOLD' }), '23514'); // must remember where to resume
    await expectPgError(add({ previousStatus: 'DRAFT' }), '23514'); // only while on hold
    await expectPgError(add({ status: 'ON_HOLD', previousStatus: 'CANCELLED' }), '23514');
    await add({ status: 'ON_HOLD', previousStatus: 'RESEARCH', holdReason: 'Client paused' });
    // Store pins: a point exactly when resolved or confirmed; confirmed needs its timestamp;
    // research and later need a confirmed pin.
    await expectPgError(add({ geocodeStatus: 'RESOLVED' }), '23514');
    await expectPgError(add({ storePoint: 'SRID=4326;POINT(25.55 45.35)' }), '23514');
    await expectPgError(
      add({ geocodeStatus: 'CONFIRMED', storePoint: 'SRID=4326;POINT(25.55 45.35)' }),
      '23514',
    );
    await expectPgError(add({ status: 'RESEARCH' }), '23514');
    await add({
      status: 'RESEARCH',
      geocodeStatus: 'CONFIRMED',
      storePoint: 'SRID=4326;POINT(25.55 45.35)',
      pinConfirmedAt: new Date(),
    });
    await expectPgError(add({ status: 'CANCELLED' }), '23514'); // needs a reason
    await expectPgError(add({ researchRadiusM: 10 }), '23514');
    await expectPgError(
      inTenant(tenantA, (tx) => tx.delete(campaign).where(eq(campaign.id, c.id))),
      SQLSTATE.INSUFFICIENT_PRIVILEGE,
    );
  });

  it('a converted brief points at its campaign', async () => {
    const c = await newCampaign();
    const ownerMembershipId = await member();
    const insert = (values: Partial<typeof brief.$inferInsert>) =>
      inTenant(tenantA, (tx) =>
        tx
          .insert(brief)
          .values({ tenantId: tenantA, title: 'B', ownerMembershipId, ...values })
          .returning(),
      );
    await expectPgError(insert({ status: 'CONVERTED', confirmedAt: new Date() }), '23514');
    await insert({
      status: 'CONVERTED',
      confirmedAt: new Date(),
      convertedCampaignId: c.id,
      convertedAt: new Date(),
    });
    const otherTenantCampaign = await createOrg(tenantB, { displayName: `X ${suffix}` });
    await expectPgError(
      insert({
        status: 'CONVERTED',
        confirmedAt: new Date(),
        convertedCampaignId: otherTenantCampaign.id,
        convertedAt: new Date(),
      }),
      SQLSTATE.FOREIGN_KEY_VIOLATION,
    );
  });
});
