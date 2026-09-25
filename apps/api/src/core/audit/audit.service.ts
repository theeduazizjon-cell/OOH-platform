import { Injectable } from '@nestjs/common';
import { auditEvent, type Transaction } from '@ooh/db';
import { DatabaseService } from '../database/database.service';
import { type ClientInfo } from '../http/client-info';

export interface AuditInput {
  readonly tenantId: string | null;
  readonly actorType: 'USER' | 'SYSTEM' | 'AI' | 'API';
  readonly actorUserId?: string | null;
  readonly actorMembershipId?: string | null;
  /** Dotted verb, e.g. `auth.login`. */
  readonly action: string;
  readonly subjectType?: string;
  readonly subjectId?: string;
  readonly changes?: Record<string, { from: unknown; to: unknown }>;
  readonly metadata?: Record<string, unknown>;
  readonly client?: ClientInfo;
}

/** Writes to the append-only audit trail [R§40]. */
@Injectable()
export class AuditService {
  constructor(private readonly database: DatabaseService) {}

  /** Records inside the caller's transaction, so the event commits or rolls back with the change. */
  async record(tx: Transaction, input: AuditInput): Promise<void> {
    await tx.insert(auditEvent).values({
      tenantId: input.tenantId,
      actorType: input.actorType,
      actorUserId: input.actorUserId ?? null,
      actorMembershipId: input.actorMembershipId ?? null,
      action: input.action,
      subjectType: input.subjectType ?? null,
      subjectId: input.subjectId ?? null,
      changes: input.changes ?? null,
      metadata: input.metadata ?? null,
      requestId: input.client?.requestId ?? null,
      ip: input.client?.ip ?? null,
      userAgent: input.client?.userAgent ?? null,
    });
  }

  /** Pre-tenant events (e.g. failed logins): stored with tenant_id NULL, readable by the platform only. */
  recordWithoutTenant(input: Omit<AuditInput, 'tenantId'>): Promise<void> {
    return this.database.withoutContext((tx) => this.record(tx, { ...input, tenantId: null }));
  }
}
