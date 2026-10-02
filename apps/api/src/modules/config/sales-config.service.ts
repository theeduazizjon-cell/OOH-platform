import { Injectable } from '@nestjs/common';
import type {
  ActivityTypeItem,
  CreateActivityTypeRequest,
  CreateStageRequest,
  PipelineItem,
  PipelineStageItem,
  StageOrderRequest,
  UpdateActivityTypeRequest,
  UpdateStageRequest,
} from '@ooh/contracts';
import { activityType, opportunity, pipeline, pipelineStage, type Transaction } from '@ooh/db';
import { and, asc, count, desc, eq, sql } from 'drizzle-orm';
import { AuditService } from '../../core/audit/audit.service';
import { type Principal } from '../../core/auth/principal';
import { DatabaseService } from '../../core/database/database.service';
import { AppError } from '../../core/http/app-error';
import { type ClientInfo } from '../../core/http/client-info';
import { assertIfMatch, type IfMatch } from '../../core/http/concurrency';
import { configActor, freeKey } from './nomenclature';

const STAGE_COLUMNS = {
  id: pipelineStage.id,
  pipelineId: pipelineStage.pipelineId,
  name: pipelineStage.name,
  kind: pipelineStage.kind,
  position: pipelineStage.position,
  probability: pipelineStage.probability,
  active: pipelineStage.active,
  version: pipelineStage.version,
};
const TYPE_COLUMNS = {
  id: activityType.id,
  key: activityType.key,
  name: activityType.name,
  isSystem: activityType.isSystem,
  active: activityType.active,
  sortOrder: activityType.sortOrder,
  version: activityType.version,
};

type StageRow = PipelineStageItem & { pipelineId: string };
type Changes = Record<string, { from: unknown; to: unknown }>;

/**
 * Sales nomenclatures (Admin → Nomenclatures): pipelines with their stages, and activity types.
 * Stages and types are disabled rather than deleted, so history keeps its names. Each pipeline
 * keeps exactly one Won and one Lost stage (enforced in the database), always after the open ones.
 */
@Injectable()
export class SalesConfigService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  pipelines(principal: Principal): Promise<PipelineItem[]> {
    return this.inTenant(principal, (tx) => this.pipelinesIn(tx));
  }

  /** A new OPEN stage after the existing open ones (Won and Lost move along to stay last). */
  createStage(
    principal: Principal,
    pipelineId: string,
    input: CreateStageRequest,
    client: ClientInfo,
  ): Promise<PipelineStageItem> {
    return this.inTenant(principal, async (tx) => {
      await this.lockPipeline(tx, pipelineId);
      const stages = await this.stagesOf(tx, pipelineId);
      assertFreeName(stages, input.name);
      const open = stages.filter((s) => s.kind === 'OPEN');
      const [created] = await tx
        .insert(pipelineStage)
        .values({
          tenantId: principal.tenantId,
          pipelineId,
          name: input.name,
          kind: 'OPEN',
          position: open.length + 1,
          probability: input.probability ?? null,
        })
        .returning(STAGE_COLUMNS);
      await this.renumber(tx, pipelineId, [...open.map((s) => s.id), created!.id], stages);
      await this.audit.record(tx, {
        ...configActor(principal, client),
        action: 'config.stage_created',
        subjectType: 'pipeline_stage',
        subjectId: created!.id,
        metadata: { pipelineId, name: input.name },
      });
      return stageItem(created!);
    });
  }

  /**
   * Rename, default probability, enable/disable. An open stage can be disabled only when no
   * opportunity sits in it and another active open stage remains; Won and Lost never.
   */
  updateStage(
    principal: Principal,
    id: string,
    input: UpdateStageRequest,
    ifMatch: IfMatch,
    client: ClientInfo,
  ): Promise<PipelineStageItem> {
    return this.inTenant(principal, async (tx) => {
      const [current] = await tx
        .select(STAGE_COLUMNS)
        .from(pipelineStage)
        .where(eq(pipelineStage.id, id))
        .for('update');
      if (!current) throw new AppError('NOT_FOUND', 'Stage not found.');
      const stages = await this.stagesOf(tx, current.pipelineId);
      if (input.name !== undefined && input.name !== current.name) assertFreeName(stages, input.name, id);
      if (input.active === false && current.active) {
        if (current.kind !== 'OPEN') {
          throw new AppError('VALIDATION_FAILED', 'Won and Lost stages are part of every pipeline.', {
            errors: [{ path: 'active', message: 'Won and Lost stages cannot be disabled' }],
          });
        }
        if (!stages.some((s) => s.kind === 'OPEN' && s.active && s.id !== id)) {
          throw new AppError('CONFLICT', 'A pipeline needs at least one active open stage.');
        }
        const [row] = await tx
          .select({ value: count() })
          .from(opportunity)
          .where(eq(opportunity.pipelineStageId, id));
        const inStage = row?.value ?? 0;
        if (inStage > 0) {
          throw new AppError(
            'CONFLICT',
            `${inStage} open ${inStage === 1 ? 'opportunity is' : 'opportunities are'} in this stage. ` +
              'Move them to another stage first.',
          );
        }
      }
      assertIfMatch(ifMatch, current.version);

      const changes = diff(current, input, ['name', 'probability', 'active']);
      if (!changes) return stageItem(current);
      const [updated] = await tx
        .update(pipelineStage)
        .set({
          ...(changes.name ? { name: input.name } : {}),
          ...(changes.probability ? { probability: input.probability } : {}),
          ...(changes.active ? { active: input.active } : {}),
          version: sql`${pipelineStage.version} + 1`,
        })
        .where(eq(pipelineStage.id, id))
        .returning(STAGE_COLUMNS);
      await this.audit.record(tx, {
        ...configActor(principal, client),
        action: 'config.stage_updated',
        subjectType: 'pipeline_stage',
        subjectId: id,
        changes,
      });
      return stageItem(updated!);
    });
  }

  /** Reorders the OPEN stages (all of them, active or not); If-Match on the pipeline version. */
  reorderStages(
    principal: Principal,
    pipelineId: string,
    input: StageOrderRequest,
    ifMatch: IfMatch,
    client: ClientInfo,
  ): Promise<PipelineItem> {
    return this.inTenant(principal, async (tx) => {
      const current = await this.lockPipeline(tx, pipelineId);
      const stages = await this.stagesOf(tx, pipelineId);
      const open = stages.filter((s) => s.kind === 'OPEN');
      const openIds = new Set(open.map((s) => s.id));
      if (input.stageIds.length !== open.length || !input.stageIds.every((sid) => openIds.has(sid))) {
        throw new AppError('VALIDATION_FAILED', 'List every open stage of the pipeline exactly once.', {
          errors: [{ path: 'stageIds', message: 'Must contain exactly the open stages of this pipeline' }],
        });
      }
      assertIfMatch(ifMatch, current.version);

      const before = open.map((s) => s.id);
      if (before.join() !== input.stageIds.join()) {
        const name = (sid: string) => open.find((s) => s.id === sid)!.name;
        await this.renumber(tx, pipelineId, input.stageIds, stages);
        await tx
          .update(pipeline)
          .set({ version: sql`${pipeline.version} + 1` })
          .where(eq(pipeline.id, pipelineId));
        await this.audit.record(tx, {
          ...configActor(principal, client),
          action: 'config.stages_reordered',
          subjectType: 'pipeline',
          subjectId: pipelineId,
          changes: { stageOrder: { from: before.map(name), to: input.stageIds.map(name) } },
        });
      }
      return (await this.pipelinesIn(tx)).find((p) => p.id === pipelineId)!;
    });
  }

  activityTypes(principal: Principal): Promise<ActivityTypeItem[]> {
    return this.inTenant(principal, (tx) =>
      tx.select(TYPE_COLUMNS).from(activityType).orderBy(asc(activityType.sortOrder), asc(activityType.name)),
    );
  }

  createActivityType(
    principal: Principal,
    input: CreateActivityTypeRequest,
    client: ClientInfo,
  ): Promise<ActivityTypeItem> {
    return this.inTenant(principal, async (tx) => {
      const key = await freeKey(tx, activityType, activityType.key, input.name);
      const [created] = await tx
        .insert(activityType)
        .values({ tenantId: principal.tenantId, key, name: input.name, sortOrder: input.sortOrder ?? 1000 })
        .onConflictDoNothing({ target: [activityType.tenantId, activityType.key] })
        .returning(TYPE_COLUMNS);
      if (!created) throw new AppError('CONFLICT', 'An activity type with this name was just created.');
      await this.audit.record(tx, {
        ...configActor(principal, client),
        action: 'config.activity_type_created',
        subjectType: 'activity_type',
        subjectId: created.id,
        metadata: { key, name: input.name },
      });
      return created;
    });
  }

  /** Platform (system) types such as `stage_change` are read-only. */
  updateActivityType(
    principal: Principal,
    id: string,
    input: UpdateActivityTypeRequest,
    ifMatch: IfMatch,
    client: ClientInfo,
  ): Promise<ActivityTypeItem> {
    return this.inTenant(principal, async (tx) => {
      const [current] = await tx
        .select(TYPE_COLUMNS)
        .from(activityType)
        .where(eq(activityType.id, id))
        .for('update');
      if (!current) throw new AppError('NOT_FOUND', 'Activity type not found.');
      if (current.isSystem) {
        throw new AppError('CONFLICT', 'This type is written by the platform and cannot be changed.');
      }
      assertIfMatch(ifMatch, current.version);

      const changes = diff(current, input, ['name', 'sortOrder', 'active']);
      if (!changes) return current;
      const [updated] = await tx
        .update(activityType)
        .set({
          ...(changes.name ? { name: input.name } : {}),
          ...(changes.sortOrder ? { sortOrder: input.sortOrder } : {}),
          ...(changes.active ? { active: input.active } : {}),
          version: sql`${activityType.version} + 1`,
        })
        .where(eq(activityType.id, id))
        .returning(TYPE_COLUMNS);
      await this.audit.record(tx, {
        ...configActor(principal, client),
        action: 'config.activity_type_updated',
        subjectType: 'activity_type',
        subjectId: id,
        changes,
      });
      return updated!;
    });
  }

  private inTenant<T>(principal: Principal, fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.database.withTenant({ tenantId: principal.tenantId, actorUserId: principal.userId }, fn);
  }

  private async pipelinesIn(tx: Transaction): Promise<PipelineItem[]> {
    const pipelines = await tx
      .select({
        id: pipeline.id,
        name: pipeline.name,
        isDefault: pipeline.isDefault,
        active: pipeline.active,
        version: pipeline.version,
      })
      .from(pipeline)
      .orderBy(desc(pipeline.isDefault), asc(pipeline.name));
    const stages = await tx
      .select(STAGE_COLUMNS)
      .from(pipelineStage)
      .orderBy(asc(pipelineStage.position), asc(pipelineStage.name));
    return pipelines.map((p) => ({
      ...p,
      stages: stages.filter((s) => s.pipelineId === p.id).map(stageItem),
    }));
  }

  private async lockPipeline(tx: Transaction, pipelineId: string): Promise<{ version: number }> {
    const [row] = await tx
      .select({ version: pipeline.version })
      .from(pipeline)
      .where(eq(pipeline.id, pipelineId))
      .for('update');
    if (!row) throw new AppError('NOT_FOUND', 'Pipeline not found.');
    return row;
  }

  private stagesOf(tx: Transaction, pipelineId: string): Promise<StageRow[]> {
    return tx
      .select(STAGE_COLUMNS)
      .from(pipelineStage)
      .where(eq(pipelineStage.pipelineId, pipelineId))
      .orderBy(asc(pipelineStage.position), asc(pipelineStage.name));
  }

  /** Positions 1…n for the open stages in the given order, then Won, then Lost. */
  private async renumber(
    tx: Transaction,
    pipelineId: string,
    openIds: readonly string[],
    stages: readonly StageRow[],
  ): Promise<void> {
    const order = [
      ...openIds,
      ...stages.filter((s) => s.kind === 'WON').map((s) => s.id),
      ...stages.filter((s) => s.kind === 'LOST').map((s) => s.id),
    ];
    for (const [index, stageId] of order.entries()) {
      await tx
        .update(pipelineStage)
        .set({ position: index + 1 })
        .where(and(eq(pipelineStage.pipelineId, pipelineId), eq(pipelineStage.id, stageId)));
    }
  }
}

function stageItem({ pipelineId: _, ...stage }: StageRow): PipelineStageItem {
  return stage;
}

/** Stage names are unique within a pipeline, ignoring case. */
function assertFreeName(stages: readonly StageRow[], name: string, exceptId?: string): void {
  if (stages.some((s) => s.id !== exceptId && s.name.toLowerCase() === name.toLowerCase())) {
    throw new AppError('CONFLICT', `This pipeline already has a stage called "${name}".`);
  }
}

/** The fields the request actually changes, or null when nothing changes. */
function diff<T extends object, K extends keyof T & string>(
  current: T,
  input: Partial<Record<K, unknown>>,
  fields: readonly K[],
): Changes | null {
  const changes: Changes = {};
  for (const field of fields) {
    if (input[field] !== undefined && input[field] !== current[field])
      changes[field] = { from: current[field], to: input[field] };
  }
  return Object.keys(changes).length > 0 ? changes : null;
}
