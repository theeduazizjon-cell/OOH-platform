import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { AppError } from '../http/app-error';

export const THROTTLE_STORE = Symbol('THROTTLE_STORE');

export interface ThrottleStore {
  /** Increments a counter, starting its window on first increment; returns the new value. */
  increment(key: string, windowSeconds: number): Promise<number>;
  read(key: string): Promise<number>;
  reset(key: string): Promise<void>;
}

@Injectable()
export class RedisThrottleStore implements ThrottleStore {
  constructor(private readonly redis: RedisService) {}

  async increment(key: string, windowSeconds: number): Promise<number> {
    const results = await this.redis.client.multi().incr(key).expire(key, windowSeconds, 'NX').exec();
    return Number(results?.[0]?.[1] ?? 0);
  }

  async read(key: string): Promise<number> {
    return Number((await this.redis.client.get(key)) ?? 0);
  }

  async reset(key: string): Promise<void> {
    await this.redis.client.del(key);
  }
}

const WINDOW_SECONDS = 15 * 60;
const MAX_FAILURES_PER_ACCOUNT = 5;
const MAX_FAILURES_PER_IP = 50;

/**
 * Brute-force protection for login: after 5 failed attempts for one email (or 50 from one IP)
 * within 15 minutes, further attempts get 429 until the window expires. Fails OPEN if Redis is
 * unavailable (logged), trading brute-force resistance for availability during an outage.
 */
@Injectable()
export class LoginThrottle {
  private readonly logger = new Logger(LoginThrottle.name);

  constructor(@Inject(THROTTLE_STORE) private readonly store: ThrottleStore) {}

  async assertAllowed(email: string, ip: string): Promise<void> {
    const [account, address] = (await this.safely(() =>
      Promise.all([this.store.read(this.accountKey(email)), this.store.read(this.ipKey(ip))]),
    )) ?? [0, 0];
    if (account >= MAX_FAILURES_PER_ACCOUNT || address >= MAX_FAILURES_PER_IP) {
      throw new AppError('RATE_LIMITED', 'Too many failed sign-in attempts. Try again later.', {
        meta: { retryAfterSeconds: WINDOW_SECONDS },
      });
    }
  }

  async recordFailure(email: string, ip: string): Promise<void> {
    await this.safely(() =>
      Promise.all([
        this.store.increment(this.accountKey(email), WINDOW_SECONDS),
        this.store.increment(this.ipKey(ip), WINDOW_SECONDS),
      ]),
    );
  }

  async recordSuccess(email: string): Promise<void> {
    await this.safely(() => this.store.reset(this.accountKey(email)));
  }

  private accountKey(email: string): string {
    return `login:fail:acct:${createHash('sha256').update(email.trim().toLowerCase()).digest('hex')}`;
  }

  private ipKey(ip: string): string {
    return `login:fail:ip:${ip}`;
  }

  private async safely<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (error) {
      this.logger.warn(`Login throttle unavailable, allowing request: ${String(error)}`);
      return undefined;
    }
  }
}
