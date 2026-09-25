import { type DynamicModule, Module, RequestMethod } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { ConfigModule } from './config/config.module';
import { type Env } from './config/env';
import { AuditModule } from './core/audit/audit.module';
import { AuthCoreModule } from './core/auth/auth-core.module';
import { DatabaseModule } from './core/database/database.module';
import { REQUEST_ID_HEADER } from './core/http/request-id';
import { RedisModule } from './core/redis/redis.module';
import { AuthModule } from './modules/auth/auth.module';
import { HealthModule } from './modules/health/health.module';
import { MembershipsModule } from './modules/memberships/memberships.module';

@Module({})
export class AppModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(env),
        LoggerModule.forRoot({
          // Nest 11 route syntax (path-to-regexp v8); the library default '*' triggers a legacy warning.
          forRoutes: [{ path: '{*path}', method: RequestMethod.ALL }],
          pinoHttp: {
            level: env.LOG_LEVEL,
            // Same id Fastify assigned (see request-id.ts), so log lines and responses correlate.
            genReqId: (req) => req.headers[REQUEST_ID_HEADER] as string,
            redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
            autoLogging: { ignore: (req) => req.url?.endsWith('/health') ?? false },
            transport:
              env.NODE_ENV === 'development'
                ? { target: 'pino-pretty', options: { singleLine: true, translateTime: 'SYS:HH:MM:ss' } }
                : undefined,
          },
        }),
        DatabaseModule,
        RedisModule,
        AuditModule,
        AuthCoreModule,
        HealthModule,
        AuthModule,
        MembershipsModule,
      ],
    };
  }
}
