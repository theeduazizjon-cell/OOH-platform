# Environment variables

Local values live in `.env` at the repository root (`cp .env.example .env`). The API validates its
variables at startup (`apps/api/src/config/env.ts`) and refuses to boot on invalid configuration.

| Variable                     | Used by                           | Required          | Default       | Description                                                                                                                                                  |
| ---------------------------- | --------------------------------- | ----------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NODE_ENV`                   | api                               | no                | `development` | `development` \| `test` \| `production`. Production hides internal error text in health checks and **refuses to start** if `DATABASE_URL` can bypass RLS.    |
| `LOG_LEVEL`                  | api                               | no                | `info`        | pino level: `fatal` … `trace`, `silent`.                                                                                                                     |
| `API_PORT`                   | api                               | no                | `3000`        | HTTP port.                                                                                                                                                   |
| `CORS_ORIGINS`               | api                               | no                | _(none)_      | Comma-separated browser origins allowed to call the API (the web app).                                                                                       |
| `DATABASE_URL`               | api, worker                       | **yes**           | —             | Runtime connection as the restricted role **`ooh_app`** (no BYPASSRLS).                                                                                      |
| `MIGRATION_DATABASE_URL`     | `pnpm db:migrate`, `pnpm db:seed` | for those scripts | —             | Schema-owner connection. Never given to the running API.                                                                                                     |
| `REDIS_URL`                  | api, worker                       | **yes**           | —             | `redis://` or `rediss://`.                                                                                                                                   |
| `OUTBOX_DISPATCH_IN_PROCESS` | api                               | no                | `false`       | Development: the API process also dispatches the outbox, so `pnpm dev` needs no worker. **Refused in production**, where `start:worker` runs the dispatcher. |
| `GOOGLE_MAPS_SERVER_KEY`     | api, worker                       | no                | —             | Google Geocoding (server key, IP-restricted). Unset (e.g. locally): every store pin is placed by hand ("Confirm store pin" tasks).                           |
| `TEST_DATABASE_URL`          | `pnpm test:int`                   | no                | —             | Superuser URL of an existing PostgreSQL 18 + PostGIS server. When unset, integration tests start a Testcontainers PostGIS container (needs Docker).          |

## Database roles

| Role                  | Created by                                                             | Privileges                                                                            | Used for                               |
| --------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------- |
| owner (`ooh` locally) | the Postgres container (`POSTGRES_USER`) / infrastructure              | owns schema, creates extensions                                                       | migrations, seeds, tenant provisioning |
| `ooh_app`             | `packages/db/sql/bootstrap-roles.sql` (locally: container init script) | DML on application tables only; **no** BYPASSRLS; INSERT/SELECT only on `audit_event` | the API and worker                     |

In staging/production, create `ooh_app` with a generated password through infrastructure code and
run `bootstrap-roles.sql`-equivalent provisioning before the first migration.

## Without Docker (macOS, conda-forge)

Where Docker isn't available and Homebrew can't install PostGIS (Intel Macs on recent macOS need the full Xcode to
build it), PostgreSQL 18 + PostGIS 3.6 + Redis can live in one folder, without admin rights:

```bash
mkdir -p ~/ooh-local && cd ~/ooh-local
curl -fsSL https://micro.mamba.pm/api/micromamba/osx-64/latest | tar -xj bin/micromamba   # osx-arm64 on Apple silicon
MAMBA_ROOT_PREFIX=$PWD/mamba ./bin/micromamba create -y -p $PWD/env -c conda-forge "postgresql=18" "postgis=3.6" redis-server
```

A small `start.sh` there runs `initdb -U ooh --auth=trust` once, then `pg_ctl … -o "-p 54329"` and
`redis-server --daemonize yes`. Point `.env` at `localhost:54329` (database `ooh_dev`, created with
`packages/db/sql/bootstrap-roles.sql`), and run integration tests with
`TEST_DATABASE_URL=postgres://ooh@localhost:54329/postgres`. Remove everything by deleting the folder.
