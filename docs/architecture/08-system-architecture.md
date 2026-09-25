# 08 — System Architecture

## 1. Shape: modular monolith + worker
```
                ┌──────────── Browser ─────────────┐
                │ React SPA: /app  /portal  /field │  (one build, three route shells; /field is a PWA)
                └───────────────┬──────────────────┘
          Google Maps JS / Street View / Places (browser-side, key restricted by referrer)
                                │ HTTPS  REST /api/v1  (+SSE for notifications, P2)
                ┌───────────────▼──────────────────┐
                │  API (NestJS on Fastify)         │  modules: identity, crm, briefs, campaigns,
                │  guards → controllers → services │  inventory, geo, research, production, field,
                │  → repositories (Drizzle)        │  commercial, work, files, audit, ai, reporting
                └───┬──────────┬─────────┬─────────┘
       PostgreSQL+PostGIS   Redis    S3 storage            external: Google Geocoding/Routes (server key),
           (RLS)          (BullMQ)  (presigned URLs)       email provider (out + inbound webhook), LLM API
                ┌───────────────▼──────────────────┐
                │ Worker (same codebase, worker.ts)│  outbox dispatcher, scheduler scans, notifications,
                │                                  │  email, thumbnails/video posters, AV scan, geocoding,
                └──────────────────────────────────┘  AI jobs, PDF/Excel generation
```
**Why not microservices**: one team, one tightly-connected domain (a client approval touches research, inventory,
commercial and work in one transaction), and a need for strong consistency. Module boundaries plus the outbox
leave room to extract services later, for example the AI or media processing workers.

## 2. Technology stack

| Layer | Choice | Justification | Rejected alternatives |
|---|---|---|---|
| Language | **TypeScript** end-to-end | One language, shared contracts/types between API and SPA | — |
| Monorepo | **pnpm workspaces + Turborepo** | Fast installs, strict dependency isolation, cached task graph | Nx (heavier), npm workspaces (slower, looser) |
| Backend | **NestJS 11 (Fastify adapter)** | Module system matches bounded contexts; DI for testability; guards/interceptors for authz, tenant context, audit | Express/Fastify raw (we'd rebuild the structure), tRPC (weak for external API) |
| ORM / SQL | **Drizzle ORM** + raw SQL where needed | SQL-transparent, supports PostGIS custom types, transactions with `set_config`, generated migrations we can read and extend | Prisma (poor PostGIS/exclusion/RLS support, opaque query engine), TypeORM (quality issues) |
| Validation / contracts | **Zod** schemas in `packages/contracts` → request validation + OpenAPI generation + frontend forms | Single source of truth | class-validator (duplicated types) |
| API style | **REST + OpenAPI 3.1** | Cacheable, easy for integrations [R§2 "API-ready"], simple file upload, resource-level authz | GraphQL (field-level authz + N+1 + tenant scoping complexity, no clear win) |
| DB | PostgreSQL 16 + PostGIS 3.4 | See 07 | |
| Queue / scheduler | **BullMQ** on Redis | Retries, backoff, repeatable jobs, rate limiting, dashboard | pg-boss (fine alternative; BullMQ chosen for throughput + tooling) |
| Storage | S3-compatible (MinIO local) | Presigned direct uploads from mobile, lifecycle rules | Cloudinary (vendor lock-in for evidence data) |
| Auth | **In-house** (argon2id, JWT access 10 min + rotating refresh cookie) | Tenant-aware memberships, external users, invitation flows and data residency are easier to control; small surface | Clerk/Auth0 (per-MAU cost with many external users, tenant model mismatch). SSO via OIDC later (P3) |
| Frontend | **React 19 + Vite + TypeScript**, TanStack Router + TanStack Query, react-hook-form + zod, TanStack Table | Authenticated app with no SEO needs; a SPA is simpler to host than Next.js, and the map-heavy UI renders client-side anyway | Next.js (SSR complexity without benefit here) |
| UI kit | **Tailwind CSS v4 + shadcn/ui (Radix)** | Accessible primitives, owned code, fast to build dense operational UIs | MUI (heavier, harder to theme) |
| Maps (UI) | Google Maps JS API via `@vis.gl/react-google-maps`, supercluster | Street View requirement | Mapbox (no Street View) |
| Mobile | **PWA** (`/field`) — camera via `<input capture>`, Geolocation API, IndexedDB offline upload queue | Required feature set is "see jobs, navigate, upload evidence" [R§24]. No native app needed for MVP. Native is P2 "richer mobile" [R§44] | React Native (2nd codebase too early) |
| Real-time | Polling (30 s) for notifications in MVP → **SSE** in P2 | Few truly real-time needs; SSE is simpler than WebSockets through proxies | WebSockets |
| Email | Transactional provider with **inbound parsing** (Postmark or AWS SES) | Outbound notifications + inbound Email-to-Brief webhook | SMTP (no inbound) |
| PDF / Excel | Playwright-rendered HTML templates → PDF; `exceljs` | Same templates as the portal study view | — |
| AI | **Claude API** (Anthropic) with tool use + structured outputs, behind an `LlmProvider` interface | Strong extraction and structured output; the provider can be swapped | — |
| Observability | pino JSON logs (request id, tenant id), OpenTelemetry traces, Sentry errors | — | — |
| Testing | Vitest, Testcontainers (postgis image), Supertest, Playwright | See §8 | Jest (slower) |
| CI/CD | GitHub Actions; Docker images | — | — |
| Hosting (recommendation) | EU region (GDPR; client is Romanian): containers on AWS (ECS Fargate) or equivalent; managed Postgres with PostGIS (RDS), ElastiCache, S3 | OPD-18 | — |

## 3. Backend module anatomy
```
apps/api/src/modules/campaigns/
  campaigns.module.ts
  campaigns.controller.ts         # HTTP only: parse (zod), call service, map result
  campaign-locations.controller.ts
  campaigns.service.ts            # use cases, transactions, permission-scoped queries
  campaign-location.machine.ts    # imports transition table from contracts, implements guards/effects
  campaigns.repository.ts         # Drizzle queries (always via tenant tx)
  events.ts                       # event payload types emitted to outbox
  campaigns.service.spec.ts / campaigns.int.spec.ts
```
Cross-cutting (`apps/api/src/core/`): `TenantContext` (AsyncLocalStorage), `db.tx()` helper that opens a transaction and
sets `app.tenant_id` + `app.actor_id`, `PermissionGuard`, `AuditService`, `Outbox`, `StateMachineRunner`,
error filter → RFC 9457 problem details, idempotency interceptor.

## 4. File storage [R§25, R§47G]
- **Upload**: `POST /files/uploads` → server creates `file_object(PENDING)` + presigned PUT (size/MIME-limited,
  5–15 min) → client uploads directly to S3 → `POST /files/{id}/complete` → worker: verify size and sha256, sniff
  magic bytes (not trusting the extension), **ClamAV scan**, strip location-sensitive EXIF from *derivatives only* (originals
  keep EXIF as evidence), generate thumbnails (sharp) / video poster + transcode (ffmpeg, P2) → `READY`.
  Quarantined files are never served.
- **Linking**: evidence uses a dedicated FK. Everything else uses `file_link(subject, purpose, visibility)`. Files attach to
  the specific entity (asset, face booking, job item, study), never to a campaign folder [R§25].
- **Download**: `GET /files/{id}/url` → authz on the linked subject → presigned GET (5 min, `Content-Disposition`).
- **Limits** (config): images 25 MB, video 300 MB (MVP: short clips), documents 50 MB. Allowed MIME allow-list.
- **Lifecycle**: originals kept for the tenant's retention policy; orphans (PENDING > 24 h) purged; derivatives regenerable.

## 5. Tasks, calendar, notifications
- **Automation engine**: `automation_rule` rows (tenant-configurable offsets) evaluated by per-tenant scheduled scans
  (hourly + daily) and by event handlers. Every rule output has a deterministic `dedupe_key`
  (e.g. `removal_due:{locationId}:{endDate}`), so re-runs never duplicate tasks or notifications.
- MVP rules (from [R§30]): campaign starts in 3 d, production deadline tomorrow, installation overdue, campaign expires
  in 7 d, removal not assigned, evidence not uploaded, client approved positions, artwork missing, production completed,
  sales follow-up overdue.
- **Channels**: `NotificationChannel` interface. MVP implements IN_APP + EMAIL; push/Teams/WhatsApp can be added later as new
  implementations [R§30]. Per-user preferences, digest batching for noisy types, severity (INFO/WARNING/CRITICAL).
- **Calendar**: SQL view `calendar_item` unions dated fields (production deadlines, jobs, campaign start/end, removal
  deadlines, tasks, opportunity follow-ups, manual events) with a computed state: upcoming/active/completed/overdue/critical [R§29].

## 6. AI architecture (human-in-the-loop)
- **Placement**: `ai` module. It never writes business tables directly. Outputs are:
  1. **Drafts** in their natural home, flagged `ai_generated` (brief DRAFT, study description drafts), or
  2. **Suggestions** (`ai_suggestion`) that a human accepts/edits/rejects, or
  3. **Answers** (assistant chat) built only from tool results.
- **Principal**: AI runs as actor type `AI` with a fixed permission set that excludes every approve/decide/verify/
  availability/commercial-write/evidence-review/complete permission [R§39]. This is enforced in code, not by prompt.
- **Tools for the assistant** (read-only, tenant- and permission-scoped as the *requesting user*):
  `search_campaigns`, `list_expiring_locations`, `list_missing_evidence`, `get_campaign_summary`,
  `get_organisation_timeline`, `query_margins` (only if the user holds `commercial.margin.read`), `list_stale_opportunities`.
  Draft tools: `propose_brief_fields`, `propose_study_descriptions`, `draft_email` (returns text; never sends).
- **Structured outputs** validated against zod schemas. Per-field confidence plus source quote for extraction.
  Low confidence → left empty.
- **Traceability**: `ai_run` stores model, prompt version (prompts are versioned files in repo), inputs (references, not
  copies, where possible), output, tokens, cost, latency. UI marks AI content with a badge until a human confirms it.
- **Safety**: email content is untrusted input (prompt injection). Extraction runs with **no tools**, so it only returns
  structured data. Tenant data never mixes across tenants in a prompt. Provider with zero-retention terms (OPD-18).
- **Evaluation**: golden set of anonymised real emails → extraction accuracy tests run in CI (nightly, not per-commit).

## 7. Security
| Concern | Mechanism |
|---|---|
| Passwords | argon2id (memory-hard), min length 12 + breached-password check (k-anonymity HIBP, optional), lockout/backoff per account + IP |
| Tokens | Access JWT (EdDSA, 10 min, claims: sub, tid, mid, perms-version) held in memory; refresh token: opaque 256-bit, **hashed** in DB, httpOnly+Secure+SameSite=Strict cookie scoped to `/api/v1/auth`, rotation on every use, **reuse detection revokes the whole family** |
| Permission changes | `perms_version` on membership. A bump forces a token refresh, so revocation takes effect within at most 10 min (immediate for suspension via denylist in Redis) |
| CSRF | Access token in `Authorization` header (not cookie) → CSRF-immune; refresh endpoint cookie is SameSite=Strict + requires custom header + Origin check |
| XSS | React escaping; no `dangerouslySetInnerHTML` except sanitised (DOMPurify) rich text; strict CSP (Google Maps domains allow-listed); AI output rendered as text/markdown-sanitised |
| SQL injection | Parameterised queries only (Drizzle); raw SQL via tagged templates; lint rule bans string-built SQL |
| Validation | Zod on every input; unknown keys stripped; size limits on bodies |
| Rate limiting | Redis sliding window per IP + per user + per tenant; stricter on auth, uploads, AI, portal decision endpoints |
| Tenant isolation | See 07 §2 |
| Files | Presigned short-lived URLs, MIME sniffing, AV scan, no public buckets, bucket policy denies non-TLS |
| External portal | Separate route shell, same API with ORGANISATION scope. External roles are flagged in the catalog so internal-only permissions can't be granted. Decision endpoints log IP/UA |
| Secrets | Env vars validated at boot (zod); prod secrets in a secret manager (AWS Secrets Manager / SSM); **Google Maps browser key restricted by HTTP referrer + API list, server key restricted by IP**; no secrets in repo (gitleaks in CI) |
| Transport | HTTPS only, HSTS; DB/Redis TLS in prod |
| Audit | See 07 §7; auth events (login, failed login, token reuse, role change) audited |
| GDPR | Data processing inventory, consent fields for marketing, contact anonymisation, EU hosting, DPA with sub-processors (Google, LLM, email) |
| Dependencies | Renovate + `pnpm audit` in CI; container image scanning |

## 8. Testing strategy
| Level | Tooling | Focus |
|---|---|---|
| Unit | Vitest | State machine tables (every allowed and every **disallowed** transition), tariff matching/specificity, money math (decimal, never float), direction/arrow computation, permission resolution |
| Integration (DB) | Vitest + Testcontainers `postgis/postgis:16-3.4` | Repositories under real RLS; exclusion constraints (double booking, duplicate tariffs, overlapping asset terms); spatial queries (radius, bbox, point-in-area, fixtures with known distances); triggers (immutability of LOCKED lines, ACTIVE tariffs) |
| **Tenant isolation** | Integration | Meta-test: every `tenant_id` table has RLS+FORCE+policy. For each repository: data seeded in tenants A and B, and every read/write as A never sees or touches B. Composite FK rejects cross-tenant references. Missing tenant context → zero rows |
| **Authorization** | API tests (Supertest) | Matrix-driven: generated from the permission matrix, every endpoint × role → expected 2xx/403/404. External scope tests (agency sees only its campaigns; decorator only assigned jobs; cost fields absent for non-finance) |
| API | Supertest against Nest app + test DB | Validation errors, pagination, problem+json, idempotency keys, optimistic locking (412) |
| Workflow | Integration | Full cycle A→F on a fake clock: expiry → removal job → evidence → booking REMOVED → face available again; campaign extension cancels removal; late removal escalations |
| Financial | Unit + integration | GP/GM% (incl. zero revenue → GM undefined, not ∞); historical tariff change doesn't alter existing lines; overrides keep snapshots |
| Files | Integration (MinIO container) | Presign → upload → complete → scan → derivative; MIME spoofing rejected; cross-tenant file URL denied |
| AI | Unit with recorded fixtures + nightly eval set | Schema validity, "never fills low-confidence fields", prompt-injection emails don't trigger tool calls, AI principal can't transition |
| Frontend | Vitest + Testing Library | Forms, permission-driven UI, state-machine-driven action buttons |
| E2E | Playwright (desktop + mobile viewport) | Golden path: brief → study → portal approval → production → field upload (mobile) → live → removal |
| Performance | k6 + seeded 50k assets | Map viewport < 300 ms p95; list endpoints < 200 ms p95 |

## 9. Repository structure (ADR-0001)
```
ooh-platform/
├─ apps/
│  ├─ api/                 NestJS: src/main.ts (HTTP), src/worker.ts (BullMQ), src/core, src/modules/*
│  └─ web/                 React SPA: src/app (internal), src/portal, src/field (PWA), src/shared
├─ packages/
│  ├─ contracts/           zod schemas, DTO types, permission catalog, state-machine tables, error codes
│  ├─ db/                  Drizzle schema, SQL migrations (incl. RLS/constraints), seeds, test fixtures
│  └─ config/              shared tsconfig bases, eslint config, prettier
├─ infrastructure/
│  ├─ docker/              docker-compose.yml (postgis, redis, minio, mailpit, clamav)
│  └─ terraform/           (later)
├─ docs/                   this package + adr/ + runbooks
├─ .github/workflows/      ci.yml
├─ turbo.json  pnpm-workspace.yaml  package.json  .env.example
```
There is no `packages/ui` until a second frontend needs shared components. There is no separate `worker` app because it shares
all domain modules with the API. It's a second entrypoint with its own Docker target.

## 10. Git workflow & environments
- **Branching**: trunk-based. `main` is always deployable; short-lived `feat/…`, `fix/…`, `chore/…` branches; PRs
  require CI green + 1 review; squash merge.
- **Commits**: Conventional Commits with module scope: `feat(auth): implement tenant-aware authentication`,
  `feat(inventory): add mount positions and faces`, `fix(bookings): prevent double booking on approval`.
- **Migrations**: one migration per PR that needs it, generated + reviewed, never edited after merge. CI runs
  migrate-from-scratch + tests.
- **Environments**: `local` (docker compose) → `dev/preview` (per-PR optional) → `staging` (prod-like, anonymised seed) →
  `production`. Same Docker image promoted between environments; config only via env vars.
- **Releases**: tag + changelog generated from commits. Feature flags per tenant (`tenant.settings.features`) for AI features.
