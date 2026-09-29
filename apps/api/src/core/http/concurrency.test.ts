import { describe, expect, it } from 'vitest';
import { AppError } from './app-error';
import { assertIfMatch, parseIfMatch } from './concurrency';

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof AppError ? error.code : 'not an AppError';
  }
  return undefined;
};

describe('parseIfMatch', () => {
  it('requires the header (428)', () => {
    expect(codeOf(() => parseIfMatch(undefined))).toBe('PRECONDITION_REQUIRED');
    expect(codeOf(() => parseIfMatch('   '))).toBe('PRECONDITION_REQUIRED');
  });

  it('accepts *, one or several strong tags, and ignores weak tags', () => {
    expect(parseIfMatch('*')).toBe('*');
    expect(parseIfMatch('"3"')).toEqual([3]);
    expect(parseIfMatch(' "3", "4" ')).toEqual([3, 4]);
    expect(parseIfMatch(['"3"', '"5"'])).toEqual([3, 5]);
    // Weak tags are grammatical but never match under If-Match's strong comparison.
    expect(parseIfMatch('W/"3"')).toEqual([]);
    // Tags that aren't one of our versions are valid syntax but can't match either.
    expect(parseIfMatch('"abc"')).toEqual([]);
  });

  it('rejects malformed headers (400)', () => {
    for (const header of ['3', '"3', 'W/3', '"3",,', '*, "3"']) {
      expect(
        codeOf(() => parseIfMatch(header)),
        header,
      ).toBe('BAD_REQUEST');
    }
  });
});

describe('assertIfMatch', () => {
  it('passes for * or a matching version, and fails with the current ETag otherwise', () => {
    expect(codeOf(() => assertIfMatch('*', 7))).toBeUndefined();
    expect(codeOf(() => assertIfMatch([6, 7], 7))).toBeUndefined();

    let caught: unknown;
    try {
      assertIfMatch([6], 7);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('PRECONDITION_FAILED');
    expect((caught as AppError).status).toBe(412);
    expect((caught as AppError).options.meta).toEqual({ etag: '"7"' });
    expect(codeOf(() => assertIfMatch([], 7))).toBe('PRECONDITION_FAILED');
  });
});
