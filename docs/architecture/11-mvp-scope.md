# 11 — MVP Scope

Rule from [R§43]: the MVP is the **complete operational cycle**, not many partial features.
MUST = in the roadmap's MVP list and on the critical path of the cycle. SHOULD = in the MVP list but the cycle works
without it for a first pilot, or it's a cheap enabler. LATER = Phase 2/3 or explicitly excluded.

## MUST HAVE

**Foundation**: multi-tenant architecture (RLS), authentication, users/memberships/invitations, RBAC with configurable
roles + external scopes, organisations (multi-classification) + contacts, basic CRM (opportunities, configurable pipeline,
activities timeline, WON → brief), configurable nomenclatures (asset types, dimensions, services, stages, categories, geo areas).

**OOH Core**: Brief (manual + from opportunity + AI email draft), Campaign, Campaign Location, OOH Inventory
(asset → mount position → face, terms direct/subleased, verification, passport), map (geocode store, inventory around it,
click-to-add, reverse geocode, filters, availability, history), candidate positions, Street View, distance + driving route

- direction/arrow, study generation (online study + print-to-PDF of the preview), client approval (portal, per position
  approve/reject/comment), double-booking prevention, duplicate-asset prevention.

**Operations**: production requirement auto-generated from approvals + production order, decorator assignment,
mobile field interface (PWA), photo/video evidence per position with auto metadata, evidence review, campaign location
activation, expiration tracking, automatic removal workflow with escalation.

**Commercial**: tariff engine (versioned, dimensions, duplicate prevention, historical snapshots), cost lines, revenue lines,
direct vs subleased costs, GP and GM% per location/campaign, billable items (CSV export).

**Workflow**: central task engine, operational calendar, in-app + email notifications, deadline monitoring/automation rules.

**AI (limited)**: email-to-brief extraction, study draft support (descriptions/recommendation text), campaign summaries,
operational alerts (natural-language digest of rule-based alerts), basic assistant queries (read-only tools).

**Cross-cutting**: audit trail, structured file storage, dashboard control tower, Company 360°.

## SHOULD HAVE (MVP if time allows; first post-pilot increment)

- Marketing lists UI (consent fields themselves are MUST, because they're part of `contact`)
- Lead entity/conversion (depends on OPD-01)
- AI research hints / advisory score per candidate (R§19 describes it, but the MVP AI list doesn't include it)
- Asset CSV import (migrating existing Excel/My Maps inventory is essential for adoption; strongly recommended before pilot)
- Maintenance/repair jobs (the field job type exists; no special workflow)
- Asset verification field jobs
- SSE real-time notifications (polling in MVP)
- Basic campaign report page in portal

## LATER

**Phase 2** [R§44]: advanced client portal, supplier portal (production + OOH supplier), invoicing integration
(Romanian providers, e.g. SmartBill / Oblio / e-Factura; OPD), external calendar sync, advanced sales automation, newsletter
platform integration, reporting dashboards, financial analytics, advanced campaign reporting, document templates,
automatic PDF/Excel deliverables, richer mobile (native/offline-first), organisation merge, API keys for integrations.

**Phase 3** [R§45]: traffic & pedestrian data, automated position scoring, advanced AI recommendations, installer route
optimisation, predictive availability, pricing recommendations, inventory utilisation analytics, sales insights, SaaS
self-onboarding, subscription billing, SSO.

**Never (initial build)** [R§46]: accounting, design tools, complex marketing automation, Salesforce-class CRM,
permanent GPS tracking, AI legal approval, fully automated field validation, complex lead scoring, complex forecasting.
