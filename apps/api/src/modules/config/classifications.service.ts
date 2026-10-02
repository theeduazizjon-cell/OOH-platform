import { Injectable } from '@nestjs/common';
import type {
  ClassificationItem,
  CreateClassificationRequest,
  Page,
  UpdateClassificationRequest,
} from '@ooh/contracts';
import { organisationClassification, type Transaction } from '@ooh/db';
import { asc, eq, sql } from 'drizzle-orm';
import { AuditService } from '../../core/audit/audit.service';
import { type Principal } from '../../core/auth/principal';
import { DatabaseService } from '../../core/database/database.service';
import { AppError } from '../../core/http/app-error';
import { type ClientInfo } from '../../core/http/client-info';
import { assertIfMatch, type IfMatch } from '../../core/http/concurrency';
import { configActor, freeKey } from './nomenclature';

const COLUMNS = {
  id: organisationClassification.id,
  key: organisationClassification.key,
  name: organisationClassification.name,
  active: organisationClassification.active,
  sortOrder: organisationClassification.sortOrder,
  version: organisationClassification.version,
};

/**
 * Organisation classifications (Admin → Nomenclatures). Disabled rather than deleted: companies
 * keep their existing classifications, the disabled ones are just no longer offered.
 */
@Injectable()
export class ClassificationsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  list(principal: Principal): Promise<Page<ClassificationItem>> {
    return this.inTenant(principal, async (tx) => ({
      data: await tx
        .select(COLUMNS)
        .from(organisationClassification)
        .orderBy(asc(organisationClassification.sortOrder), asc(organisationClassification.name)),
      page: { nextCursor: null, hasMore: false },
    }));
  }

  create(
    principal: Principal,
    input: CreateClassificationRequest,
    client: ClientInfo,
  ): Promise<ClassificationItem> {
    return this.inTenant(principal, async (tx) => {
      const key = await freeKey(tx, organisationClassification, organisationClassification.key, input.name);
      const [created] = await tx
        .insert(organisationClassification)
        .values({ tenantId: principal.tenantId, key, name: input.name, sortOrder: input.sortOrder ?? 1000 })
        .onConflictDoNothing({
          target: [organisationClassification.tenantId, organisationClassification.key],
        })
        .returning(COLUMNS);
      if (!created) throw new AppError('CONFLICT', 'A classification with this name was just created.');
      await this.audit.record(tx, {
        ...configActor(principal, client),
        action: 'config.classification_created',
        subjectType: 'organisation_classification',
        subjectId: created.id,
        metadata: { key, name: input.name },
      });
      return created;
    });
  }

  update(
    principal: Principal,
    id: string,
    input: UpdateClassificationRequest,
    ifMatch: IfMatch,
    client: ClientInfo,
  ): Promise<ClassificationItem> {
    return this.inTenant(principal, async (tx) => {
      const [current] = await tx
        .select(COLUMNS)
        .from(organisationClassification)
        .where(eq(organisationClassification.id, id))
        .for('update');
      if (!current) throw new AppError('NOT_FOUND', 'Classification not found.');
      assertIfMatch(ifMatch, current.version);

      const changes: Record<string, { from: unknown; to: unknown }> = {};
      for (const field of ['name', 'sortOrder', 'active'] as const) {
        if (input[field] !== undefined && input[field] !== current[field])
          changes[field] = { from: current[field], to: input[field] };
      }
      if (Object.keys(changes).length === 0) return current;

      const [updated] = await tx
        .update(organisationClassification)
        .set({
          ...(changes.name ? { name: input.name } : {}),
          ...(changes.sortOrder ? { sortOrder: input.sortOrder } : {}),
          ...(changes.active ? { active: input.active } : {}),
          version: sql`${organisationClassification.version} + 1`,
        })
        .where(eq(organisationClassification.id, id))
        .returning(COLUMNS);
      await this.audit.record(tx, {
        ...configActor(principal, client),
        action: 'config.classification_updated',
        subjectType: 'organisation_classification',
        subjectId: id,
        changes,
      });
      return updated!;
    });
  }

  private inTenant<T>(principal: Principal, fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.database.withTenant({ tenantId: principal.tenantId, actorUserId: principal.userId }, fn);
  }
}
