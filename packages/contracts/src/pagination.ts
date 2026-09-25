import { z } from 'zod';

/** Cursor pagination (docs/architecture/10-api.md): `?limit=50&cursor=<opaque>`. */
export const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(200).optional(),
});
export type PageQuery = z.infer<typeof pageQuerySchema>;

export interface Page<T> {
  data: T[];
  page: { nextCursor: string | null; hasMore: boolean };
}
