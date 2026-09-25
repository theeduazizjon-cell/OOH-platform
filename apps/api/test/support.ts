import type { ThrottleStore } from '../src/core/auth/login-throttle';

/** In-memory ThrottleStore for tests (no Redis). */
export class MemoryThrottleStore implements ThrottleStore {
  readonly counts = new Map<string, number>();

  increment(key: string): Promise<number> {
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return Promise.resolve(next);
  }

  read(key: string): Promise<number> {
    return Promise.resolve(this.counts.get(key) ?? 0);
  }

  reset(key: string): Promise<void> {
    this.counts.delete(key);
    return Promise.resolve();
  }
}
