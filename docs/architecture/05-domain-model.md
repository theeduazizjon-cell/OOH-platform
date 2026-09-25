# 05 — Domain Model

Conventions: every table has `id uuid` (UUIDv7, time-ordered, generated in app), `tenant_id` (except global
tables), `created_at`, `updated_at`, `created_by`, `version int` (optimistic locking). Classification used below:
**Core** (aggregate root), **Tx** (transactional), **Hist** (append-only history), **Cfg** (tenant configuration/lookup),
**Poly** (polymorphic reference), **Ver** (versioned), **SD** (soft delete via `archived_at`), **Aud** (field-level audit).

## 1. Key modelling decisions

### 1.1 Company ≠ Tenant

`tenant` = the OOH operator using the platform. `organisation` = any real-world company in its CRM. One
organisation, many classifications (M:N to `organisation_classification` config), so there's never a duplicate
company because it plays several roles [R§6].

### 1.2 The five status dimensions live on five different entities [R§18]

The roadmap says a location's statuses can't be one field. The model handles this by giving each
dimension its own owner, which removes the need for a combined status field:

| Status group    | Values                                         | Owned by                                                                                                                                                                                            |
| --------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Verification    | Not Verified / To Be Verified / Field Verified | `ooh_asset.verification_status` (a property of the physical asset, reused across campaigns)                                                                                                         |
| Availability    | Available / Reserved / Unavailable             | **Derived** for a date range from `face_booking` (TENTATIVE/CONFIRMED = Reserved; INSTALLED/REMOVAL_REQUIRED = Unavailable) + `asset_block` + asset lifecycle. Never stored, so it can never drift. |
| Client decision | Proposed / Approved / Rejected                 | `study_item.decision_status`                                                                                                                                                                        |
| Execution       | Not Scheduled / Scheduled / Installed          | `field_job_item` (installation) status, reflected on `face_booking`                                                                                                                                 |
| End of campaign | Active / Removal Required / Removed            | `face_booking.status`                                                                                                                                                                               |

The UI shows one simplified badge computed from these [R§18 last sentence].

### 1.3 Inventory hierarchy (Asset → Mount Position → Advertising Face)

```
asset_type (Cfg)  kind ∈ {POLE, BILLBOARD, PRISM, MESH, WALL, OTHER}
  │ template: default mount positions, faces per mount, booking mode, attribute schema (JSON Schema)
  ▼
ooh_asset (Core, SD, Aud)                    one physical structure at one place
  ├── mount_position (Core child)            physical slot: POLE has max 2 (DB CHECK via type template)
  │     position_no, orientation_bearing, height, bracket notes
  │     └── advertising_face (Core child)    FACE A / FACE B: printable surface
  │           face_code, facing_bearing, visible_traffic_direction, dimension (w×h, configurable),
  │           illuminated, …
  ├── asset_terms (Ver)                      owner org, supplier org, acquisition DIRECT/SUBLEASED,
  │                                          rent/purchase cost + unit, valid_period  (history kept)
  ├── asset_verification (Hist)              who/when/evidence
  ├── asset_block (Tx)                       manual unavailability windows with reason
  └── face_booking (Tx, Hist)                the reservation of a face for a campaign location + period
```

- **Mount position vs face** are separate tables [R§15]. A flag hangs in a mount position and prints on two faces.
- **Booking unit = advertising face** for every asset type (OPD-02). For flags the type template says
  `faces_booked_together = true`, so selecting a mount position books both faces A and B in one action, while each
  face keeps its own creative/arrow (`face_booking.creative_direction ∈ LEFT/RIGHT/STRAIGHT/…, message`).
  Billboards can book faces independently. One rule for double-booking then covers all asset types.
- **Specialised attributes**: common columns on `ooh_asset`. Type-specific simple attributes (pole material,
  prism rotation count, mesh surface area, wall permit ref) go in `attributes jsonb`, validated against
  `asset_type.attribute_schema` at write time. Only _structural_ differences (mounts/faces) get tables. This is
  composition rather than table-per-type inheritance, chosen because it lets new types be added by configuration [R§48].
- **Dimensions** are configurable presets (`dimension_preset`: 0.8×2, 0.8×1.2, 0.8×1.4 …) copied as values
  onto the face, so editing a preset never rewrites history.

### 1.4 Candidate positions reference real assets

Every candidate added by clicking the map creates an `ooh_asset` in lifecycle `PROSPECTIVE` (OPD-04). Research
knowledge then accumulates even for positions the client rejected [R§13 "permanent reusable assets"].
Duplicate prevention: `(tenant_id, code)` is unique; spatial proximity check (`ST_DWithin` 10 m, same kind) is a
blocking warning with an audited override.

### 1.5 Studies are snapshots

`study_item.snapshot jsonb` freezes what the client saw (address, distance, photos, arrow, recommendation) when
it was published. Later edits to the asset don't rewrite a sent study. A revision is a new `study.version`.

### 1.6 Money is never recalculated

`commercial_line` stores quantity, unit price, amount, currency, **tariff_rule_id + tariff snapshot**, and
`pricing_source ∈ TARIFF / ASSET_TERMS / MANUAL / OVERRIDE`. Totals are always sums of stored lines.
Changing a tariff never changes existing lines [R§33]. Locked lines are immutable (trigger), and corrections are
made by adding adjustment lines.

### 1.7 The calendar is mostly a read model

Production deadlines, installation dates, campaign start/end and removal deadlines already exist on their
entities. The calendar is a SQL view that UNIONs them. `calendar_event` stores only manual events.
Duplicating dates into an events table would create drift [R§29].

## 2. Entity catalogue

### identity

| Entity          | Type     | Key fields                                                                                                   | Notes                        |
| --------------- | -------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| tenant          | Core     | name, slug (unique), locale, timezone (`Europe/Bucharest`), default_currency (`RON`), settings jsonb, status | Global table                 |
| user            | Core, SD | email (citext, unique), password_hash (argon2id), name, phone, locale, mfa (P2)                              | Global                       |
| membership      | Core, SD | tenant_id, user_id, kind INTERNAL/EXTERNAL, organisation_id?, status, invited_by                             | unique (tenant_id, user_id)  |
| role            | Cfg      | tenant_id, key, name, is_system, is_external                                                                 | unique (tenant_id, key)      |
| role_permission | Cfg      | role_id, permission_key, scope ALL/OWN/ASSIGNED/ORGANISATION                                                 | PK (role_id, permission_key) |
| membership_role | Tx       | membership_id, role_id                                                                                       | PK both                      |
| invitation      | Tx       | tenant_id, email, role_ids, organisation_id?, token_hash, expires_at, accepted_at                            |                              |
| refresh_token   | Tx       | user_id, family_id, token_hash, expires_at, revoked_at, replaced_by, ip, user_agent                          | rotation + reuse detection   |
| platform_admin  | Cfg      | user_id                                                                                                      | Super Admin                  |
| api_key (P2)    | Cfg      | tenant_id, prefix, hash, scopes, last_used_at                                                                |                              |

### config (all Cfg, tenant-scoped, soft-disable via `active=false`)

asset_type, dimension_preset, service (kind: RENTAL/PRODUCTION/INSTALLATION/MAINTENANCE/REMOVAL/TRANSPORT/OTHER,
unit), organisation_classification, activity_type, pipeline, pipeline_stage (order, **semantic kind OPEN/WON/LOST**),
cost_category, task_category, geo_area (name, kind COUNTY/CITY/CUSTOM, `geom MultiPolygon`), automation_rule
(key, offset days, enabled), notification_template.

### crm

| Entity                           | Type          | Key fields                                                                                                                                                                                                              | Relations                           |
| -------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| organisation                     | Core, SD, Aud | legal_name, display_name, vat_number (unique per tenant when present), website, address, city, county, country, industry, status, account_owner_membership_id, notes, latest_update (human or AI), latest_update_source | M:N classification                  |
| organisation_classification_link | Tx            | organisation_id, classification_id                                                                                                                                                                                      |                                     |
| organisation_relationship        | Tx            | from_org, to_org, kind (AGENCY_OF / SUPPLIER_TO / PARENT_OF)                                                                                                                                                            | agency ↔ client                     |
| contact                          | Core, SD      | organisation_id, first/last name, position, phone, email, linkedin, is_decision_maker, is_primary, newsletter_eligible, consent_status, consent_source, consent_at, unsubscribed_at, tags[]                             |                                     |
| lead                             | Core          | see OPD-01                                                                                                                                                                                                              | converts to org+contact+opportunity |
| opportunity                      | Core, SD, Aud | organisation_id, contact_id, owner_membership_id, name, estimated_value (money), expected_close_date, probability, interested_service_ids[], pipeline_stage_id, source, next_action, next_follow_up_date, lost_reason   | 1:N brief                           |
| activity                         | Hist          | organisation_id (required), contact_id?, opportunity_id?, campaign_id?, type, occurred_at, subject, body, author                                                                                                        | timeline                            |
| marketing_list / _member         | Tx            | name, segment tags / contact_id, added_at                                                                                                                                                                               | SHOULD                              |

### briefs & campaigns

| Entity            | Type          | Key fields                                                                                                                                                                                                                                                                            |
| ----------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| inbound_email     | Hist          | tenant_id, message_id (unique), from, to, subject, received_at, raw_file_id, classification, brief_id?                                                                                                                                                                                |
| brief             | Core, Aud     | source MANUAL/OPPORTUNITY/EMAIL/PORTAL/API, status, agency_org_id?, client_org_id?, opportunity_id?, inbound_email_id?, title, requested_start/end, deadline, budget (money?), special_requirements, ai_generated, field_provenance jsonb (`{field: AI/HUMAN/AI_EDITED}`), ai_run_id? |
| brief_line        | Tx            | brief_id, store_name, address, city, county, requested_asset_type_id?, requested_units, dimension text/preset, start/end                                                                                                                                                              |
| campaign          | Core, SD, Aud | code (unique per tenant), name, client_org_id, agency_org_id?, opportunity_id?, owner_membership_id (buyer), status, notes; start/end **derived** from locations (view)                                                                                                               |
| campaign_location | Core, SD, Aud | campaign_id, brief_line_id?, name ("Carrefour Sinaia"), address, city, county, **store_point geography(Point)**, geocode_status, place_id, start_date, end_date, requested_units, requested_asset_type_id, buyer_membership_id, status, live_at, completed_at, research_radius_m      |

### inventory

| Entity             | Type          | Key fields                                                                                                                                                                                                                                                                                                                      |
| ------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ooh_asset          | Core, SD, Aud | code (e.g. POLE-001245, unique per tenant, generated per type prefix), asset_type_id, **location geography(Point)**, address, city, county, geo_area_id?, lifecycle PROSPECTIVE/ACTIVE/SUSPENDED/DECOMMISSIONED, verification_status, last_verified_at, street_view_ref (pano id, heading, pitch, fov), attributes jsonb, notes |
| mount_position     | Core          | asset_id, position_no (unique per asset), orientation_bearing, notes                                                                                                                                                                                                                                                            |
| advertising_face   | Core          | mount_position_id, face_code A/B/C (unique per mount), facing_bearing, visible_traffic_direction, width_m, height_m, dimension_preset_id?, illuminated                                                                                                                                                                          |
| asset_terms        | Ver           | asset_id, acquisition DIRECT/SUBLEASED, owner_org_id?, supplier_org_id?, cost_amount, cost_unit (MONTH/DAY/CAMPAIGN), currency, valid_period daterange, contract_ref; **exclusion: no overlapping periods per asset**                                                                                                           |
| asset_verification | Hist          | asset_id, verified_by, verified_at, result, notes, evidence files                                                                                                                                                                                                                                                               |
| asset_block        | Tx            | asset_id or face_id, period daterange, reason, created_by                                                                                                                                                                                                                                                                       |
| face_booking       | Tx, Hist      | face_id, campaign_location_id, study_item_id?, period daterange, status, creative_direction, creative_message, hold_expires_at                                                                                                                                                                                                  |

### research & approval

| Entity             | Type           | Key fields                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------ | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| candidate_position | Tx             | campaign_location_id, asset_id, mount_position_id?, status SHORTLISTED/SELECTED/DISCARDED, distance_m (PostGIS, straight), route_distance_m, route_duration_s, route_polyline, bearing_to_store, suggested_direction, direction (buyer-confirmed), traffic_direction, visibility_notes, observations, estimated_cost (money), buyer_recommendation, ai_score jsonb?; unique (campaign_location_id, mount_position_id) |
| study              | Core, Ver, Aud | campaign_location_id, version (unique per location), status, summary (AI draft flag), published_at, published_by, decided_at                                                                                                                                                                                                                                                                                          |
| study_item         | Tx             | study_id, candidate_position_id, sort_order, description, recommendation, snapshot jsonb, decision_status                                                                                                                                                                                                                                                                                                             |
| client_decision    | Hist           | study_item_id, decision APPROVED/REJECTED, decided_by_membership_id, on_behalf_of_org_id?, on_behalf_evidence_file_id?, comment, decided_at, ip, user_agent (append-only; latest row wins)                                                                                                                                                                                                                            |

### production & field

| Entity           | Type      | Key fields                                                                                                                                                                                                                                                                                   |
| ---------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| production_order | Core, Aud | campaign_location_id, supplier_org_id, deadline, status, artwork_status, sent_at, notes, order_number                                                                                                                                                                                        |
| production_item  | Tx        | order_id, material/asset type, width_m, height_m, direction, quantity, face_booking_ids uuid[] (traceability)                                                                                                                                                                                |
| field_job        | Core, Aud | type INSTALLATION/MAINTENANCE/REPAIR/REMOVAL/VERIFICATION, campaign_location_id?, assigned_membership_id?, assigned_team_org_id?, scheduled_date, due_date, status, instructions, dedupe_key                                                                                                 |
| field_job_item   | Tx        | field_job_id, face_booking_id? / mount_position_id / asset_id, service_id, material, direction, instructions, status, evidence_required (kinds[])                                                                                                                                            |
| evidence         | Hist      | field_job_item_id, asset_id, mount_position_id?, face_id?, kind BEFORE/INSTALLATION/MAINTENANCE/REMOVAL/VERIFICATION, file_id, captured_at, uploaded_at, uploaded_by, **gps geography(Point)?**, gps_accuracy_m, gps_distance_m (to asset), flags[], review_status, reviewed_by, review_note |

### commercial

| Entity          | Type     | Key fields                                                                                                                                                                                                                                                                                                                                              |
| --------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tariff_rule     | Ver, Aud | direction SELL/COST, asset_type_id?, service_id (required), supplier_org_id?, decorator_org_id?, geo_area_id?, client_org_id?, valid_period daterange, amount, currency, unit, status DRAFT/ACTIVE/RETIRED, supersedes_id?, `dimension_key` (generated), `specificity` (generated)                                                                      |
| commercial_line | Tx, Aud  | direction COST/REVENUE, category, service_id, campaign_id, campaign_location_id, face_booking_id?, field_job_item_id?, production_order_id?, counterparty_org_id?, quantity, unit, unit_price, amount, currency, pricing_source, tariff_rule_id?, pricing_snapshot jsonb, status DRAFT/CONFIRMED/LOCKED, billing_status (REVENUE only), override_reason |

### work

| Entity                  | Type       | Key fields                                                                                                                                                                                                                                                                                |
| ----------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| task                    | Core, Poly | category, title, notes, subject_type + subject_id (Poly), organisation_id?, campaign_id? (denormalised for "visible on company/campaign" [R§28]), assignee_membership_id, due_at, priority, status OPEN/IN_PROGRESS/DONE/CANCELLED, source USER/SYSTEM, dedupe_key (unique when not null) |
| calendar_event          | Tx         | manual events only                                                                                                                                                                                                                                                                        |
| notification            | Tx         | recipient_membership_id, type, title, body, subject_type/id, severity INFO/WARNING/CRITICAL, read_at, dedupe_key                                                                                                                                                                          |
| notification_delivery   | Hist       | notification_id, channel IN_APP/EMAIL, status, sent_at, error                                                                                                                                                                                                                             |
| notification_preference | Cfg        | membership_id, type, channel, enabled                                                                                                                                                                                                                                                     |

### cross-cutting

| Entity         | Type | Key fields                                                                                                                                                                                       |
| -------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| file_object    | Core | storage_key, original_name, mime, size, sha256, status PENDING/READY/QUARANTINED, width/height/duration, exif jsonb, derivatives jsonb (thumb/preview keys), uploaded_by                         |
| file_link      | Poly | file_id, subject_type, subject_id, purpose (ARTWORK/ASSET_PHOTO/SIMULATION/STUDY_EXPORT/ATTACHMENT/…), visibility INTERNAL/EXTERNAL. **Evidence uses a real FK instead**, because it's critical. |
| comment        | Poly | subject_type, subject_id, body, visibility INTERNAL/EXTERNAL, author, parent_id                                                                                                                  |
| audit_event    | Hist | actor_type USER/SYSTEM/AI/API, actor_membership_id?, action, subject_type/id, changes jsonb (before/after of changed fields), request_id, ip, occurred_at. Append-only, monthly partitions       |
| status_history | Hist | subject_type/id, from, to, action, actor, reason, at                                                                                                                                             |
| outbox_event   | Tx   | event_type, payload, occurred_at, dispatched_at, attempts                                                                                                                                        |
| ai_run         | Hist | feature, model, prompt_version, input_refs, output jsonb, tokens_in/out, cost, latency, status, requested_by                                                                                     |
| ai_suggestion  | Tx   | ai_run_id, subject_type/id, proposal jsonb, status PENDING/ACCEPTED/EDITED/REJECTED, resolved_by                                                                                                 |

## 3. Polymorphism policy

Polymorphic references (`subject_type`, `subject_id`) are allowed only for _attachments to anything_: task,
comment, file_link, audit_event, notification, ai_suggestion. They have no FK, so an application-level
integrity check plus a nightly orphan report covers them. Business-critical relations always get real FKs.

## 4. Soft delete vs archive vs hard delete

- **Soft delete (`archived_at`)**: organisation, contact, opportunity, campaign, campaign_location, asset.
  Default queries exclude them. Unique constraints are partial `WHERE archived_at IS NULL` where re-creation is legitimate.
- **Never deleted**: audit_event, status_history, client_decision, evidence, commercial_line (LOCKED), inbound_email.
- **Hard delete allowed**: DRAFT rows that nothing references (draft tariff, draft brief line, candidate not in a study).
- **GDPR erasure** (contacts): anonymise PII columns in place and keep the row for referential integrity.

## 5. Versioning summary

| What                   | How                                                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| Tariffs                | New row per change (`supersedes_id`), ACTIVE rows immutable, validity periods non-overlapping per dimension key |
| Asset commercial terms | `asset_terms` rows with non-overlapping `valid_period`                                                          |
| Studies                | `study.version`, items snapshotted at publish                                                                   |
| Prices on lines        | snapshot on the line                                                                                            |
| Everything else        | `audit_event` field-level diffs + `status_history`                                                              |
