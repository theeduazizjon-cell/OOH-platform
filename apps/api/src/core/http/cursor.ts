import { AppError } from './app-error';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Opaque cursor over time-ordered UUIDv7 ids (keyset pagination). */
export function encodeIdCursor(id: string): string {
  return Buffer.from(id).toString('base64url');
}

/** Opaque cursor over a (sort key, id) pair, for lists ordered by something other than the id. */
export function encodeKeysetCursor(sortKey: string, id: string): string {
  return Buffer.from(JSON.stringify([sortKey, id])).toString('base64url');
}

export function decodeKeysetCursor(cursor: string): { sortKey: string; id: string } {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    if (
      Array.isArray(value) &&
      typeof value[0] === 'string' &&
      typeof value[1] === 'string' &&
      UUID_RE.test(value[1])
    )
      return { sortKey: value[0], id: value[1] };
  } catch {
    // fall through to the validation error
  }
  throw new AppError('VALIDATION_FAILED', 'Invalid cursor.', {
    errors: [{ path: 'cursor', message: 'Invalid cursor' }],
  });
}

export function decodeIdCursor(cursor: string): string {
  const id = Buffer.from(cursor, 'base64url').toString();
  if (!UUID_RE.test(id)) {
    throw new AppError('VALIDATION_FAILED', 'Invalid cursor.', {
      errors: [{ path: 'cursor', message: 'Invalid cursor' }],
    });
  }
  return id;
}
