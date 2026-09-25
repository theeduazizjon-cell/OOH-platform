import { AppError } from './app-error';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Opaque cursor over time-ordered UUIDv7 ids (keyset pagination). */
export function encodeIdCursor(id: string): string {
  return Buffer.from(id).toString('base64url');
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
