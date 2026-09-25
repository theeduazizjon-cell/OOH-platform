# 12 — Engineering Roadmap

Follows the roadmap's sequence [R§51] with **three justified adjustments**:
1. **Audit, files and the task/notification *core*** move forward (M1/M4). Every later step emits audit events,
   attaches files and creates tasks; building them at step 12/15 would mean retrofitting every module.
2. **Tariff engine core** moves ahead of Field Ops (it's needed to price installation at assignment); the full
   commercial UI stays at step 14.
3. **Email-to-Brief (step 17) and the AI assistant (18)** stay late, but the Brief model reserves AI provenance
   fields from M3 so nothing needs migrating.

Sizing assumes 1–2 developers; each milestone ends with a demo on the Carrefour Sinaia scenario and passing tests.

| Milestone | Roadmap steps | Scope | Exit criteria | Est. |
|---|---|---|---|---|
| **M0 Foundation infra** | 01 | Monorepo, Docker (PostGIS/Redis/MinIO/Mailpit), NestJS + Vite skeletons, Drizzle migrations, CI, env validation, logging, error format | `pnpm dev` runs everything; CI green; health check hits DB with PostGIS | 1 wk |
| **M1 Tenancy, Auth, RBAC** | 02 | tenant/user/membership/role/permission, RLS helpers + meta-test, login/refresh/logout/switch, invitations, permission guard + scopes, audit core, admin users/roles UI, app shell | Cross-tenant tests pass; role matrix tests for identity endpoints; can invite a user and log in | 2 wk |
| **M2 CRM** | 03 | Nomenclatures (config module), organisations + classifications + dedupe, contacts (+consent), pipeline/opportunities/activities, Company 360° v1, tasks core | Carrefour + Agency X created once with two classifications; opportunity WON | 2 wk |
| **M3 Briefs & Campaigns** | 04 | Brief (manual/from opp), lines, convert → campaign + locations, state machines runner, status_history, outbox + worker, geocoding job | Brief → campaign with 4 locations, each geocoded, pin confirmed | 2 wk |
| **M4 Inventory & Files** | 05 | Asset types (templates), assets → mounts → faces, terms (direct/subleased), blocks, passport, duplicate proximity check, files (presign, scan, thumbnails), CSV import (SHOULD) | POLE-001245 with 2 mounts × 2 faces; duplicate within 10 m blocked | 2 wk |
| **M5 Map & Geo** | 06 | Map module (viewport + clusters), research map UI, Street View, reverse geocode, route + distance + direction, POIs, geo areas seed | 20k seeded assets pan/zoom smoothly; candidate click → address + distance + route | 2–3 wk |
| **M6 Research & Studies** | 07–08 | Candidates, study builder, snapshots, preview, publish, TENTATIVE holds | Study v1 for Sinaia with 7 positions published | 2 wk |
| **M7 Portal & Approval** | 09 | Portal shell, external scopes, per-item decisions, on-behalf decisions, booking confirmation + exclusion, notifications (in-app + email) | Client approves 7, rejects 1 in a second study; double-booking attempt returns 409 | 2 wk |
| **M8 Tariff core + Production** | 10, (14 core) | Tariff rules, matching, snapshots; production requirement generation, orders, artwork, supplier email | Order "7 × 0.8×2 m, L3 R2 S2" sent; tariff change doesn't alter priced lines | 2 wk |
| **M9 Field Ops + Evidence** | 11–12 | Field jobs, assignment (priced), PWA field app, camera upload with GPS/offline queue, evidence review, activation | Decorator on a phone completes 7 installs → location LIVE | 3 wk |
| **M10 Monitoring & Removal** | 13 | Automation rules engine, expiry scans, removal jobs, escalations, extension flow, monitoring view | Fake-clock test: expiry → removal → face available; overdue shows critical | 1–2 wk |
| **M11 Commercial & Workflow UI** | 14–15 | Costs/revenue/margins UI, locking, adjustments, billable items export; calendar read model + UI; notification preferences; dashboard control tower | GP/GM% for Sinaia correct against hand-calculated fixture | 2 wk |
| **M12 Reporting** | 16 | Margin/operations/campaign reports, CSV exports | Mgmt report reproduces current Excel figures | 1 wk |
| **M13 Email + AI** | 17–18 | Inbound email, AI extraction → draft brief, study draft text, campaign/org summaries, alert digest, assistant with read-only tools, AI audit | Forwarded real email → correct draft brief on ≥ 80% of eval set fields; AI never transitions state (test) | 2–3 wk |
| **M14 Pilot hardening** | — | Performance (k6), security review, backups/restore drill, staging → prod, data migration from Excel/My Maps | Pilot tenant live | 2 wk |
| Phase 2 | 19 | Billing/invoicing integration, supplier portal, advanced portal, PDF/Excel deliverables, … | | |
| Phase 3 | 20 | Analytics, SaaS onboarding, subscription billing, … | | |

**MVP total ≈ 26–30 weeks for one experienced full-stack developer**, less with two. The critical path is M1 → M3 → M4 → M5 → M6 → M7 → M9.
