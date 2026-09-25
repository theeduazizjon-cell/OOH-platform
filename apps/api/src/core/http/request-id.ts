import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const REQUEST_ID_HEADER = 'x-request-id';
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * Honour a caller-supplied request id (from the load balancer, or the web app for correlation)
 * when it is well-formed; otherwise generate one. The id is written back onto the raw request
 * headers so the HTTP logger (pino-http) and Fastify share the same value.
 */
export function assignRequestId(req: IncomingMessage): string {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const id = typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  req.headers[REQUEST_ID_HEADER] = id;
  return id;
}
