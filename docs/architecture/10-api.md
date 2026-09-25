# 10 — API Architecture

## Conventions
- Base: `/api/v1`. JSON. Resource names plural kebab-case. IDs are UUIDs; responses also include human codes.
- **Auth**: `Authorization: Bearer <access JWT>` (tenant embedded). Public: `/auth/*`, `/health`, inbound email webhook (signature-verified).
- **Authorization**: each route declares `@RequirePermission(key)`. Scoped permissions are applied in the query.
  Missing permission → `403`. Resource outside scope → `404` (don't reveal existence).
- **State changes**: `POST /{resource}/{id}/actions/{action}` with optional body (`reason`, etc.). Returns the updated
  resource + `allowedActions`. Invalid → `409 INVALID_TRANSITION`.
- **Concurrency**: responses carry `ETag: "<version>"`; `PATCH` and actions require `If-Match` → `412` on mismatch.
- **Idempotency**: `Idempotency-Key` header supported on POSTs (required on mobile evidence uploads).
- **Pagination**: cursor-based: `?limit=50&cursor=…` → `{ data: [...], page: { nextCursor, hasMore } }`.
- **Filtering / sorting / search**: `?filter[status]=LIVE,REMOVAL_DUE&filter[clientId]=…&sort=-endDate&q=sinaia`.
  Each endpoint whitelists filterable/sortable fields in its zod schema.
- **Errors**: RFC 9457 `application/problem+json`: `{ type, title, status, code, detail, errors?: [{path, message}], traceId }`.
  Stable `code`s: `VALIDATION_FAILED`, `INVALID_TRANSITION`, `BOOKING_CONFLICT`, `TARIFF_DUPLICATE`, `TARIFF_AMBIGUOUS`,
  `DUPLICATE_ASSET_SUSPECTED`, `PRECONDITION_FAILED`, `NOT_FOUND`, `FORBIDDEN`, `RATE_LIMITED`.
- **Field redaction**: cost/margin fields are omitted (not null) for principals lacking the permission.
- **Docs**: OpenAPI 3.1 generated from zod contracts at `/api/docs` (non-prod).

## Modules & operations (MVP)

| Module | Operations |
|---|---|
| **Auth** | `POST /auth/login` · `POST /auth/refresh` · `POST /auth/logout` · `POST /auth/switch-tenant` · `POST /auth/password/forgot` · `POST /auth/password/reset` · `POST /auth/invitations/{token}/accept` · `GET /me` (user, memberships, active tenant, effective permissions) |
| **Users/Memberships** | `GET/POST /memberships` (invite) · `GET/PATCH /memberships/{id}` · actions `suspend`, `reactivate` · `PUT /memberships/{id}/roles` |
| **Roles** | `GET/POST /roles` · `GET/PATCH/DELETE /roles/{id}` · `GET /permissions` (catalog) |
| **Config** | `GET/POST/PATCH /config/{asset-types,dimension-presets,services,classifications,activity-types,pipelines,task-categories,automation-rules,geo-areas}` |
| **Organisations** | `GET/POST /organisations` (dup check on POST → `409 DUPLICATE_SUSPECTED` with matches unless `force=true` + reason) · `GET/PATCH /organisations/{id}` · `GET /organisations/{id}/overview` (360°) · `GET /organisations/{id}/timeline` · actions `archive` |
| **Contacts** | `GET/POST /contacts` · `GET/PATCH /contacts/{id}` · actions `archive`, `anonymise` |
| **CRM** | `GET/POST /opportunities` · `PATCH /opportunities/{id}` · actions `move-stage`, `win`, `lose`, `reopen` · `POST /opportunities/{id}/brief` · `GET/POST /activities` · `GET/POST /leads` (+ `convert`) |
| **Briefs** | `GET/POST /briefs` · `GET/PATCH /briefs/{id}` · `PUT /briefs/{id}/lines` · actions `confirm`, `reopen`, `convert` (body: new/existing campaign), `discard` · `GET /inbound-emails` · `POST /inbound-emails/{id}/extract` (re-run AI) · `POST /webhooks/inbound-email` |
| **Campaigns** | `GET/POST /campaigns` · `GET/PATCH /campaigns/{id}` · actions `hold`, `resume`, `cancel` · `GET /campaigns/{id}/summary` |
| **Campaign Locations** | `GET/POST /campaigns/{id}/locations` · `GET/PATCH /locations/{id}` · `PUT /locations/{id}/store-point` · actions `start-research`, `skip-production`, `extend`, `hold`, `resume`, `cancel` · `GET /locations/{id}/status` (all 5 dimensions) |
| **Inventory** | `GET/POST /assets` (POST runs duplicate proximity check) · `GET/PATCH /assets/{id}` · `GET /assets/{id}/passport` · `POST/PATCH /assets/{id}/mount-positions` · `POST/PATCH /mount-positions/{id}/faces` · `GET/POST /assets/{id}/terms` · `POST /assets/{id}/blocks` · actions `activate`, `suspend`, `reinstate`, `decommission`, `request-verification`, `record-verification` · `GET /assets/{id}/availability?from&to` · `GET /assets/{id}/history` |
| **Map / Geo** | `GET /map/assets?bbox=w,s,e,n&zoom=&filter[...]&availableFrom&availableTo` (points or grid clusters) · `GET /map/nearby?lat&lng&radius` · `POST /geo/geocode` · `POST /geo/reverse` · `POST /geo/route` (origin, destination → distance, duration, polyline, initial bearing) · `GET /geo/areas?contains=lat,lng` |
| **Research** | `GET/POST /locations/{id}/candidates` (POST: existing mount position, or new asset payload) · `PATCH /candidates/{id}` · `POST /candidates/{id}/compute` (distance/route/direction) · actions `select`, `discard`, `restore` · `POST /candidates/{id}/ai-hints` |
| **Studies** | `GET/POST /locations/{id}/studies` · `GET/PATCH /studies/{id}` · `PUT /studies/{id}/items` · `POST /studies/{id}/ai-draft` · actions `mark-ready`, `reopen`, `publish`, `withdraw`, `supersede` · `GET /studies/{id}/preview` |
| **Approvals** | `GET /portal/studies/{id}` (external view, snapshot only) · `POST /portal/study-items/{id}/decision` `{decision, comment}` · `POST /study-items/{id}/decision-on-behalf` `{decision, clientOrgId, evidenceFileId, comment}` · actions `revoke` |
| **Production** | `GET /production-orders` · `GET/PATCH /production-orders/{id}` · `PUT /production-orders/{id}/items` · actions `send`, `confirm`, `start`, `mark-ready`, `complete`, `cancel` · `GET /production-orders/{id}/document` |
| **Field Ops** | `GET/POST /field-jobs` · `GET/PATCH /field-jobs/{id}` · actions `assign`, `start`, `submit`, `cancel` · `GET /field/today` (decorator scope) · `GET /field/jobs/{id}` · item actions `skip` |
| **Evidence** | `POST /field-job-items/{id}/evidence` `{fileId, kind, capturedAt, gps{lat,lng,accuracy}, clientUploadId}` · `GET /evidence?filter[assetId]=…` · actions `accept`, `reject` (reason) |
| **Tasks** | `GET/POST /tasks` · `PATCH /tasks/{id}` · actions `start`, `complete`, `cancel`, `reopen` |
| **Calendar** | `GET /calendar?from&to&filter[type]&filter[assignee]` (read model) · `POST/PATCH /calendar-events` |
| **Notifications** | `GET /notifications?unread=true` · `POST /notifications/{id}/read` · `POST /notifications/read-all` · `GET/PUT /notification-preferences` |
| **Tariffs** | `GET/POST /tariffs` · `PATCH /tariffs/{id}` (DRAFT only) · actions `publish`, `revise` (`{effectiveFrom, amount}`), `retire` · `POST /tariffs/resolve` (preview price for a context) · `GET /tariffs/conflicts` · `GET /tariffs/coverage` |
| **Costs / Revenue** | `GET /commercial-lines?filter[locationId]&filter[direction]` · `POST /commercial-lines` (manual) · `PATCH /commercial-lines/{id}` (DRAFT/CONFIRMED) · actions `confirm`, `lock`, `void`, `reprice` (DRAFT only) · `POST /commercial-lines/{id}/adjustments` |
| **Reports** | `GET /reports/margins?groupBy=campaign|client|month&from&to` · `GET /reports/operations` · `GET /reports/campaigns/{id}` · `GET /dashboard` · `?format=csv` export |
| **AI** | `POST /ai/assistant/messages` (streamed SSE) · `GET /ai/suggestions?subject=…` · actions `accept`, `reject` on suggestions · `POST /ai/summaries/campaigns/{id}` · `POST /ai/summaries/organisations/{id}` · `POST /ai/drafts/email` |
| **Documents/Files** | `POST /files/uploads` (→ presigned PUT) · `POST /files/{id}/complete` · `GET /files/{id}/url` · `POST /file-links` · `DELETE /file-links/{id}` · `GET /files?subjectType&subjectId` |
| **Comments** | `GET/POST /comments?subjectType&subjectId` (visibility enforced) |
| **Audit** | `GET /audit-events?subjectType&subjectId&actor&from&to` · `GET /{resource}/{id}/history` |
| **Platform** | `GET/POST /platform/tenants` · actions `suspend`, `reactivate` (separate guard, platform admins only) |

## Example: client approval
```
POST /api/v1/portal/study-items/0192…/decision
Authorization: Bearer …           (external membership, role End Client, scope ORGANISATION)
If-Match: "3"
{ "decision": "APPROVED", "comment": "OK, but prefer face A arrow left" }

200 { "id": "0192…", "decisionStatus": "APPROVED", "study": { "status": "PUBLISHED", "decided": 5, "total": 7 }, … }
409 { "type": ".../booking-conflict", "code": "BOOKING_CONFLICT", "detail": "Face POLE-001245/1/A is no longer available for 2027-03-01..2027-03-31" }
404 when the study's campaign client/agency isn't the caller's organisation
```
