# OOH Operations Platform

Multi-company software platform for managing Out-of-Home advertising operations.

It covers CRM, briefs, campaigns, reusable OOH
inventory, GIS research, studies and client approval, production, field operations, commercial engine
and AI assistance. Architecture and product decisions: [docs/](docs/README.md).

## Stack

TypeScript monorepo (pnpm + Turborepo) · NestJS 11 on Fastify · PostgreSQL 18 + PostGIS 3.6 with
Row-Level Security · Drizzle ORM · Redis · Vitest + Testcontainers.

```
apps/api            NestJS HTTP API (and later the worker entrypoint)
apps/web            React SPA (Vite, TanStack Router/Query, Tailwind): /app now; /portal, /field later
packages/contracts  permission catalog, role templates, error contract (shared with the web app)
packages/db         Drizzle schema, SQL migrations (incl. RLS), tenant transaction helpers, seeds
infrastructure/     docker compose for local PostgreSQL/PostGIS, Redis, Mailpit
docs/               architecture package, ADRs, open product decisions, development docs
```

## Prerequisites

- Node.js 22 (`nvm use`)
- pnpm via Corepack: `corepack enable`
- A Docker runtime (Docker Desktop, OrbStack or Colima) for local infrastructure and integration tests

## First-time setup

```bash
pnpm install
cp .env.example .env
pnpm infra:up          # PostgreSQL 18 + PostGIS, Redis, Mailpit (creates the ooh_app role)
pnpm build             # builds shared packages
pnpm db:migrate        # applies migrations as the schema owner
pnpm db:seed           # 2 demo tenants with the 12 system roles, and 2 demo users
pnpm dev               # API on http://localhost:3000, web app on http://localhost:5173
curl localhost:3000/api/v1/health
```

Sign in at http://localhost:5173 with `admin@demo.local` / `demo-password-change-me` (Company Admin of
"Demo OOH SRL", Viewer of "Second OOH SRL") or `viewer@demo.local` (Viewer).

## Everyday commands

| Command                                        | What it does                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `pnpm dev`                                     | Watch mode for all packages and the API                                                     |
| `pnpm lint` / `pnpm typecheck` / `pnpm format` | Static checks                                                                               |
| `pnpm test`                                    | Unit and HTTP tests (no infrastructure needed)                                              |
| `pnpm test:int`                                | Database integration tests incl. **tenant-isolation** suite (Docker or `TEST_DATABASE_URL`) |
| `pnpm db:generate`                             | Generate a migration from schema changes (review the SQL before committing)                 |
| `pnpm infra:down` / `pnpm infra:reset`         | Stop infrastructure / stop and delete data                                                  |

## Conventions

- Trunk-based: short-lived `feat/…`, `fix/…`, `chore/…` branches, PR + green CI, squash merge.
- Conventional Commits with module scope, e.g. `feat(auth): implement tenant-aware authentication`.
- Every tenant-owned table: `tenant_id`, `UNIQUE (tenant_id, id)`, composite FKs, forced RLS. The
  schema-guard tests fail the build otherwise. See [docs/architecture/07-database.md](docs/architecture/07-database.md).
- Environment variables: [docs/development/environment.md](docs/development/environment.md).

## License

MIT. See [LICENSE](LICENSE).
