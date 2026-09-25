import { inject } from 'vitest';
import { createDatabase, type DatabaseConnection } from '../src/client';

export function ownerConnection(): DatabaseConnection {
  return createDatabase(inject('ownerUrl'), { max: 2, applicationName: 'test-owner' });
}

/** Runtime-role connection. `max: 1` makes connection reuse (context leakage) observable. */
export function appConnection(): DatabaseConnection {
  return createDatabase(inject('appUrl'), { max: 1, applicationName: 'test-app' });
}

/** PostgreSQL SQLSTATE of an error, unwrapping drizzle's query-error wrapper. */
export function pgCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export async function expectPgError(promise: Promise<unknown>, sqlState: string): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  if (caught === undefined) throw new Error(`Expected SQLSTATE ${sqlState}, but the statement succeeded`);
  const code = pgCode(caught);
  if (code !== sqlState) {
    throw new Error(
      `Expected SQLSTATE ${sqlState}, got ${code ?? 'none'}: ${caught instanceof Error ? caught.message : JSON.stringify(caught)}`,
    );
  }
}

export const SQLSTATE = {
  INSUFFICIENT_PRIVILEGE: '42501', // also raised for RLS WITH CHECK violations
  FOREIGN_KEY_VIOLATION: '23503',
} as const;
