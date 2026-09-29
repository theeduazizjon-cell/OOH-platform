import {
  type CallHandler,
  createParamDecorator,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { ETAG_HEADER, etagOf, IF_MATCH_HEADER } from '@ooh/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { map, type Observable } from 'rxjs';
import { AppError } from './app-error';

/**
 * Optimistic concurrency (docs/architecture/10-api.md). Changes to an existing resource carry
 * `If-Match: "<version>"` (or `*`); the service compares it with the locked row's version.
 */
export type IfMatch = '*' | readonly number[];

const ENTITY_TAG = /^(W\/)?"([^"]*)"$/;

/**
 * Parses an If-Match header. Only strong tags of our form `"<n>"` can ever match: weak tags
 * (`W/"3"`) are allowed by the grammar but never match under If-Match's strong comparison.
 */
export function parseIfMatch(header: string | string[] | undefined): IfMatch {
  const value = (Array.isArray(header) ? header.join(',') : header)?.trim();
  if (!value) {
    throw new AppError(
      'PRECONDITION_REQUIRED',
      'This change needs an If-Match header with the version you last read (the ETag).',
    );
  }
  if (value === '*') return '*';

  const versions: number[] = [];
  for (const part of value.split(',')) {
    const match = ENTITY_TAG.exec(part.trim());
    if (!match) throw new AppError('BAD_REQUEST', 'Malformed If-Match header.');
    const [, weak, opaque] = match;
    if (!weak && /^\d{1,9}$/.test(opaque!)) versions.push(Number(opaque));
  }
  return versions;
}

/** Throws 412 (with the current ETag) unless the client's If-Match names the current version. */
export function assertIfMatch(ifMatch: IfMatch, currentVersion: number): void {
  if (ifMatch === '*' || ifMatch.includes(currentVersion)) return;
  throw new AppError(
    'PRECONDITION_FAILED',
    'Someone else changed this in the meantime. Reload to see the current state, then try again.',
    { meta: { etag: etagOf(currentVersion) } },
  );
}

/** Route parameter: the parsed If-Match header (428 when absent, 400 when malformed). */
export const IfMatchHeader = createParamDecorator((_: unknown, context: ExecutionContext): IfMatch => {
  const request = context.switchToHttp().getRequest<FastifyRequest>();
  return parseIfMatch(request.headers[IF_MATCH_HEADER]);
});

/** Adds `ETag: "<version>"` to responses whose body is a single versioned resource. */
@Injectable()
export class VersionEtagInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    return next.handle().pipe(
      map((body: unknown) => {
        const version = (body as { version?: unknown } | null | undefined)?.version;
        if (typeof version === 'number') void reply.header(ETAG_HEADER, etagOf(version));
        return body;
      }),
    );
  }
}
