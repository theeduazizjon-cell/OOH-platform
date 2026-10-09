import { Injectable } from '@nestjs/common';
import { type Transaction } from '@ooh/db';

/** An event as the worker hands it to handlers. */
export interface OutboxMessage {
  readonly id: string;
  readonly tenantId: string;
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
  readonly attempts: number;
  readonly occurredAt: Date;
}

/**
 * Runs inside the event's tenant transaction (RLS applies). Must be idempotent: an event can be
 * delivered again after a crash or a failure of another handler of the same event.
 */
export type OutboxHandler = (tx: Transaction, event: OutboxMessage) => Promise<void>;

/** Event type → handlers. Modules register theirs on init; the dispatcher runs them in order. */
@Injectable()
export class OutboxHandlers {
  private readonly handlers = new Map<string, { name: string; handle: OutboxHandler }[]>();

  on(eventType: string, name: string, handle: OutboxHandler): void {
    this.handlers.set(eventType, [...(this.handlers.get(eventType) ?? []), { name, handle }]);
  }

  for(eventType: string): readonly { name: string; handle: OutboxHandler }[] {
    return this.handlers.get(eventType) ?? [];
  }
}
