# 13 — First Sprint (M0 + first half of M1), 2 weeks

**Goal:** a running, tested skeleton where tenant isolation is *proven by tests* before any business table exists.
Every later module inherits this foundation, so it's cheapest to get right now.

## Prerequisites (developer machine)
| Tool | Status on this machine | Action |
|---|---|---|
| Node 22 LTS | ✅ v22.23.2 | — |
| pnpm 10 | ❌ | `corepack enable && corepack prepare pnpm@latest --activate` |
| Docker runtime | ❌ not installed | Install Docker Desktop, or OrbStack/Colima (`brew install orbstack`) |
| psql client (optional) | ❌ | `brew install libpq` |
| Repo | Current repo is an unrelated MERN movie app | New repository `ooh-platform` (OPD-00) |

## Stories
| # | Story | Acceptance |
|---|---|---|
| S1 | Monorepo scaffold: pnpm workspaces, Turborepo, `apps/api`, `apps/web`, `packages/{contracts,db,config}`, shared tsconfig/eslint/prettier | `pnpm install && pnpm build && pnpm lint && pnpm typecheck` pass |
| S2 | Local infra: `infrastructure/docker/docker-compose.yml` with `postgis/postgis:16-3.4`, `redis:7`, `minio`, `mailpit`; init script creates extensions + app role without BYPASSRLS | `docker compose up -d` healthy; `SELECT postgis_full_version()` works as app role |
| S3 | Config: zod-validated env loader, `.env.example` | App refuses to boot with a clear error when a variable is missing |
| S4 | NestJS API skeleton (Fastify), pino logging with request id, RFC 9457 error filter, `/health` (DB + Redis) | `curl /api/v1/health` → `{db:"ok",redis:"ok",postgis:"3.4…"}` |
| S5 | Drizzle setup in `packages/db`: connection, `withTenantTx(tenantId, actorId, fn)` helper (`set_config` transaction-local), migration runner, custom SQL migrations folder | `pnpm db:migrate` idempotent; helper covered by test |
| S6 | Identity schema v1: `tenant`, `user`, `membership`, `role`, `role_permission`, `membership_role`, `refresh_token`, `audit_event` (partitioned) + composite FKs + RLS policies | Migration applies cleanly from zero |
| S7 | **Tenant isolation harness**: meta-test (every `tenant_id` table has RLS+FORCE+policy), cross-tenant read/write tests, missing-context-returns-zero test, composite FK cross-tenant rejection test | Tests run in CI with Testcontainers |
| S8 | Permission catalog + role templates in `packages/contracts`; seed script creates demo tenant, roles, admin user | `pnpm db:seed` creates "Demo OOH SRL" + admin |
| S9 | Auth: login (argon2id), access JWT + refresh rotation cookie, reuse detection, logout, `GET /me` | API tests: happy path, wrong password, refresh reuse revokes family, expired token |
| S10 | `PermissionGuard` + `@RequirePermission` + tenant context from token; audit service writing `auth.login` events | 403 test on a protected sample endpoint |
| S11 | Web skeleton: Vite + React + TanStack Router/Query + Tailwind + shadcn; login page, auth refresh flow, app shell with sidebar (empty pages), `/me` display | Login in browser → shell shows user + tenant |
| S12 | CI: GitHub Actions: install, lint, typecheck, unit + integration tests (PostGIS service), build; gitleaks | Green on PR |
| S13 | Docs: README setup, ADRs 0001–0006 accepted, env var reference | New dev can set up in < 30 min |

## Out of sprint
Invitations UI, roles admin UI, tenant switching UI → second half of M1.
