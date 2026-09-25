import type { z } from 'zod';

/** Parses untrusted input with a contract schema; a ZodError becomes a 422 problem response. */
export function parseWith<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  return schema.parse(input);
}
