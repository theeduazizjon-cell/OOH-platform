import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import { type Env } from './config/env';
import { ProblemDetailsFilter } from './core/http/problem-details.filter';
import { assignRequestId, REQUEST_ID_HEADER } from './core/http/request-id';

export const API_PREFIX = 'api/v1';

export function createFastifyAdapter(env: Env): FastifyAdapter {
  return new FastifyAdapter({
    genReqId: assignRequestId,
    trustProxy: env.TRUST_PROXY,
    bodyLimit: 1024 * 1024, // JSON bodies only; files go straight to object storage via presigned URLs
  });
}

/** Cross-cutting HTTP setup shared by main.ts and the tests, so tests exercise the real pipeline. */
export async function configureApp(app: NestFastifyApplication, env: Env): Promise<void> {
  app.useLogger(app.get(Logger));
  app.setGlobalPrefix(API_PREFIX);
  app.useGlobalFilters(new ProblemDetailsFilter());
  app.enableCors({
    origin: env.CORS_ORIGINS,
    credentials: true,
    exposedHeaders: [REQUEST_ID_HEADER, 'etag'],
  });
  await app.register(helmet);
  await app.register(cookie);
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRequest', (request, reply, done) => {
      void reply.header(REQUEST_ID_HEADER, request.id);
      done();
    });
  app.enableShutdownHooks();
}
