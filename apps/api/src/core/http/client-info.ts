import type { FastifyRequest } from 'fastify';

/** Request metadata recorded with security-relevant events (audit, refresh tokens, throttling). */
export interface ClientInfo {
  readonly requestId: string;
  readonly ip: string;
  readonly userAgent: string | null;
}

export function clientInfo(request: FastifyRequest): ClientInfo {
  const userAgent = request.headers['user-agent'];
  return { requestId: request.id, ip: request.ip, userAgent: userAgent ? userAgent.slice(0, 512) : null };
}
