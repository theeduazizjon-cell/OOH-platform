import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger as PinoLogger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';
import { OutboxDispatcher } from './core/outbox/outbox.dispatcher';

/**
 * Worker entrypoint (08-system-architecture.md §1): the same modules as the API, no HTTP server.
 * Dispatches the outbox until SIGTERM/SIGINT; scheduled scans and queued jobs join it later.
 */
async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.createApplicationContext(AppModule.forRoot(env), { bufferLogs: true });
  app.useLogger(app.get(PinoLogger));
  app.enableShutdownHooks();
  app.get(OutboxDispatcher).start();
  new Logger('Worker').log('Outbox dispatcher started');
}

bootstrap().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
