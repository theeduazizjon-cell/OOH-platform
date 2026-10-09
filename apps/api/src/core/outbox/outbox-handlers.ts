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
export type OutboxHandler<P = unknown> = (
  tx: Transaction,
  event: OutboxMessage,
  prepared: P,
) => Promise<void>;

/**
 * Optional first phase, run OUTSIDE any transaction (e.g. a call to an external provider), so no
 * database transaction stays open while waiting on the network. Its result is passed to `handle`.
 */
export type OutboxPrepare<P> = (event: OutboxMessage) => Promise<P>;

export interface RegisteredHandler {
  readonly name: string;
  readonly prepare?: OutboxPrepare<unknown>;
  readonly handle: OutboxHandler<unknown>;
}

/** Event type → handlers. Modules register theirs on init; the dispatcher runs them in order. */
@Injectable()
export class OutboxHandlers {
  private readonly handlers = new Map<string, RegisteredHandler[]>();

  on(eventType: string, name: string, handle: OutboxHandler<undefined>): void;
  on<P>(eventType: string, name: string, handle: OutboxHandler<P>, prepare: OutboxPrepare<P>): void;
  on<P>(eventType: string, name: string, handle: OutboxHandler<P>, prepare?: OutboxPrepare<P>): void {
    const entry = { name, handle, ...(prepare ? { prepare } : {}) } as RegisteredHandler;
    this.handlers.set(eventType, [...(this.handlers.get(eventType) ?? []), entry]);
  }

  for(eventType: string): readonly RegisteredHandler[] {
    return this.handlers.get(eventType) ?? [];
  }
}
