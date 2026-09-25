import { describe, expect, it } from 'vitest';
import { AppError } from '../http/app-error';
import { PasswordService } from './password.service';

const passwords = new PasswordService();

describe('PasswordService', () => {
  it('hashes with argon2id and verifies', async () => {
    const hash = await passwords.hash('correct horse battery');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await passwords.verify(hash, 'correct horse battery')).toBe(true);
    expect(await passwords.verify(hash, 'wrong horse battery')).toBe(false);
  });

  it('returns false (after doing the work) for unknown users and malformed hashes', async () => {
    expect(await passwords.verify(null, 'anything-at-all')).toBe(false);
    expect(await passwords.verify('not-a-hash', 'anything-at-all')).toBe(false);
  });

  it('enforces the length policy when setting a password', async () => {
    await expect(passwords.hash('short')).rejects.toBeInstanceOf(AppError);
    await expect(passwords.hash('x'.repeat(129))).rejects.toBeInstanceOf(AppError);
  });
});
