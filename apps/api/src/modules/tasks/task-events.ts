import { Injectable, type OnModuleInit } from '@nestjs/common';
import { locationResearchTaskKey, wonOpportunityTaskKey } from '@ooh/contracts';
import { brief, briefLine, campaign, campaignLocation, opportunity, tenant, type Transaction } from '@ooh/db';
import { eq } from 'drizzle-orm';
import { systemActor } from '../../core/audit/actor';
import { type OutboxMessage, OutboxHandlers } from '../../core/outbox/outbox-handlers';
import { atLocalTime } from '../../core/time/zoned';
import { TasksService } from './tasks.service';

/** The "Create brief" task after a win is due two days later (OPD-28). */
export const CREATE_BRIEF_DUE_MS = 2 * 24 * 60 * 60 * 1000;
/** Date-only deadlines become due at this local hour. */
export const END_OF_WORKING_DAY = 17;

const str = (payload: Record<string, unknown>, key: string): string => {
  const value = payload[key];
  if (typeof value !== 'string') throw new Error(`Event payload is missing ${key}`);
  return value;
};

/**
 * Tasks the platform creates from events (outbox handlers; idempotent through dedupe keys):
 * - opportunity.won → "Create brief: {deal}" for the owner (06-state-machines.md §2, OPD-28);
 * - campaign_location.created → "Research {store}" for the buyer, due on the brief's deadline (A5).
 */
@Injectable()
export class TaskEvents implements OnModuleInit {
  constructor(
    private readonly handlers: OutboxHandlers,
    private readonly tasks: TasksService,
  ) {}

  onModuleInit(): void {
    this.handlers.on('opportunity.won', 'tasks.create-brief', (tx, event) => this.createBrief(tx, event));
    this.handlers.on('campaign_location.created', 'tasks.research', (tx, event) => this.research(tx, event));
  }

  async createBrief(tx: Transaction, event: OutboxMessage): Promise<void> {
    const opportunityId = str(event.payload, 'opportunityId');
    const [deal] = await tx
      .select({
        stageKind: opportunity.stageKind,
        name: opportunity.name,
        ownerId: opportunity.ownerMembershipId,
      })
      .from(opportunity)
      .where(eq(opportunity.id, opportunityId));
    // Reopened before the worker got here: no brief to create.
    if (deal?.stageKind !== 'WON') return;
    const value = event.payload.estimatedValue;
    const currency = event.payload.currency;
    await this.tasks.createSystemTask(tx, systemActor(event.tenantId), {
      dedupeKey: wonOpportunityTaskKey(opportunityId),
      title: `Create brief: ${deal.name}`,
      notes:
        typeof value === 'string' && typeof currency === 'string'
          ? `Won for ${value} ${currency}. Capture the client's request as a brief.`
          : "Capture the client's request as a brief.",
      organisationId: str(event.payload, 'organisationId'),
      subject: { type: 'opportunity', id: opportunityId },
      assigneeMembershipId: deal.ownerId,
      dueAt: new Date(event.occurredAt.getTime() + CREATE_BRIEF_DUE_MS),
      createdByMembershipId: (event.payload.actorMembershipId as string | undefined) ?? null,
    });
  }

  async research(tx: Transaction, event: OutboxMessage): Promise<void> {
    const locationId = str(event.payload, 'campaign_locationId');
    const [row] = await tx
      .select({
        name: campaignLocation.name,
        status: campaignLocation.status,
        buyerId: campaignLocation.buyerMembershipId,
        campaignId: campaign.id,
        clientId: campaign.clientOrganisationId,
        ownerId: campaign.ownerMembershipId,
        deadline: brief.deadline,
        timezone: tenant.timezone,
      })
      .from(campaignLocation)
      .innerJoin(campaign, eq(campaign.id, campaignLocation.campaignId))
      .leftJoin(briefLine, eq(briefLine.id, campaignLocation.briefLineId))
      .leftJoin(brief, eq(brief.id, briefLine.briefId))
      .innerJoin(tenant, eq(tenant.id, campaignLocation.tenantId))
      .where(eq(campaignLocation.id, locationId));
    if (!row || row.status === 'CANCELLED' || row.status === 'COMPLETED') return;
    await this.tasks.createSystemTask(tx, systemActor(event.tenantId), {
      dedupeKey: locationResearchTaskKey(locationId),
      title: `Research ${row.name}`,
      notes: 'Find candidate positions around the store.',
      organisationId: row.clientId,
      campaignId: row.campaignId,
      subject: { type: 'campaign_location', id: locationId },
      assigneeMembershipId: row.buyerId ?? row.ownerId,
      // The brief's "reply needed by" date, at the end of the working day in the company's time zone.
      dueAt: row.deadline ? atLocalTime(row.deadline, END_OF_WORKING_DAY, row.timezone) : null,
      createdByMembershipId: (event.payload.actorMembershipId as string | undefined) ?? null,
    });
  }
}
