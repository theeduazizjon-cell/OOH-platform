# 02 — Domain Map

The roadmap lists 14 domains that "share the same central data model" [R§4]. The backend is a **modular
monolith**: one deployable, one database, and strict module boundaries. Each module owns its tables and
exposes a service interface. Cross-module side effects travel as **domain events** through a transactional
outbox (see [08-system-architecture.md](08-system-architecture.md)). Other modules never write a module's tables directly.

## 1. Modules (bounded contexts)

| Module | Owns | Roadmap domain |
|---|---|---|
| **identity** | tenant, user, membership, role, permission, invitation, refresh_token, api_key | Admin & Config, Multi-tenant |
| **config** | nomenclatures: asset types, dimension presets, services, classifications, activity types, pipelines, cost/revenue categories, task categories, geo areas, automation rules | Admin & Config |
| **crm** | organisation, contact, organisation_relationship, lead, opportunity, activity, marketing_list | Sales, CRM & Partners |
| **briefs** | brief, brief_line, inbound_email | Requests / Brief |
| **campaigns** | campaign, campaign_location | Campaign Management |
| **inventory** | ooh_asset, mount_position, advertising_face, asset_terms, asset_verification, asset_block, **face_booking** | OOH Inventory |
| **geo** | provider adapters (geocode, reverse, routes, places, street view metadata), spatial queries, geo_area, geocode cache | OOH Map (backend half) |
| **research** | candidate_position, study, study_item, client_decision | OOH Map & Research, Study & Client Approval |
| **production** | production_order, production_item | Production |
| **field** | field_job, field_job_item, evidence | Field Operations |
| **commercial** | service, tariff_rule, commercial_line, financial read models | Commercial & Financial |
| **work** | task, calendar_event, calendar read model, notification, notification_preference | Calendar, Tasks & Notifications |
| **files** | file_object, file_link, derivatives | (cross-cutting, R§47G) |
| **collab** | comment | (cross-cutting) |
| **audit** | audit_event, status_history | (cross-cutting, R§40) |
| **ai** | ai_run, ai_suggestion, assistant conversations | AI OOH Assistant |
| **reporting** | read-only SQL views/materialised views, dashboard queries | Reporting, Dashboard |
| **portal** | no tables of its own; a *scoped facade* over research/campaigns/field/files for external users | Client / Agency Portal |
| **platform** | tenant provisioning, plans (P3) | Super Admin |

## 2. Interaction map

```
                ┌───────────┐
                │ identity  │◄──────── every module (auth context, permissions)
                └───────────┘
 ┌──────┐  WON   ┌────────┐ convert ┌───────────┐ locations ┌──────────────────┐
 │ crm  │───────►│ briefs │────────►│ campaigns │──────────►│ campaign_location │
 └──┬───┘        └───▲────┘         └─────┬─────┘           └────────┬─────────┘
    │ orgs as        │ AI draft           │                          │ store point
    │ client/agency/ │                    │                          ▼
    │ owner/supplier │              ┌─────┴────┐  candidates  ┌──────────┐  nearby/assets ┌───────────┐
    └───────────────►│              │ research │◄────────────►│   geo    │◄──────────────►│ inventory │
                     │              └─────┬────┘              └──────────┘                └─────┬─────┘
                ┌────┴──┐                 │ StudyItemApproved                                   │
                │  ai   │                 ▼                                                     │
                └───────┘           face_booking CONFIRMED  ◄───────────────────────────────────┘
                                          │
                                          ▼ PositionsApproved
                                   ┌────────────┐ OrderReady ┌────────┐ EvidenceAccepted ┌───────────┐
                                   │ production │───────────►│ field  │─────────────────►│ campaigns │ LIVE
                                   └────────────┘            └───┬────┘                  └─────┬─────┘
                                                                 │ job completed               │ end date − N days
                                                                 ▼                              ▼
                                                          ┌────────────┐                 removal field_job
                                                          │ commercial │◄── lines priced from tariffs
                                                          └────────────┘
     work (tasks / calendar / notifications) and audit listen to events from every module.
     reporting reads from everything (read-only). portal = scoped read + decide facade.
```

## 3. Key domain events (outbox)

| Event | Emitted by | Consumed by → effect |
|---|---|---|
| `opportunity.won` | crm | work → task "Create brief"; UI offers "Create Brief" |
| `brief.drafted_by_ai` | briefs | work → notify buyer "Review AI brief" |
| `brief.converted` | briefs | campaigns (already created in same tx), audit |
| `campaign_location.created` | campaigns | geo → geocode store address job; work → research task |
| `study.published` | research | inventory → tentative holds; work → notify client/agency users; task "Await approval" |
| `study_item.decided` | research | inventory → confirm/release booking; work → notify buyer; commercial → draft rental lines |
| `study.fully_decided` | research | campaigns → location `APPROVED`; production → generate production requirement |
| `production_order.completed` | production | field → create installation job (draft); work → notify buyer |
| `artwork.missing` (scheduled check) | production | work → alert + task |
| `field_job.assigned` | field | work → notify decorator |
| `evidence.submitted` | field | work → task "Review evidence" |
| `evidence.accepted` (installation) | field | inventory → booking `INSTALLED`; campaigns → location `LIVE` when all positions are installed; commercial → installation cost line priced |
| `campaign_location.expiring` (T−N days) | scheduler | field → removal job (unassigned); work → reminder + task |
| `evidence.accepted` (removal) | field | inventory → booking `REMOVED` (face free); campaigns → location `COMPLETED` when all positions are removed; commercial → removal cost line |
| `tariff.published` | commercial | audit |
| `*.overdue` (scheduled) | scheduler | work → notifications/alerts |

## 4. Shared kernel (in `packages/contracts`)

IDs (UUIDv7), money (`amount` as decimal string + ISO currency), `DateRange`, `GeoPoint {lat,lng}`,
permission catalog, status enums + transition tables, pagination envelope, error envelope (RFC 9457).
