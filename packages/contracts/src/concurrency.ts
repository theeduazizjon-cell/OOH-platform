/**
 * Optimistic concurrency (docs/architecture/10-api.md): responses carry `ETag: "<version>"`, and
 * changes to an existing resource must send it back in `If-Match`. A stale version → 412
 * PRECONDITION_FAILED; a missing header → 428 PRECONDITION_REQUIRED.
 */

export const IF_MATCH_HEADER = 'if-match';
export const ETAG_HEADER = 'etag';

/** Strong entity tag for a resource version, e.g. 3 → `"3"`. */
export function etagOf(version: number): string {
  return `"${version}"`;
}
