import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/**
 * Environment contract for the API. Validated once at startup; the process refuses to boot on an
 * invalid configuration instead of failing later at runtime. Documented in docs/development/environment.md.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  /** Restricted runtime role (ooh_app). Never the schema owner. */
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),

  /** HMAC key for access tokens (HS256). Generate with: openssl rand -base64 48 */
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  /** Secure cookies (HTTPS only). Defaults to true in production; set false only for plain-http dev. */
  COOKIE_SECURE: z.stringbool().optional(),
  /** Trust X-Forwarded-For from a reverse proxy/load balancer (for client IPs in audit and throttling). */
  TRUST_PROXY: z.stringbool().default(false),
});

export type Env = z.infer<typeof envSchema> & { COOKIE_SECURE: boolean };

export class InvalidEnvironmentError extends Error {
  override readonly name = 'InvalidEnvironmentError';
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new InvalidEnvironmentError(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }
  const env = result.data;
  if (env.NODE_ENV === 'production' && env.COOKIE_SECURE === false) {
    throw new InvalidEnvironmentError('COOKIE_SECURE=false is not allowed in production');
  }
  return { ...env, COOKIE_SECURE: env.COOKIE_SECURE ?? env.NODE_ENV === 'production' };
}
