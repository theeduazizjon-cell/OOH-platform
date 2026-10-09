import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { outboxEvent } from '@ooh/db';
import { eq, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { type OutboxMessage, OutboxHandlers } from './outbox-handlers';

/** Retries back off exponentially up to an hour; after MAX_ATTEMPTS the event is parked (failed_at). */
export const MAX_ATTEMPTS = 10;
export function backoffSeconds(attempts: number): number {
  return Math.min(3600, 5 * 2 ** Math.max(0, attempts - 1));
}

const LEASE_SECONDS = 60;
const BATCH = 50;
const IDLE_POLL_MS = 1000;

/**
 * The outbox dispatcher (08-system-architecture.md): leases pending events across tenants through
 * `outbox_claim` (migration 0023), then runs each event's handlers in its tenant's transaction and
 * marks it dispatched in that same transaction, so a handler's writes and the "done" mark commit
 * together. Runs in the worker process only (src/worker.ts); the API just writes events.
 */
@Injectable()
export class OutboxDispatcher implements OnApplicationShutdown {
  private readonly logger = new Logger(OutboxDispatcher.name);
  private running = false;
  private loop: Promise<void> | null = null;

  constructor(
    private readonly database: DatabaseService,
    private readonly handlers: OutboxHandlers,
  ) {}

  /** One pass: claims up to `limit` due events and handles them. Returns how many it processed. */
  async runOnce(limit = BATCH): Promise<number> {
    const claimed = await this.database.withoutContext(async (tx) => {
      const rows = await tx.execute<{
        id: string;
        tenant_id: string;
        event_type: string;
        payload: Record<string, unknown>;
        attempts: number;
        occurred_at: string | Date;
      }>(sql`SELECT * FROM outbox_claim(${limit}, ${LEASE_SECONDS})`);
      return [...rows];
    });
    for (const row of claimed) {
      await this.handle({
        id: row.id,
        tenantId: row.tenant_id,
        eventType: row.event_type,
        payload: row.payload,
        attempts: row.attempts,
        occurredAt: new Date(row.occurred_at),
      });
    }
    return claimed.length;
  }

  /** Polls until stopped; drains quickly while there is work, then idles. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        let processed = 0;
        try {
          processed = await this.runOnce();
        } catch (error) {
          this.logger.error(`Outbox pass failed: ${String(error)}`);
        }
        if (processed === 0 && this.running) await new Promise((r) => setTimeout(r, IDLE_POLL_MS));
      }
    })();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
    this.loop = null;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  private async handle(event: OutboxMessage): Promise<void> {
    const context = { tenantId: event.tenantId, actorUserId: null };
    try {
      await this.database.withTenant(context, async (tx) => {
        for (const handler of this.handlers.for(event.eventType)) await handler.handle(tx, event);
        await tx
          .update(outboxEvent)
          .set({ dispatchedAt: sql`now()`, lockedUntil: null })
          .where(eq(outboxEvent.id, event.id));
      });
    } catch (error) {
      const attempts = event.attempts + 1;
      const message = error instanceof Error ? error.message : String(error);
      const giveUp = attempts >= MAX_ATTEMPTS;
      this.logger[giveUp ? 'error' : 'warn'](
        `Outbox event ${event.eventType} ${event.id} failed (attempt ${attempts}${giveUp ? ', giving up' : ''}): ${message}`,
      );
      await this.database.withTenant(context, (tx) =>
        tx
          .update(outboxEvent)
          .set({
            attempts,
            lastError: message.slice(0, 2000),
            lockedUntil: null,
            nextAttemptAt: sql`now() + make_interval(secs => ${backoffSeconds(attempts)})`,
            ...(giveUp ? { failedAt: sql`now()` } : {}),
          })
          .where(eq(outboxEvent.id, event.id)),
      );
    }
  }
}
