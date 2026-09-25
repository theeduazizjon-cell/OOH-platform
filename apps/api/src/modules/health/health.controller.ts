import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ENV } from '../../config/config.module';
import { type Env } from '../../config/env';
import { DatabaseService } from '../../core/database/database.service';
import { RedisService } from '../../core/redis/redis.service';

const PROBE_TIMEOUT_MS = 2_000;

type Probe =
  | { status: 'up'; latencyMs: number; details?: Record<string, string> }
  | { status: 'down'; latencyMs: number; error?: string };

export interface HealthReport {
  status: 'ok' | 'degraded';
  checks: { database: Probe; redis: Probe };
}

/** Liveness/readiness endpoint for local dev, load balancers and deploy checks. Public. */
@Controller('health')
export class HealthController {
  constructor(
    private readonly database: DatabaseService,
    private readonly redis: RedisService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get()
  async check(@Res({ passthrough: true }) reply: FastifyReply): Promise<HealthReport> {
    const [database, redis] = await Promise.all([
      this.probe(async () => ({ postgis: (await this.database.ping()).postgis })),
      this.probe(async () => ({ ping: (await this.redis.ping()).response })),
    ]);
    const healthy = database.status === 'up' && redis.status === 'up';
    void reply.status(healthy ? 200 : 503);
    return { status: healthy ? 'ok' : 'degraded', checks: { database, redis } };
  }

  private async probe(run: () => Promise<Record<string, string>>): Promise<Probe> {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${PROBE_TIMEOUT_MS} ms`)),
          PROBE_TIMEOUT_MS,
        );
      });
      const details = await Promise.race([run(), timeout]);
      return { status: 'up', latencyMs: elapsed(), details };
    } catch (error) {
      // Internal error text is useful locally but should not be published by production.
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: 'down',
        latencyMs: elapsed(),
        ...(this.env.NODE_ENV === 'production' ? {} : { error: message }),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
