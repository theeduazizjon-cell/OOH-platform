# 07 — Database Architecture (incl. Multi-Tenancy, GIS, Tariff Engine)

> SQL below is **design sketch only** and gets finalised after the domain model is approved.

## 1. Technology choice

| Component                        | Decision                                                                                                                                                                                     | Why                                                                                                                                                                                                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PostgreSQL 18**                | Primary store                                                                                                                                                                                | Relational integrity is central to this product: FKs across ~50 tables, exclusion constraints for double booking, transactions spanning state + audit + outbox, RLS for tenant isolation, `daterange` types for validity, JSONB for type-specific attributes. |
| **PostGIS 3.4+**                 | Spatial                                                                                                                                                                                      | Distance, radius search, viewport queries, point-in-polygon for geo areas (tariffs), clustering, and later vector tiles (`ST_AsMVT`). GIS is mission-critical [R§47C], so it belongs in the DB where it can be indexed and joined, not in the browser.        |
| Extensions                       | `postgis`, `btree_gist` (exclusion constraints mixing `=` and `&&`), `pg_trgm` (fuzzy duplicate detection, search), `citext` (emails), `unaccent` (Romanian diacritics: _Râșnov_ = _Rasnov_) |                                                                                                                                                                                                                                                               |
| **Redis 7**                      | Queues (BullMQ), rate limiting, short-lived caches (permission sets, geocode results within ToS limits), SSE fan-out later                                                                   | Not a system of record.                                                                                                                                                                                                                                       |
| **S3-compatible object storage** | Photos, videos, artwork, studies, raw emails                                                                                                                                                 | MinIO locally; AWS S3 / Cloudflare R2 / other EU S3 in prod.                                                                                                                                                                                                  |
| **Elasticsearch/OpenSearch**     | **Not needed.**                                                                                                                                                                              | Tens of thousands of assets and CRM records are well within PostgreSQL full-text + trigram. Revisit only if cross-tenant analytics or heavy faceted search appears (P3).                                                                                      |

## 2. Multi-tenancy

### 2.1 Options

|                                              | Shared schema + `tenant_id`      | Schema per tenant                           | Database per tenant         |
| -------------------------------------------- | -------------------------------- | ------------------------------------------- | --------------------------- |
| Isolation                                    | Logical (needs RLS + discipline) | Stronger (search_path)                      | Strongest                   |
| Migrations                                   | One run                          | N runs, drift risk                          | N runs + N connection pools |
| Cross-tenant ops (platform admin, analytics) | Easy                             | Hard                                        | Hardest                     |
| Cost at 1–100 tenants                        | Lowest                           | Medium                                      | High                        |
| Connection pooling                           | Simple                           | search_path per session complicates pooling | Pool per DB                 |
| Noisy neighbour                              | Possible                         | Possible                                    | Isolated                    |
| Fit for "one tenant now, SaaS later" [R§5]   | ✅                               | ⚠️                                          | ❌ overkill                 |

### 2.2 Decision (ADR-0003): shared schema + `tenant_id` + PostgreSQL Row-Level Security

Isolation is enforced in four independent layers, so a bug in one does not leak data:

1. **Tenant context**: resolved from the access token (never from a header or body the client controls). Each request
   runs inside a transaction that begins with `SELECT set_config('app.tenant_id', $1, true)` (transaction-local,
   so it's safe with poolers).
2. **RLS on every tenant-owned table**, `FORCE`d, and the app connects as a role **without** `BYPASSRLS`:
   ```sql
   ALTER TABLE campaign ENABLE ROW LEVEL SECURITY;
   ALTER TABLE campaign FORCE ROW LEVEL SECURITY;
   CREATE POLICY tenant_isolation ON campaign
     USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
     WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
   ```
   A missing context resolves to NULL, which returns zero rows. The failure mode is "fail closed".
3. **Composite foreign keys**: every tenant table has `UNIQUE (tenant_id, id)`, and children reference
   `(tenant_id, parent_id) → parent(tenant_id, id)`. A campaign in tenant A therefore _cannot_ reference an
   organisation in tenant B, even through a buggy insert path.
4. **Automated tests**: a meta-test enumerates all tables with a `tenant_id` column and fails if any lacks
   RLS/FORCE/policy. Cross-tenant tests cover every repository (see 08 §Testing).

Other tenant boundaries:

| Area                          | Rule                                                                                                                                                                         |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Background jobs               | Payload always carries `tenantId`. The worker wraps the handler in the same tenant transaction helper, and there is no "global" job DB access except explicit platform jobs. |
| Scheduled scans (expiry etc.) | A platform-level scheduler enumerates tenants and enqueues one job per tenant.                                                                                               |
| Files                         | Keys `t/{tenantId}/{yyyy}/{mm}/{fileId}`. Signed URLs are issued only after the `file_object` row is read under RLS.                                                         |
| Cache                         | Keys prefixed `t:{tenantId}:`.                                                                                                                                               |
| Audit / notifications         | Tenant-scoped rows under RLS.                                                                                                                                                |
| External users                | They're memberships of the tenant, so the same RLS applies, and scope filters narrow further.                                                                                |
| Platform admin                | Separate DB role with `BYPASSRLS`, used only by the platform module. Every use is audited.                                                                                   |
| API keys (P2)                 | Bound to one tenant.                                                                                                                                                         |

## 3. ER overview (textual)

```
tenant 1─N membership N─1 user ; membership N─M role ; role 1─N role_permission
tenant 1─N organisation 1─N contact ; organisation N─M classification ; organisation N─N organisation (relationship)
organisation 1─N opportunity 1─N brief 1─N brief_line
organisation(client) 1─N campaign ; organisation(agency) 1─N campaign ; campaign 1─N campaign_location
brief_line 1─0..1 campaign_location
asset_type 1─N ooh_asset 1─N mount_position 1─N advertising_face
ooh_asset 1─N asset_terms (owner/supplier → organisation) ; 1─N asset_verification ; 1─N asset_block
campaign_location 1─N candidate_position N─1 ooh_asset (and N─1 mount_position)
campaign_location 1─N study 1─N study_item N─1 candidate_position ; study_item 1─N client_decision
advertising_face 1─N face_booking N─1 campaign_location ; face_booking N─0..1 study_item
campaign_location 1─N production_order 1─N production_item
campaign_location 1─N field_job 1─N field_job_item N─0..1 face_booking ; field_job_item 1─N evidence N─1 file_object
service/tariff_rule ; commercial_line N─1 campaign_location (+ optional booking / job item / order)
task, comment, file_link, notification, audit_event → polymorphic (subject_type, subject_id)
```

## 4. Keys, constraints, indexes

**Primary keys**: `id uuid DEFAULT uuidv7()` (PostgreSQL 18 native; time-ordered, so B-tree locality is good). Human-readable codes
(`POLE-001245`, `CMP-2027-0012`) come from per-tenant counters (`tenant_sequence(tenant_id, key, next_value)`
with `UPDATE … RETURNING`) and are unique per tenant.

**Unique constraints (selection)**

| Table               | Constraint                                                                      |
| ------------------- | ------------------------------------------------------------------------------- |
| user                | `email` (citext)                                                                |
| membership          | `(tenant_id, user_id)`                                                          |
| organisation        | `(tenant_id, vat_number) WHERE vat_number IS NOT NULL AND archived_at IS NULL`  |
| ooh_asset           | `(tenant_id, code)`                                                             |
| mount_position      | `(asset_id, position_no)`                                                       |
| advertising_face    | `(mount_position_id, face_code)`                                                |
| candidate_position  | `(campaign_location_id, mount_position_id)`                                     |
| study               | `(campaign_location_id, version)`                                               |
| inbound_email       | `(tenant_id, message_id)` (idempotent ingestion)                                |
| task / notification | `(tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL` (idempotent automations) |
| evidence            | `(tenant_id, client_upload_id)` (idempotent mobile retries)                     |

**Exclusion constraints (business-rule integrity in the DB)**

```sql
-- No double booking [R§48]
ALTER TABLE face_booking ADD CONSTRAINT face_booking_no_overlap
  EXCLUDE USING gist (tenant_id WITH =, face_id WITH =, period WITH &&)
  WHERE (status IN ('CONFIRMED','INSTALLED','REMOVAL_REQUIRED'));

-- No overlapping commercial terms per asset
ALTER TABLE asset_terms ADD CONSTRAINT asset_terms_no_overlap
  EXCLUDE USING gist (tenant_id WITH =, asset_id WITH =, valid_period WITH &&);

-- No duplicate tariff rules [R§33]
ALTER TABLE tariff_rule ADD CONSTRAINT tariff_rule_no_duplicate
  EXCLUDE USING gist (tenant_id WITH =, dimension_key WITH =, valid_period WITH &&)
  WHERE (status = 'ACTIVE');
```

The API maps violation SQLSTATE `23P01` to `409 BOOKING_CONFLICT` / `409 TARIFF_DUPLICATE` with the conflicting row.

**Check constraints**: pole mount count ≤ 2 (trigger reading `asset_type.max_mount_positions`), `amount >= 0`
except ADJUSTMENT lines, `lower(period) <= upper(period)`, currency ISO-4217 format.

**Indexes (non-exhaustive)**

| Purpose               | Index                                                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Tenant-scoped listing | B-tree `(tenant_id, status, created_at DESC)` on main lists                                                                   |
| FK lookups            | B-tree on every FK column, leading with `tenant_id`                                                                           |
| **Spatial**           | GiST on `ooh_asset.location`, `campaign_location.store_point`, `evidence.gps`, `geo_area.geom`                                |
| Bookings by face/time | GiST `(face_id, period)` (created by exclusion constraint) + B-tree `(tenant_id, campaign_location_id)`                       |
| Search                | GIN trigram on `organisation.display_name`, `ooh_asset.address`, `contact` names; GIN `tsvector` (unaccent) for global search |
| Scheduler scans       | Partial B-tree `campaign_location (tenant_id, end_date) WHERE status IN ('LIVE','REMOVAL_DUE')`                               |
| Tasks                 | `(tenant_id, assignee_membership_id, status, due_at)`                                                                         |
| Audit                 | `(tenant_id, subject_type, subject_id, occurred_at DESC)` per monthly partition                                               |

## 5. GIS design

**Storage**: `geography(Point, 4326)` for points (meter-accurate distances without projections, and GiST-indexable
for `ST_DWithin`). Area polygons are `geometry(MultiPolygon, 4326)`. Everything is cast to geometry for clustering/tiles.

| Capability [R§16]              | Where it lives                                                                                                                                                                                      |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Geocode store address          | Backend `GeoProvider.geocode()` (Google Geocoding) → buyer confirms pin → stored as user-confirmed point                                                                                            |
| Reverse geocode on click       | Backend `GeoProvider.reverseGeocode()` (debounced, cached)                                                                                                                                          |
| Existing inventory near store  | PostGIS `ST_DWithin(location, :store, :radius)` + availability join for location dates                                                                                                              |
| Straight-line distance         | PostGIS `ST_Distance(geography)` (free, instant, always available)                                                                                                                                  |
| Driving route + distance/time  | Backend `GeoProvider.route()` (Google Routes API), stored on candidate (polyline + metrics)                                                                                                         |
| Direction toward store / arrow | Computed: route's initial bearing vs face `facing_bearing` → suggested LEFT/RIGHT/STRAIGHT (±30° straight band), buyer confirms                                                                     |
| Traffic direction              | Buyer-entered per face (`visible_traffic_direction`) in MVP. Traffic data is P3                                                                                                                     |
| POIs                           | Frontend Places API (New) nearby search around store. Not persisted except `place_id` (ToS)                                                                                                         |
| Street View                    | Frontend Maps JS `StreetViewPanorama`. Persist only pano id + heading/pitch/fov as a reference                                                                                                      |
| Viewport inventory             | `GET /map/assets?bbox=&zoom=&filters=` → `location && ST_MakeEnvelope(...)::geography`                                                                                                              |
| Clustering                     | Zoom ≥ 13: raw points (≤ ~5k per viewport), clustered client-side (supercluster). Zoom < 13: server grid aggregation `ST_SnapToGrid` → counts. P2+: `ST_AsMVT` vector tiles if volumes exceed ~100k |
| Geo areas for tariffs/filters  | `geo_area` polygons (Romanian counties/cities seeded from open data) + `ST_Covers`                                                                                                                  |
| Historical usage               | Join `face_booking` (REMOVED/INSTALLED) per asset                                                                                                                                                   |
| Evidence GPS check             | `ST_Distance(evidence.gps, asset.location)` → flag if > threshold (default 50 m)                                                                                                                    |

**Provider abstraction**: `GeoProvider` interface (geocode, reverseGeocode, route, placesNearby) with a
Google implementation. Map _display_ uses the Google Maps JS API through a thin wrapper, so switching to
Mapbox/MapLibre later means replacing one frontend adapter and one backend adapter. Google is the recommended
MVP choice because **Street View** is a hard requirement [R§16, R§43], and no alternative has comparable coverage in Romania.

**Compliance flag (OPD-19)**: Google Maps Platform terms restrict caching Google content (e.g. geocoded
lat/lng) and displaying Street View imagery outside Google maps (PDF studies). The design mitigates this:
coordinates become user-confirmed data, and pano references are stored instead of images. Legal review is still required
before PDF exports with Street View ("where permitted" [R§20]).

## 6. Tariff engine

**Rule dimensions** [R§33]: `direction (SELL|COST)`, `service` (required), optional `asset_type`, `supplier_org`,
`decorator_org`, `geo_area`, `client_org`, and `valid_period`.

**Generated columns**

```sql
dimension_key text GENERATED ALWAYS AS (
  direction || '|' || service_id || '|' || coalesce(asset_type_id::text,'*') || '|' ||
  coalesce(supplier_org_id::text,'*') || '|' || coalesce(decorator_org_id::text,'*') || '|' ||
  coalesce(geo_area_id::text,'*') || '|' || coalesce(client_org_id::text,'*')) STORED,
specificity int GENERATED ALWAYS AS (
  (client_org_id    IS NOT NULL)::int * 32 + (decorator_org_id IS NOT NULL)::int * 16 +
  (supplier_org_id  IS NOT NULL)::int *  8 + (geo_area_id      IS NOT NULL)::int *  4 +
  (asset_type_id    IS NOT NULL)::int *  2) STORED
```

**Matching** (`TariffService.resolve(context, pricingDate)`):

1. Candidates: ACTIVE rules for tenant + direction + service, where every non-null dimension equals the context value,
   `geo_area` covers the location point, and `valid_period @> pricingDate`.
2. Order by `specificity DESC`, then `geo_area.rank DESC` (city beats county when nested areas both match).
3. Exactly one winner, or `NO_TARIFF` (line left unpriced + Finance task), or `AMBIGUOUS` (same specificity and
   area rank; publish-time checks should have prevented it, and it's reported, not guessed).
4. The line stores `tariff_rule_id` + full snapshot `{rule, matched dimensions, amount, unit, currency, pricingDate}`.

**Pricing date** (recommendation): booking period start for rental; date the job was completed for services.
**Versioning**: ACTIVE rules are immutable except for closing their validity. A revision creates a new row with
`supersedes_id`. Completed jobs keep their snapshots, so historical results never move [R§33].
**Publish-time checks**: exact duplicate (DB exclusion), plus an ambiguity scan and a coverage gap report
(e.g. "Neutralisation / Directional Flag has no rule for Cluj after 2027-06-30").

## 7. Audit strategy

| Layer                                                                                  | What                                                                                                                        | Why                                                                          |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Application audit (`audit_event`)                                                      | Semantic events with actor, action, subject, changed fields (before/after), request id, IP, actor type (USER/SYSTEM/AI/API) | Answers the R§40 questions in business language                              |
| `status_history`                                                                       | Every state transition                                                                                                      | Timelines, SLA reporting                                                     |
| DB trigger audit on financial tables (`tariff_rule`, `commercial_line`, `asset_terms`) | Row diffs using `app.actor_id` session var                                                                                  | Belt-and-braces: catches changes from any path, including migrations/scripts |
| Immutability                                                                           | `REVOKE UPDATE, DELETE` on audit tables from the app role; monthly partitions; retention per tenant plan                    | Tamper resistance                                                            |

## 8. Transaction boundaries

| Use case                            | One transaction includes                                                                                                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any state transition                | row lock, status update, status_history, audit_event, outbox_event                                                                                                                 |
| Brief convert                       | brief status, campaign, all campaign_locations, file relinks, outbox                                                                                                               |
| Client approval of an item          | client_decision, study_item status, booking TENTATIVE→CONFIRMED (**exclusion constraint checked here**), draft commercial lines, outbox. Conflict → whole item decision rolls back |
| Study publish                       | study status, all snapshots, all TENTATIVE holds                                                                                                                                   |
| Evidence accept                     | evidence review, item status, booking status, conditional job/location status, line confirmation                                                                                   |
| **Not** in the business transaction | Emails, notifications, AI calls, geocoding, thumbnailing, PDF generation → outbox → BullMQ (at-least-once, idempotent handlers)                                                    |

Isolation level: READ COMMITTED + explicit `SELECT … FOR UPDATE` on the aggregate root. Exclusion constraints
cover concurrent booking races without SERIALIZABLE.

## 9. Migrations

Drizzle ORM schema in TypeScript → `drizzle-kit generate` produces SQL migrations that are **reviewed and committed**.
RLS policies, exclusion constraints, triggers, generated columns and partitions are hand-written SQL migrations in
the same sequence. Migrations are forward-only in prod (expand → migrate → contract for breaking changes) and run as
a separate deploy step before app rollout.
