import { Injectable } from '@nestjs/common';
import { outboxEvent, type Transaction } from '@ooh/db';

/**
 * Transactional outbox (08-system-architecture.md): events are written in the business transaction
 * and dispatched by the worker (M3c), so side effects never roll back a business action.
 */
@Injectable()
export class OutboxService {
  async publish(
    tx: Transaction,
    tenantId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await tx.insert(outboxEvent).values({ tenantId, eventType, payload });
  }
}
