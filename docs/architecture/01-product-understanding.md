# 01 — Product Understanding & Requirement Analysis

## 1. The product in one paragraph

An OOH (Out-of-Home) company takes a client's request ("we open a Carrefour in Sinaia, we need directional
flags around it"). Today it researches positions in Google Maps and Street View, builds a My Maps, pastes
screenshots into a study, gets approval by email, orders printing, sends decorators out with WhatsApp photos,
tracks costs in Excel and hopes someone remembers to take the flags down afterwards. The platform replaces
this with **one system of record** built around three ideas:

1. **Reusable inventory.** Every pole, billboard or wall that has ever been researched becomes a permanent
   asset with a location, owner, photos, cost terms and booking history. The next study near Sinaia starts
   from known inventory instead of from zero. [R§13–14]
2. **The operational unit is the Campaign Location** (one store or point), not the Campaign. Each location
   moves through research → study → approval → production → installation → live → removal on its own
   timeline. [R§12]
3. **The system drives the workflow.** Approvals create production requirements, production creates field
   jobs, end dates create removal jobs, and deadlines create alerts. Staff confirm and decide; they don't
   carry state between tools. AI drafts and summarises but never decides. [R§2, R§39]

It is a **vertical operations system** (CRM-lite + GIS + inventory + field ops + job costing) for an OOH
buyer/operator, designed multi-tenant from day one so it can later be sold as SaaS. [R§1, R§5]

## 2. Structured extraction (the 25 requested dimensions)

| # | Dimension | What the roadmap says |
|---|---|---|
| 1 | **Product vision** | Single operating environment replacing Excel + Maps + Street View + email + photo folders + manual reminders. "Do not reproduce an inefficient offline workflow." [R§50] |
| 2 | **Business model** | (a) The tenant earns margin on OOH rental plus services (production, installation, maintenance, neutralisation) sold to direct clients and agencies. Inventory is either **direct** (rented from an owner such as a local authority) or **subleased** (bought from another OOH supplier). Production and installation are outsourced. [R§22, R§31–32] (b) The platform itself is SaaS later. [R§1, R§45] |
| 3 | **Business workflows** | Brief → Research → Study → Approval → Production → Installation → Monitoring → Removal → Costs → Reporting [R§1]; Sales pipeline [R§7]; Email-to-Brief [R§11]; Removal at expiry [R§27]. |
| 4 | **User types** | Internal staff, external partners (decorators, production suppliers, OOH suppliers), customers (agency users, end clients), viewers, platform operator. [R§3] |
| 5 | **Roles** | Super Admin; Company Admin, Management, OOH Buyer/Account Manager, Sales, Finance/Commercial, Production Manager; Decorator, Production Supplier, OOH Supplier, Agency User, End Client, Viewer. Multiple roles per user. [R§3] |
| 6 | **Permissions** | RBAC; external users restricted (agency → its clients' campaigns; client → own campaigns; decorator → only assigned jobs). [R§3, R§24, R§37, R§47E] |
| 7 | **Core domains** | 14 domains sharing one central data model. [R§4] |
| 8 | **Entities** | Preliminary list in [R§41]; explicitly "final schema only after flows and edge cases are defined." |
| 9 | **Relationships** | Company ⇄ Campaign ⇄ Campaign Location ⇄ OOH Asset ⇄ Campaign Position ⇄ Production ⇄ Field Job ⇄ Cost must be finalised early. [R§47B] |
| 10 | **User journeys** | Email→Brief→Campaign→Store→Map Research→Study→Approval→Production→Installation→Evidence→Active→Removal→Costs→Reporting. [R§47A] |
| 11 | **Operational workflows** | Research [R§17], study [R§20], approval [R§21], production [R§22], field [R§23–25], monitoring [R§26], removal [R§27]. |
| 12 | **State transitions** | Controlled transitions for campaign, asset, study, installation, removal [R§47D]; **several simultaneous status dimensions** for a location: verification, availability, client decision, execution, end-of-campaign [R§18]. |
| 13 | **Financial logic** | Cost types and revenue types; Gross Profit = Revenue − Direct Cost; Gross Margin % = GP / Revenue; direct vs subleased acquisition; versioned tariffs Support+Service(+Supplier+Decorator+Area+Client+Effective date); structured billable items, not accounting. [R§31–34] |
| 14 | **Multi-tenancy** | Independent companies, secure isolation, one tenant at first but architecture ready. [R§5] |
| 15 | **GIS** | Geocode, reverse geocode, click-to-add, Street View, distance, driving route, direction to store, arrows, POIs, filtering, availability, history; thousands–tens of thousands of records with clustering. [R§16, R§48] |
| 16 | **AI** | Brief extraction, research scoring, study drafts, account/campaign/financial/sales assistants, reporting summaries, communication drafts. Editable, auditable, advisory. Hard prohibitions list. [R§19, R§38–39] |
| 17 | **External integrations** | Google Maps Platform (Maps, Street View, Geocoding, Routes, Places); email; invoicing (Romanian providers); newsletter platform; external calendars; later traffic/pedestrian data. [R§9, R§16, R§34, R§44–45] |
| 18 | **Mobile** | Decorator mobile interface: today's jobs, map, GPS, reference photo, Street View, material, arrow, instructions, evidence upload with auto metadata. No check-in/out, no signature, no permanent GPS tracking. [R§24, R§46] |
| 19 | **Security** | Tenant isolation, RBAC, secure auth, audit logs, secure external portal. [R§40, R§48] |
| 20 | **Non-functional** | Performance for large map datasets, SaaS scalability, mobile UX, data integrity (no duplicate assets, duplicate tariffs, double booking, invalid transitions), configurability. [R§48] |
| 21 | **MVP** | Foundation, OOH Core, Operations, Commercial, Workflow, limited AI. [R§43] |
| 22 | **Phase 2** | Advanced client portal, supplier portal, invoicing integration, external calendar, sales automation, newsletter integration, reporting dashboards, financial analytics, advanced campaign reporting, document templates, automatic PDF/Excel deliverables, richer mobile. [R§44] |
| 23 | **Phase 3** | Traffic & pedestrian data, automated scoring, advanced AI recommendations, installer route optimisation, predictive availability, pricing recommendations, utilisation analytics, sales insights, SaaS self-onboarding and subscription billing. [R§45] |
| 24 | **Excluded from initial build** | Accounting software, design tools, complex marketing automation, Salesforce-class CRM, permanent GPS tracking, AI legal approval, fully automated field validation, complex lead scoring, complex forecasting. [R§46] |
| 25 | **Development sequence** | 20 steps from Architecture to Advanced Analytics. [R§51] |

## 3. Requirement analysis per major capability

Legend — **Phase**: MVP / P2 / P3. Tables named here are defined in [05-domain-model.md](05-domain-model.md).

### 3.1 Multi-tenancy [R§5] — MVP
- **Means:** every business record belongs to exactly one tenant (an OOH company); no tenant can read or reference another's data.
- **Why:** SaaS future; also protects clients' commercial data.
- **Users:** everyone implicitly; Super Admin manages tenants.
- **Entities / tables:** `tenant`, `membership`; `tenant_id` on every tenant-owned table.
- **Backend:** tenant context resolution, RLS session variables, tenant-scoped storage, cache and job payloads.
- **Screens:** tenant switcher (users with multiple memberships), platform admin → tenants.
- **Permissions:** `platform.*` for Super Admin only.
- **Dependents:** everything.

### 3.2 Authentication, users, RBAC [R§3] — MVP
- **Means:** secure login; one person may hold several roles; roles are configurable; external users are scoped.
- **Entities:** `user` (global identity), `membership` (user × tenant), `role`, `role_permission`, `membership_role`, `refresh_token`, `invitation`.
- **Backend:** auth module (argon2id, JWT access + rotating refresh), permission guard, scope resolver.
- **Screens:** login, forgot/reset password, accept invitation, Admin → Users, Roles & Permissions.
- **Dependents:** every module; portals and decorator app especially.

### 3.3 Organisations (CRM company database) + contacts [R§6] — MVP
- **Means:** one record per real-world company, with **multiple classifications** (prospect, client, agency, OOH supplier, print supplier, support owner, subcontractor, partner). Never duplicate a company because it plays two roles.
- **Entities:** `organisation`, `organisation_classification`, `contact`, `organisation_relationship` (agency ↔ end client).
- **Backend:** CRUD, duplicate detection (VAT number exact, name fuzzy via `pg_trgm`), merge (P2).
- **Screens:** Companies list, **Company 360°** [R§36], Contacts list, contact detail.
- **Permissions:** `organisation.read/create/update/delete/export`, `contact.*`.
- **Dependents:** opportunities, briefs, campaigns (client/agency), inventory (owner/supplier), production (supplier), field ops (decorator teams), tariffs (client/supplier/decorator dimensions).
- Naming note: the roadmap uses "Company" both for the tenant and the CRM record. In code: **Tenant** = the OOH company using the platform; **Organisation** = a CRM company. UI can still say "Company".

### 3.4 Basic Sales CRM [R§7–8] — MVP (lightweight)
- **Means:** opportunities through a configurable pipeline, activity timeline per company, follow-ups; WON → create Brief/Campaign.
- **Entities:** `pipeline`, `pipeline_stage`, `opportunity`, `activity`, `lead` (see OPD-01).
- **Screens:** Pipeline (kanban), Opportunities list, opportunity detail, timeline on Company 360°.
- **Permissions:** `opportunity.*` with scope own/all, `activity.*`.
- **Dependents:** briefs (source), dashboard sales tiles, AI sales assistant (P2).

### 3.5 Marketing lists [R§9] — **not in MVP list**; SHOULD/P2
- **Means:** static/tagged lists of contacts + consent fields; sending happens in an external platform.
- **Entities:** `marketing_list`, `marketing_list_member`, consent columns on `contact`.
- The consent columns are cheap and GDPR-relevant, so they go in with `contact` in MVP; list management UI is later.

### 3.6 Brief management + Email-to-Brief [R§10–11] — MVP
- **Means:** the operational entry point; created manually, from a WON opportunity, from an email (AI draft), later via portal/API. AI drafts stay drafts until a human confirms.
- **Entities:** `brief`, `brief_line` (one per requested store/location), `inbound_email`, `ai_run`, `file_link`.
- **Backend:** brief service, inbound email webhook, AI extraction job (structured output), conversion to campaign.
- **Screens:** Requests inbox (drafts + emails), brief editor with AI-extracted fields highlighted, convert dialog.
- **Permissions:** `brief.create/update/confirm/convert`.

### 3.7 Campaign + Campaign Location [R§12] — MVP
- **Means:** Campaign = commercial umbrella; Campaign Location = one store/point, **operationally independent** (own dates, supports, research, study, approval, production, installation, decorator, suppliers, costs, status).
- **Entities:** `campaign`, `campaign_location`.
- **Screens:** Campaigns list, campaign overview (map of all its locations, rollup), **Campaign Location workspace** (the main work screen).
- **Dependents:** everything downstream.

### 3.8 OOH Inventory + Digital Passport [R§13–15] — MVP
- **Means:** permanent reusable assets with a common parent (OOH Asset) and type-specific attributes. Poles have up to two **mount positions**, each holding a flag with **Face A / Face B**. Dimensions configurable.
- **Entities:** `asset_type`, `ooh_asset`, `mount_position`, `advertising_face`, `asset_terms` (owner/supplier/acquisition/rent, versioned), `asset_verification`, `asset_block`, `face_booking`, `dimension_preset`.
- **Backend:** inventory service, duplicate detection by proximity, availability computation, asset history.
- **Screens:** Inventory (one list, type tabs), asset passport, create/edit asset (map-assisted).
- **Permissions:** `asset.*`, `asset.verify`, `asset.set_availability` (humans only — AI can never hold it).

### 3.9 OOH Map & Research [R§16–17, R§19] — MVP (AI scoring P3; basic AI hints MVP-optional)
- **Means:** from a Campaign Location's store, see inventory around it, click to add candidates (auto GPS + reverse geocode), Street View, distance, driving route, direction/arrow, POIs, filters, availability, history.
- **Entities:** `candidate_position`, `ooh_asset`, `campaign_location` (store point), `geo_area`.
- **Backend:** geo module (PostGIS queries, provider adapters for geocoding/routes), viewport/cluster endpoints.
- **Screens:** OOH Map (global), Research tab inside Campaign Location.
- **Permissions:** `research.*`, `asset.create`.

### 3.10 Study generation + Client approval [R§20–21] — MVP (PDF/Excel automatic deliverables = P2)
- **Means:** buyer selects candidates → study draft (with AI-drafted descriptions) → buyer approves → published to portal → client/agency approves/rejects/comments per position → workflow updates automatically.
- **Entities:** `study`, `study_item` (snapshotted), `client_decision`, `comment`.
- **Screens:** Study builder, study preview, portal study view with per-position approve/reject/comment.
- **Permissions:** `study.create/publish`, `study.decide` (external client/agency), `study.decide_on_behalf` (internal, see OPD-06).

### 3.11 Production [R§22] — MVP
- **Means:** approved positions automatically produce a production requirement (counts by dimension and arrow); a Production Order goes to an outsourced supplier with artwork received from the client.
- **Entities:** `production_order`, `production_item`, artwork via `file_link(purpose=ARTWORK)`.
- **Screens:** Operations → Production board, order detail. Supplier portal is P2 (MVP: order emailed as PDF/link).
- **Permissions:** `production.*` (Production Manager).

### 3.12 Field operations + Decorator mobile + Evidence [R§23–25] — MVP
- **Means:** installation/maintenance/removal jobs assigned to decorators; mobile list of today's jobs; per-position evidence with auto metadata (user, time, GPS, campaign, position).
- **Entities:** `field_job`, `field_job_item`, `evidence`, `file_object`.
- **Screens:** Operations → Installation/Maintenance/Removal boards; **Field app** (`/field`) — Today, job detail, position detail, camera upload.
- **Permissions:** `field_job.assign`, `field_job.execute:assigned`, `evidence.upload:assigned`, `evidence.review`.

### 3.13 Monitoring + Removal [R§26–27] — MVP
- **Means:** accepted installation evidence activates the location; expiry automatically triggers reminder → removal job → assignment → evidence → close → position available. Missed removals are a stated operational risk.
- **Backend:** scheduler (daily + hourly scans), idempotent automation rules, notifications.
- **Screens:** Monitoring view (live locations, missing evidence, upcoming removals), dashboard alerts.

### 3.14 Commercial engine + Tariffs [R§31–34] — MVP (billing integration P2)
- **Means:** cost and revenue lines per campaign/location/asset; GP and GM%; direct vs subleased; native, versioned, non-duplicating tariffs; historical jobs never re-priced; billable items prepared for later invoicing export.
- **Entities:** `service`, `tariff_rule`, `commercial_line` (direction COST/REVENUE, snapshot), `asset_terms`, `geo_area`.
- **Screens:** Commercial → Tariffs, Costs, Revenue, Margins; Financials tab on Campaign Location and Campaign.
- **Permissions:** `tariff.*`, `commercial.read/write`, field-level hiding of cost/margin.

### 3.15 Tasks, Calendar, Notifications [R§28–30] — MVP
- **Means:** one task engine with categories and related objects; an *operational* calendar computed from real deadlines; event-driven, actionable notifications (in-app + email in MVP).
- **Entities:** `task`, `calendar_event` (manual only; the rest is a read model), `notification`, `notification_preference`, `automation_rule`.

### 3.16 Dashboard + Company 360° + Reporting [R§35–36] — MVP (control tower); P2 dashboards/analytics
### 3.17 Client/Agency campaign portal [R§37] — MVP: study approval + basic status/photos; P2: advanced portal
### 3.18 AI Assistant [R§38–39] — MVP subset: email-to-brief, study draft support, campaign summaries, operational alerts, basic queries
### 3.19 Audit trail [R§40] — MVP
### 3.20 Documents/files [R§47G] — MVP
### 3.21 Configuration / nomenclatures [R§48 Configurability] — MVP
Asset types, dimensions, services, pipeline stages, activity types, organisation classifications, cost/revenue categories, task categories, notification rules, geo areas.

## 4. What the roadmap deliberately leaves open

The roadmap says the final schema must follow user flows and edge cases [R§41]. The places where the
document is ambiguous, and where a guess would be expensive to reverse, are collected in
[open-product-decisions.md](../open-product-decisions.md). Each has a recommended default so work can continue.
