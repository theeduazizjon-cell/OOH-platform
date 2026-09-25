import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@ooh/contracts';
import { AppError } from '../http/app-error';

/**
 * argon2id with the library defaults (m=19456 KiB, t=2, p=1), which match the OWASP recommendation.
 * Parameters are embedded in each hash, so they can be raised later without breaking old hashes.
 */
@Injectable()
export class PasswordService {
  private dummyHash: Promise<string> | undefined;

  async hash(password: string): Promise<string> {
    if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
      throw new AppError(
        'VALIDATION_FAILED',
        `Password must be ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} characters.`,
        {
          errors: [{ path: 'password', message: 'Invalid length' }],
        },
      );
    }
    return hash(password);
  }

  /**
   * Constant-work verification: when there is no stored hash (unknown user) a dummy hash is still
   * verified, so response time doesn't reveal whether an email is registered.
   */
  async verify(storedHash: string | null | undefined, password: string): Promise<boolean> {
    this.dummyHash ??= hash('dummy-password-for-constant-time-checks');
    const target = storedHash ?? (await this.dummyHash);
    try {
      const matches = await verify(target, password);
      return matches && storedHash != null;
    } catch {
      return false; // malformed stored hash
    }
  }
}
