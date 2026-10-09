import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { ALLOWED_MIMES, FILE_TYPE_LIMITS } from '@ooh/contracts';
import { Logger } from 'nestjs-pino';
import { type Env } from './config/env';
import { LOCAL_STORAGE_PATH } from './core/files/local-storage';
import { AppError } from './core/http/app-error';
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
  acceptLocalUploads(app);
  app.enableShutdownHooks();
}

/**
 * Raw file bodies, only for development local-storage uploads (FILE_STORAGE=local stands in for
 * presigned S3 URLs). Every other route keeps the 1 MB JSON-only limit.
 */
function acceptLocalUploads(app: NestFastifyApplication): void {
  const uploadPath = `/${API_PREFIX}/${LOCAL_STORAGE_PATH}?`;
  app
    .getHttpAdapter()
    .getInstance()
    .addContentTypeParser(
      ALLOWED_MIMES,
      { parseAs: 'buffer', bodyLimit: Math.max(...Object.values(FILE_TYPE_LIMITS)) },
      (request, body, done) => {
        if (!request.url.startsWith(uploadPath)) {
          done(new AppError('BAD_REQUEST', 'Unsupported content type.', { status: 415 }), undefined);
          return;
        }
        done(null, body);
      },
    );
}
