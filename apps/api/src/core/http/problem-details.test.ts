import { ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from './app-error';
import { toProblemDetails } from './problem-details';

describe('toProblemDetails', () => {
  it('maps AppError with its contract status, detail and meta', () => {
    const problem = toProblemDetails(
      new AppError('INVALID_TRANSITION', 'Study is not READY', { meta: { allowedActions: ['reopen'] } }),
    );
    expect(problem).toEqual({
      type: 'https://errors.ooh-platform.dev/invalid-transition',
      title: 'Conflict',
      status: 409,
      code: 'INVALID_TRANSITION',
      detail: 'Study is not READY',
      meta: { allowedActions: ['reopen'] },
    });
  });

  it('maps Zod validation errors to 422 with field paths', () => {
    const result = z
      .object({ lines: z.array(z.object({ city: z.string() })) })
      .safeParse({ lines: [{ city: 1 }] });
    const problem = toProblemDetails(result.error);
    expect(problem.status).toBe(422);
    expect(problem.code).toBe('VALIDATION_FAILED');
    expect(problem.errors?.[0]?.path).toBe('lines.0.city');
  });

  it('maps Nest HTTP exceptions by status', () => {
    expect(toProblemDetails(new NotFoundException()).code).toBe('NOT_FOUND');
    expect(toProblemDetails(new ConflictException('taken')).code).toBe('CONFLICT');
  });

  it('maps framework 4xx errors (e.g. malformed JSON)', () => {
    const error = Object.assign(new Error('Unexpected token'), { statusCode: 400 });
    expect(toProblemDetails(error)).toMatchObject({ status: 400, code: 'BAD_REQUEST' });
  });

  it('never leaks internal error messages', () => {
    const problem = toProblemDetails(new Error('password authentication failed for user "ooh"'));
    expect(problem).toMatchObject({ status: 500, code: 'INTERNAL_ERROR' });
    expect(JSON.stringify(problem)).not.toContain('password');
  });
});
