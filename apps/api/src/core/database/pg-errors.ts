/** PostgreSQL error helpers (drizzle wraps driver errors, so look through `cause`). */

interface PgErrorLike {
  code?: unknown;
  constraint_name?: unknown;
  constraint?: unknown;
  cause?: unknown;
}

function findPgError(error: unknown): PgErrorLike | undefined {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    const candidate = current as PgErrorLike;
    if (typeof candidate.code === 'string' && /^[0-9A-Z]{5}$/.test(candidate.code)) return candidate;
    current = candidate.cause;
  }
  return undefined;
}

/** True for a unique violation (23505), optionally of one named constraint or index. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const pg = findPgError(error);
  if (pg?.code !== '23505') return false;
  const name = pg.constraint_name ?? pg.constraint;
  return constraint === undefined || name === constraint;
}
