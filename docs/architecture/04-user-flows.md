# 04 — End-to-End User Flows

Running example throughout: **Campaign "Carrefour New Store Openings 2027"**, location **Carrefour Sinaia**,
7 directional flags, agency *Agency X*, end client *Carrefour*.

Every step below runs inside a single DB transaction that performs these writes together:
state change + `status_history` row + `audit_event` + `outbox_event`. Notifications and tasks are created
**asynchronously** from the outbox, so a failing email never rolls back a business action.

## Flow A — Request intake (Email → Brief → Campaign)

| # | Transition | Trigger / Actor | Preconditions | DB changes | Status | Notifications / Tasks | Permission | Failure cases | Audit |
|---|---|---|---|---|---|---|---|---|---|
| A1 | Email received | Inbound webhook / system | Tenant inbound address resolves; sender not blocked | `inbound_email` (raw MIME in storage), attachments → `file_object` | email `RECEIVED` | — | system | Unknown tenant address → reject; oversized → store, flag | `email.received` |
| A2 | AI classification + extraction | Worker / AI | Email is new; AI feature enabled for tenant | `ai_run`; if OOH request → `brief` (source=EMAIL, `ai_generated=true`, field provenance), `brief_line`s | brief `DRAFT` | Notify buyers on duty: "AI drafted brief — review" + task | AI principal: `brief.draft` only | Not an OOH request → email `IGNORED` (user can override); low confidence → fields left blank, never guessed | `brief.ai_drafted` (model, prompt version) |
| A2' | Manual brief / from opportunity | Buyer; or Sales on WON opp | Opportunity stage kind = WON (if from opp) | `brief` (source=MANUAL/OPPORTUNITY, `opportunity_id`) | `DRAFT` | — | `brief.create` | — | `brief.created` |
| A3 | Buyer reviews/edits | Buyer | Brief `DRAFT` | field edits; AI fields become `human_edited` | `DRAFT` | — | `brief.update` | Concurrent edit → 409 (version) | field diff |
| A4 | Confirm brief | Buyer | Required fields: client org, ≥1 line with address or city, dates or "TBD" flag | — | `DRAFT → CONFIRMED` | — | `brief.confirm` | Missing fields → 422 listing them | `brief.confirmed` |
| A5 | Convert → Campaign | Buyer | `CONFIRMED`; client/agency orgs exist (create-inline allowed) | `campaign` (new, or existing per OPD-07b), one `campaign_location` per `brief_line`, attachments re-linked | brief `CONVERTED`; campaign `ACTIVE`; locations `DRAFT` | Task "Research Carrefour Sinaia" per location (due = brief deadline) | `brief.convert`, `campaign.create` | Duplicate campaign name for same client/period → warning | `brief.converted`, `campaign.created` |
| A6 | Store geocoding | Worker (on `campaign_location.created`) | Address present | `campaign_location.store_point`, `geocode_status=RESOLVED/AMBIGUOUS/FAILED`, `place_id` | location stays `DRAFT` | If AMBIGUOUS/FAILED → task "Confirm store pin" | system | Provider down → retry with backoff; quota → alert admin | `location.geocoded` |
| A7 | Buyer confirms/adjusts pin | Buyer | — | `store_point`, `geocode_status=CONFIRMED` | `DRAFT → RESEARCH` | — | `campaign_location.update` | — | `location.store_confirmed` |

## Flow B — Research → Study → Client approval

| # | Transition | Trigger / Actor | Preconditions | DB changes | Status | Notifications / Tasks | Permission | Failure cases | Audit |
|---|---|---|---|---|---|---|---|---|---|
| B1 | Open research map | Buyer | location has confirmed store point | read only: assets within radius (default 3 km, configurable) + availability for location dates | — | — | `research.read` | — | — |
| B2a | Add existing asset as candidate | Buyer (click inventory marker) | Asset `ACTIVE` or `PROSPECTIVE`; not already a candidate here | `candidate_position` (asset, mount pos), distance (PostGIS), bearing to store | candidate `SHORTLISTED` | — | `research.create` | Asset has confirmed overlapping booking → allowed but flagged "Unavailable" | `candidate.added` |
| B2b | Add new position by map click | Buyer | — | Duplicate check `ST_DWithin(10 m, same type)` → if hit, prompt "reuse POLE-001245?". Else `ooh_asset` (`PROSPECTIVE`, verification `NOT_VERIFIED`), default mount positions/faces from type template, reverse-geocoded address, `candidate_position` | asset `PROSPECTIVE`; candidate `SHORTLISTED` | — | `research.create`, `asset.create` | Override duplicate requires reason (audited) | `asset.created`, `candidate.added` |
| B3 | Enrich candidate | Buyer (+ system) | — | route distance/duration (provider), direction/arrow suggestion (computed), traffic direction, visibility notes, photos, simulation image, estimated cost (tariff preview) | — | — | `research.update` | Route provider failure → keep straight-line distance, mark route "unavailable" | field diff |
| B4 | Request field verification | Buyer | asset not `FIELD_VERIFIED` (or verification older than N months) | asset verification → `TO_BE_VERIFIED`; `field_job` type VERIFICATION (optional) | verification `TO_BE_VERIFIED` | Task/notify decorator if job created | `asset.verify.request` | — | `asset.verification_requested` |
| B5 | Record verification | Decorator/Buyer | photo evidence present | `asset_verification` row, `last_verified_at` | `→ FIELD_VERIFIED` | — | `asset.verify` (human only) | No photo → 422 | `asset.verified` |
| B6 | AI research hints (optional) | Buyer requests | — | `ai_run`, `ai_suggestion` (score breakdown) on candidate | — | — | `research.read` | — | `ai.suggested` |
| B7 | Build study draft | Buyer | ≥1 shortlisted candidate | `study` (version n), `study_item` per selected candidate (order, description; AI draft optional) | study `DRAFT` | — | `study.create` | — | `study.created` |
| B8 | Buyer approves study (internal) | Buyer / Account Manager | Every item has photo or Street View ref, distance, support type; warnings if not field-verified | snapshot frozen into `study_item.snapshot` (jsonb) | `DRAFT → READY` | — | `study.update` | Validation failures listed | `study.ready` |
| B9 | Publish to portal | Buyer | `READY`; ≥1 client or agency external user exists, **or** "record decisions internally" mode | `face_booking` **TENTATIVE** holds per item (OPD-03); study published_at | `READY → PUBLISHED`; location `RESEARCH → AWAITING_APPROVAL` | Email + in-app to client/agency users with link; task "Follow up approval" due +3 days | `study.publish` | Faces with confirmed conflicting booking → block publish of that item | `study.published` |
| B10 | Client approves / rejects / comments per position | End Client / Agency user (or buyer on behalf, OPD-06) | study `PUBLISHED`; item `PROPOSED`; user's org is campaign's client/agency | `client_decision` (decision, user, ts, comment, `on_behalf=false`) | item `PROPOSED → APPROVED / REJECTED` | Notify buyer "Carrefour approved 5/7" (batched 10 min) | `study.decide` scope G | **Double booking**: approval tries TENTATIVE→CONFIRMED; exclusion constraint violation → item cannot be approved, shown "no longer available", buyer notified | `client_decision.recorded` (+ IP, user agent) |
| B11 | All items decided | System | every item APPROVED/REJECTED | rejected items' holds → RELEASED | study `→ DECIDED`; location `→ APPROVED` (if ≥1 approved) or `→ RESEARCH` (all rejected → new study version) | Notify buyer; tasks "Collect artwork", "Create production order" | system | — | `study.decided` |

## Flow C — Production

| # | Transition | Actor | Preconditions | DB changes | Status | Notifications / Tasks | Permission | Failure cases | Audit |
|---|---|---|---|---|---|---|---|---|---|
| C1 | Generate production requirement | System on `study.decided` | ≥1 approved item | `production_order` DRAFT + `production_item`s aggregated by (material, dimension, face creative/arrow): e.g. 0.8×2 m flag ×7 (L3, R2, S2) | order `DRAFT`; location `→ IN_PRODUCTION` | Production Manager notified | system | Production not required (client supplies material) → buyer marks "No production" → skip to D1 | `production.generated` |
| C2 | Attach artwork | Buyer / Production Mgr | — | `file_link(purpose=ARTWORK)` on order or per face creative | artwork `MISSING → RECEIVED` | — | `production.update` | — | `artwork.attached` |
| C3 | Send to supplier | Production Mgr | supplier org set (classification print supplier), deadline set, artwork RECEIVED | order PDF/link generated, sent_at | `DRAFT → SENT` | Email to supplier contact; calendar: production deadline | `production.send` | Artwork missing → blocked; daily check emits `artwork.missing` alert when deadline − 2 days | `production.sent` |
| C4 | Supplier confirms / in production / ready | Prod. Mgr (MVP) / Supplier (P2 portal) | — | timestamps | `SENT → CONFIRMED → IN_PRODUCTION → READY` | Deadline tomorrow / overdue alerts | `production.update` | Overdue → alert critical | status change |
| C5 | Complete | Prod. Mgr | `READY`, delivered | production cost lines priced from tariffs / supplier quote | `→ COMPLETED` | Notify buyer; auto-create installation job DRAFT | `production.complete` | — | `production.completed` |

## Flow D — Installation, evidence, activation

| # | Transition | Actor | Preconditions | DB changes | Status | Notifications / Tasks | Permission | Failure cases | Audit |
|---|---|---|---|---|---|---|---|---|---|
| D1 | Installation job created | System (after C5) or buyer | location APPROVED/IN_PRODUCTION | `field_job` type INSTALLATION, `field_job_item` per confirmed booking (mount pos, faces, arrow, material, service) | job `DRAFT` | Task "Assign installation" | `field_job.create` | — | `field_job.created` |
| D2 | Assign decorator | Buyer | assignee has Decorator role, active membership | `assigned_membership_id` / team org, `scheduled_date`; installation cost lines **priced (estimate)** from tariff (support+service+decorator+area+client) | `DRAFT → ASSIGNED`; location `→ READY_FOR_INSTALLATION` | Decorator: in-app + email "7 installations – Carrefour Sinaia"; calendar event | `field_job.assign` | No matching tariff → warning, line left unpriced with task for Finance | `field_job.assigned` |
| D3 | Decorator works on site | Decorator (mobile) | job ASSIGNED/IN_PROGRESS; item in job | first action flips job | `→ IN_PROGRESS` | — | `field_job.execute` S | — | — |
| D4 | Upload evidence per position | Decorator | item belongs to their job | `file_object` (upload via presigned URL) + `evidence` (item, mount pos, kind=INSTALLATION, captured_at from EXIF or device, **GPS** from device, uploader) | item `→ SUBMITTED` | — | `evidence.upload` S | Offline → queued client-side, retried with idempotency key; GPS > X m from asset → flagged `gps_mismatch` (not blocked); missing GPS allowed but flagged | `evidence.uploaded` |
| D5 | Submit job | Decorator | every item has ≥1 evidence of required kind | — | job `→ SUBMITTED` | Buyer task "Review installation evidence" | `field_job.execute` S | Items without evidence → cannot submit (can submit partial with reason, OPD-09) | `field_job.submitted` |
| D6 | Review evidence | Buyer | job SUBMITTED | `evidence.review_status` ACCEPTED/REJECTED (+ reason) | item `→ DONE` or `→ REWORK`; bookings `CONFIRMED → INSTALLED`; job `→ COMPLETED` when all DONE | Rejection → decorator notified | `evidence.review` (human only) | — | `evidence.accepted/rejected` |
| D7 | Location goes live | System | all confirmed bookings INSTALLED (OPD-09 for partial) | `live_at`; installation cost lines → `CONFIRMED` (snapshot locked) | location `→ LIVE` | Client/agency: "Carrefour Sinaia is LIVE – 7/7 installed"; calendar | system | — | `location.live` |

## Flow E — Monitoring, expiry, removal

| # | Transition | Actor | Preconditions | DB changes | Status | Notifications / Tasks | Permission | Failure cases | Audit |
|---|---|---|---|---|---|---|---|---|---|
| E1 | Monitoring | Scheduler hourly | location LIVE | none (read models) | — | Missing evidence > 24 h after scheduled date → alert; maintenance requests → MAINTENANCE job | — | — | — |
| E2 | Expiry reminder | Scheduler daily | `end_date − 7 d` (tenant-configurable) reached; not already done (dedupe key) | `field_job` REMOVAL DRAFT with items for all INSTALLED bookings; task | location `LIVE → REMOVAL_DUE`; bookings `INSTALLED → REMOVAL_REQUIRED` | Buyer: "Campaign expires in 7 days" + task "Assign removal" | system | Campaign extended (end date changed) → cancel removal job, location back to LIVE | `location.removal_due` |
| E3 | Removal not assigned | Scheduler | removal job DRAFT at `end_date − 3 d` | — | — | Escalation alert to buyer + management (critical) | — | — | — |
| E4 | Assign removal | Buyer | — | as D2, service = NEUTRALISATION/REMOVAL | job `ASSIGNED` | Decorator notified | `field_job.assign` | — | — |
| E5 | Removal evidence | Decorator | — | `evidence` kind=REMOVAL | items `SUBMITTED` | — | `evidence.upload` S | — | — |
| E6 | Accept removal | Buyer | — | bookings `→ REMOVED` (face occupancy ends ⇒ **position Available**), removal cost lines confirmed | job `COMPLETED`; location `→ COMPLETED` when all removed | Client: campaign report ready (P2 richer) | `evidence.review` | Removal overdue (after end date + grace) → **critical** dashboard alert every day until done [R§35 example] | `booking.removed`, `location.completed` |

## Flow F — Commercial closure & reporting

| # | Step | Actor | Effect |
|---|---|---|---|
| F1 | Rental revenue/cost lines | System on booking CONFIRMED | Revenue line (OOH rental, sell tariff for client/support/area/period) + cost line (asset rent or sublease from `asset_terms` valid at booking period). Status `DRAFT` (editable). |
| F2 | Service lines | System on job completion | Production / installation / removal cost + revenue lines, priced from tariffs, snapshot stored. |
| F3 | Manual adjustments | Finance / Buyer | Add/override lines with reason; overrides of tariff-priced lines keep original in snapshot. |
| F4 | Lock | Finance | Location closed → lines `LOCKED` (immutable; corrections only via adjustment lines). |
| F5 | Billable items | Finance | Revenue lines grouped into billable items (`billing_status READY`) → export (MVP CSV; P2 invoicing API). |
| F6 | Reporting | Mgmt | GP & GM% per location / campaign / client / period via views. |

## Flow G — Sales pipeline

Lead captured → activities logged → stage moves (configurable) → WON (requires estimated value, closing date) →
"Create Brief" pre-filled with organisation, contact and opportunity → Flow A from A2'. LOST requires a reason.
Overdue `next_follow_up_date` produces an alert ("Sales follow-up overdue" [R§30]).
