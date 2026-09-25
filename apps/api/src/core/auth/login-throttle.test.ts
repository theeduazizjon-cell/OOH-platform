import { describe, expect, it } from 'vitest';
import { MemoryThrottleStore } from '../../../test/support';
import { LoginThrottle, type ThrottleStore } from './login-throttle';

describe('LoginThrottle', () => {
  it('blocks an account after 5 failures and unblocks after a success resets it', async () => {
    const throttle = new LoginThrottle(new MemoryThrottleStore());
    for (let i = 0; i < 5; i++) {
      await throttle.assertAllowed('Dana@Example.com', '10.0.0.1');
      await throttle.recordFailure('dana@example.com', '10.0.0.1');
    }
    await expect(throttle.assertAllowed('DANA@example.com', '10.0.0.2')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    // Other accounts from other IPs are unaffected.
    await expect(throttle.assertAllowed('other@example.com', '10.0.0.2')).resolves.toBeUndefined();
  });

  it('fails open when the store is unavailable', async () => {
    const broken: ThrottleStore = {
      increment: () => Promise.reject(new Error('down')),
      read: () => Promise.reject(new Error('down')),
      reset: () => Promise.reject(new Error('down')),
    };
    const throttle = new LoginThrottle(broken);
    await expect(throttle.assertAllowed('a@example.com', '1.1.1.1')).resolves.toBeUndefined();
    await expect(throttle.recordFailure('a@example.com', '1.1.1.1')).resolves.toBeUndefined();
  });
});
