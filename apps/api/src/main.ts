import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { configureApp, createFastifyAdapter } from './bootstrap';
import { loadEnv } from './config/env';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot(env),
    createFastifyAdapter(),
    {
      bufferLogs: true,
    },
  );
  await configureApp(app, env);
  await app.listen(env.API_PORT, '0.0.0.0');
}

bootstrap().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
