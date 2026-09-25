import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import {
  createDatabase,
  type DatabaseConnection,
  inspectCurrentRole,
  type TenantContext,
  type Transaction,
  withTenantTx,
  withUserTx,
} from '@ooh/db';
import { ENV } from '../../config/config.module';
import { type Env } from '../../config/env';

/**
 * The only gateway to PostgreSQL. Tenant data is reachable exclusively through `withTenant`
 * (or `withUser` before tenant selection), so every query runs under Row-Level Security.
 */
@Injectable()
export class DatabaseService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly connection: DatabaseConnection;

  constructor(@Inject(ENV) private readonly env: Env) {
    this.connection = createDatabase(env.DATABASE_URL, { applicationName: 'ooh-api' });
  }

  withTenant<T>(context: TenantContext, fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return withTenantTx(this.connection.db, context, fn);
  }

  withUser<T>(userId: string, fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return withUserTx(this.connection.db, userId, fn);
  }

  /** Health probe: proves connectivity and that PostGIS is installed. */
  async ping(): Promise<{ postgis: string }> {
    const [row] = await this.connection.client<
      { postgis: string }[]
    >`SELECT postgis_lib_version() AS postgis`;
    return { postgis: row?.postgis ?? 'unknown' };
  }

  /** Refuse to run with a role that bypasses RLS, since tenant isolation would silently stop working. */
  async onApplicationBootstrap(): Promise<void> {
    let inspection;
    try {
      inspection = await inspectCurrentRole(this.connection);
    } catch (error) {
      this.logger.warn(`Database not reachable at startup; health checks will report it. (${String(error)})`);
      return;
    }
    if (inspection.superuser || inspection.bypassRls) {
      const message =
        `DATABASE_URL role "${inspection.role}" can bypass Row-Level Security. ` +
        'Use the restricted runtime role (ooh_app); the owner URL is for migrations only.';
      if (this.env.NODE_ENV === 'production') throw new Error(message);
      this.logger.error(message);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.connection.close();
  }
}
