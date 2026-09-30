import { Injectable } from '@nestjs/common';
import type { ActivityTypeItem, PipelineItem } from '@ooh/contracts';
import { activityType, pipeline, pipelineStage } from '@ooh/db';
import { asc, desc } from 'drizzle-orm';
import { type Principal } from '../../core/auth/principal';
import { DatabaseService } from '../../core/database/database.service';

/** Sales nomenclatures: pipelines with their stages, and activity types (read side). */
@Injectable()
export class SalesConfigService {
  constructor(private readonly database: DatabaseService) {}

  pipelines(principal: Principal): Promise<PipelineItem[]> {
    return this.database.withTenant(
      { tenantId: principal.tenantId, actorUserId: principal.userId },
      async (tx) => {
        const pipelines = await tx
          .select({
            id: pipeline.id,
            name: pipeline.name,
            isDefault: pipeline.isDefault,
            active: pipeline.active,
          })
          .from(pipeline)
          .orderBy(desc(pipeline.isDefault), asc(pipeline.name));
        const stages = await tx
          .select({
            id: pipelineStage.id,
            pipelineId: pipelineStage.pipelineId,
            name: pipelineStage.name,
            kind: pipelineStage.kind,
            position: pipelineStage.position,
            probability: pipelineStage.probability,
            active: pipelineStage.active,
          })
          .from(pipelineStage)
          .orderBy(asc(pipelineStage.position), asc(pipelineStage.name));
        return pipelines.map((p) => ({
          ...p,
          stages: stages.filter((s) => s.pipelineId === p.id).map(({ pipelineId: _, ...stage }) => stage),
        }));
      },
    );
  }

  activityTypes(principal: Principal): Promise<ActivityTypeItem[]> {
    return this.database.withTenant({ tenantId: principal.tenantId, actorUserId: principal.userId }, (tx) =>
      tx
        .select({
          id: activityType.id,
          key: activityType.key,
          name: activityType.name,
          isSystem: activityType.isSystem,
          active: activityType.active,
        })
        .from(activityType)
        .orderBy(asc(activityType.sortOrder), asc(activityType.name)),
    );
  }
}
