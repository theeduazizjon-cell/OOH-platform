import { Injectable } from '@nestjs/common';
import { statusHistory, type Transaction } from '@ooh/db';
import { AuditService } from '../audit/audit.service';
import { type Principal } from '../auth/principal';
import { type ClientInfo } from '../http/client-info';
import { OutboxService } from './outbox.service';

export interface TransitionRecord {
  subjectType: string;
  subjectId: string;
  /** null when the subject is created. */
  from: string | null;
  to: string;
  /** The state machine action, e.g. `confirm`. */
  action: string;
  /** Audit verb and outbox event type, e.g. `brief.confirmed`. */
  event: string;
  reason?: string;
  changes?: Record<string, { from: unknown; to: unknown }>;
  /** Outbox payload (subject id and tenant are always included). */
  payload?: Record<string, unknown>;
}

/**
 * The write side of every state change (06-state-machines.md "Implementation pattern"):
 * status_history + audit_event + outbox_event, in the caller's transaction.
 */
@Injectable()
export class TransitionsService {
  constructor(
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async record(
    tx: Transaction,
    principal: Principal,
    client: ClientInfo,
    input: TransitionRecord,
  ): Promise<void> {
    await tx.insert(statusHistory).values({
      tenantId: principal.tenantId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      fromStatus: input.from,
      toStatus: input.to,
      action: input.action,
      actorType: 'USER',
      actorMembershipId: principal.membershipId,
      reason: input.reason ?? null,
    });
    await this.audit.record(tx, {
      tenantId: principal.tenantId,
      actorType: 'USER',
      actorUserId: principal.userId,
      actorMembershipId: principal.membershipId,
      action: input.event,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      changes: { status: { from: input.from, to: input.to }, ...input.changes },
      ...(input.reason ? { metadata: { reason: input.reason } } : {}),
      client,
    });
    await this.outbox.publish(tx, principal.tenantId, input.event, {
      [`${input.subjectType}Id`]: input.subjectId,
      from: input.from,
      to: input.to,
      actorMembershipId: principal.membershipId,
      ...input.payload,
    });
  }
}
