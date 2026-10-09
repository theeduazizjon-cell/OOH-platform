import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { locationPinTaskKey } from '@ooh/contracts';
import { campaign, campaignLocation, type Transaction } from '@ooh/db';
import { eq } from 'drizzle-orm';
import { systemActor } from '../../core/audit/actor';
import { AuditService } from '../../core/audit/audit.service';
import {
  GEO_PROVIDER,
  type GeocodeResult,
  geocodeQuery,
  type GeoProvider,
} from '../../core/geo/geo-provider';
import { type OutboxMessage, OutboxHandlers } from '../../core/outbox/outbox-handlers';
import { TasksService } from '../tasks/tasks.service';

/** Only "Romania": nothing to look up. */
const EMPTY_QUERY = geocodeQuery({ address: null, city: null, county: null });

/**
 * Store geocoding (04-user-flows.md A6), from the outbox: the provider is called in the handler's
 * prepare phase (outside any transaction), then the result is stored if the location still waits for
 * exactly that address. AMBIGUOUS or FAILED creates "Confirm store pin" for the buyer. A transient
 * provider error throws, and the outbox retries with backoff.
 */
@Injectable()
export class LocationEvents implements OnModuleInit {
  constructor(
    private readonly handlers: OutboxHandlers,
    @Inject(GEO_PROVIDER) private readonly geo: GeoProvider,
    private readonly tasks: TasksService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    for (const eventType of ['campaign_location.created', 'campaign_location.address_changed']) {
      this.handlers.on<GeocodeResult>(
        eventType,
        'campaigns.geocode',
        (tx, event, result) => this.store(tx, event, result),
        (event) => this.lookUp(event),
      );
    }
  }

  lookUp(event: OutboxMessage): Promise<GeocodeResult> {
    const query = event.payload.geocodeQuery;
    if (typeof query !== 'string' || query === EMPTY_QUERY) {
      return Promise.resolve({ kind: 'failed', reason: 'No address to look up; place the pin by hand.' });
    }
    return this.geo.geocode(query);
  }

  async store(tx: Transaction, event: OutboxMessage, result: GeocodeResult): Promise<void> {
    const locationId = event.payload.campaign_locationId;
    if (typeof locationId !== 'string') return;
    const [row] = await tx
      .select({
        location: campaignLocation,
        clientId: campaign.clientOrganisationId,
        ownerId: campaign.ownerMembershipId,
      })
      .from(campaignLocation)
      .innerJoin(campaign, eq(campaign.id, campaignLocation.campaignId))
      .where(eq(campaignLocation.id, locationId))
      .for('update', { of: campaignLocation });
    // Stale: the pin was placed by hand, the address changed again, or the location is closed.
    if (
      !row ||
      row.location.geocodeStatus !== 'PENDING' ||
      geocodeQuery(row.location) !== event.payload.geocodeQuery ||
      row.location.status === 'CANCELLED' ||
      row.location.status === 'COMPLETED'
    )
      return;
    const l = row.location;
    const update =
      result.kind === 'resolved'
        ? {
            geocodeStatus: 'RESOLVED' as const,
            storePoint: `SRID=4326;POINT(${result.candidate.lng} ${result.candidate.lat})`,
            placeId: result.candidate.placeId,
            geocodedAddress: result.candidate.formattedAddress,
            geocodeError: null,
          }
        : result.kind === 'ambiguous'
          ? {
              geocodeStatus: 'AMBIGUOUS' as const,
              geocodedAddress: result.candidates
                .slice(0, 3)
                .map((c) => c.formattedAddress)
                .join(' | '),
              geocodeError: `${result.candidates.length} possible matches; place the pin.`,
            }
          : { geocodeStatus: 'FAILED' as const, geocodeError: result.reason };
    await tx.update(campaignLocation).set(update).where(eq(campaignLocation.id, l.id));
    const by = systemActor(event.tenantId);
    await this.audit.record(tx, {
      ...by,
      action: 'campaign_location.geocoded',
      subjectType: 'campaign_location',
      subjectId: l.id,
      changes: { geocodeStatus: { from: 'PENDING', to: update.geocodeStatus } },
    });
    if (result.kind !== 'resolved') {
      await this.tasks.createSystemTask(tx, by, {
        dedupeKey: locationPinTaskKey(l.id),
        title: `Confirm store pin: ${l.name}`,
        notes: update.geocodeError ?? undefined,
        organisationId: row.clientId,
        campaignId: l.campaignId,
        subject: { type: 'campaign_location', id: l.id },
        assigneeMembershipId: l.buyerMembershipId ?? row.ownerId,
        createdByMembershipId: (event.payload.actorMembershipId as string | undefined) ?? null,
      });
    }
  }
}
