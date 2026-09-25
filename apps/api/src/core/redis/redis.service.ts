import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { ENV } from '../../config/config.module';
import { type Env } from '../../config/env';

/** Shared Redis connection (queues, rate limiting, caches arrive in later milestones). */
@Injectable()
export class RedisService implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;
  private lastErrorLoggedAt = 0;

  constructor(@Inject(ENV) env: Env) {
    // Connect eagerly and reconnect in the background. With the offline queue disabled, commands
    // fail immediately while Redis is unreachable instead of waiting on reconnects, so callers
    // that degrade gracefully (login throttle, health) stay fast during an outage.
    this.client = new Redis(env.REDIS_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
    // Without a listener ioredis prints "Unhandled error event" on every reconnect attempt.
    this.client.on('error', (error: Error) => {
      if (Date.now() - this.lastErrorLoggedAt > 30_000) {
        this.lastErrorLoggedAt = Date.now();
        const code = (error as NodeJS.ErrnoException).code;
        this.logger.warn(`Redis error: ${error.message || code || error.name}`);
      }
    });
  }

  async ping(): Promise<{ response: string }> {
    return { response: await this.client.ping() };
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.client.status === 'ready') await this.client.quit();
    else this.client.disconnect();
  }
}
