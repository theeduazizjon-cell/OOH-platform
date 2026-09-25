# 03 — User Types & RBAC

## 1. Identity model

```
user (global identity: email, password hash, name, locale)       ← one person, one login
  └── membership (user × tenant)  kind: INTERNAL | EXTERNAL
        ├── organisation_id?   ← for EXTERNAL: the agency / client / supplier / decorator firm they represent
        ├── membership_role (N) ─► role (tenant-scoped, configurable) ─► role_permission (N) ─► permission key (code catalog)
        └── status: INVITED | ACTIVE | SUSPENDED
platform_admin (user_id)         ← Super Admin, outside tenant RBAC
```

Why a *global* user plus per-tenant membership: a decorator team or an agency may work with several OOH
companies on the platform, so one login needs to reach several tenants and pick one [R§3 "single user may have
more than one role"; R§5 SaaS]. Each access token carries exactly **one** active tenant.

## 2. Permission design

- **Permission keys are code-defined** (`resource.action`), such as `campaign.read`, `study.publish`, `evidence.review`.
  Code checks them, so code must define them. The catalog lives in `packages/contracts/permissions.ts` and is seeded.
- **Roles are data.** Each tenant gets the system role templates below and can clone or edit them
  ("configurable rather than hard-coded" [R§2]). System templates can't be deleted, only disabled.
- **Scope on each grant**: a role grants `permission@scope`:
  - `ALL`: everything in the tenant
  - `OWN`: records where the user is owner/creator (for example, Sales on opportunities)
  - `ASSIGNED`: records assigned to the user or their team (decorator → field jobs)
  - `ORGANISATION`: records linked to the user's organisation (agency → campaigns where `agency_org = mine`; client → `client_org = mine`; supplier → orders where `supplier_org = mine`)
- A user's effective permissions are the union across roles, and the widest scope wins.
- **Field-level sensitivity**: `commercial.cost.read` and `commercial.margin.read` gate cost/margin fields on
  any payload (serializer-level redaction). External users can never hold them. This is enforced by a catalog flag
  `internalOnly: true`, so an admin can't grant them to an external role by mistake.
- **Hard guardrails that no role can grant**: AI principal cannot hold `*.approve`, `*.decide`, `asset.set_availability`,
  `evidence.review`, `commercial.write`, `tariff.publish`, `field_job.complete` [R§39].
- **Super Admin** acts through a separate platform API with a DB role that can bypass RLS. Access is audited, and a
  support session into a tenant is explicit and time-boxed.

## 3. Role templates

| Role | Kind | Default scope | Purpose |
|---|---|---|---|
| Super Admin | platform | — | Tenants, plans, platform health [R§3] |
| Company Admin | internal | ALL | Users, roles, settings, nomenclatures |
| Management | internal | ALL (read-mostly) | Visibility over everything incl. financials |
| OOH Buyer / Account Manager | internal | ALL for ops | Briefs, campaigns, research, studies, approvals, field ops |
| Sales | internal | OWN for pipeline, ALL read for orgs | Prospects, opportunities, activities |
| Finance / Commercial | internal | ALL | Tariffs, costs, revenue, margins, billable items |
| Production Manager | internal | ALL | Production orders, suppliers, artwork |
| Decorator / Installation Team | external* | ASSIGNED | Mobile field jobs + evidence |
| Production Supplier | external | ORGANISATION | Their production orders (portal = P2) |
| OOH Supplier | external | ORGANISATION | Their subleased inventory (portal = P2) |
| Agency User | external | ORGANISATION | Campaigns where their org is agency |
| End Client | external | ORGANISATION | Campaigns where their org is client |
| Viewer | internal or external | ALL or ORGANISATION | Read-only reporting |

\* Decorators can also be employees (internal membership + Decorator role). Scope stays `ASSIGNED`.

## 4. Permission matrix (template defaults)

Legend: **A** = all, **O** = own, **S** = assigned, **G** = own organisation, **–** = none. Columns: V=View, C=Create,
E=Edit, D=Delete (soft), Ap=Approve/transition, X=Export.

| Module | Company Admin | Management | Buyer / AM | Sales | Finance | Prod. Mgr | Decorator | Prod. Supplier | OOH Supplier | Agency | Client | Viewer |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Users & roles | VCEDAp | V | – | – | – | – | – | – | – | – | – | – |
| Settings & nomenclatures | VCED | V | V | V | V | V | – | – | – | – | – | – |
| Organisations & contacts | VCEDX | VX | VCE | VCE(X) | V | V (suppliers) | – | – | – | – | – | V |
| Opportunities & pipeline | VCEDX | VX | V | VCE **O**, V A | V | – | – | – | – | – | – | V |
| Activities | VCED | V | VCE | VCE | V | V | – | – | – | – | – | – |
| Briefs | VCED | V | VCE Ap(confirm/convert) | VC | V | V | – | – | – | C (P2 portal) | C (P2 portal) | – |
| Campaigns & locations | VCED | V X | VCE Ap X | V | V | V | – | – | – | V **G** | V **G** | V |
| Inventory (assets) | VCED | V X | VCE Ap(verify, availability) X | V | V (+terms) | V | V **S** (job positions) | – | V **G** (own supplied) | – | – | V |
| Research / candidates | V | V | VCED | – | V | – | – | – | – | – | – | – |
| Studies | V | V | VCE Ap(publish) X | – | V | V | – | – | – | V **G** | V **G** | – |
| Client decisions | V | V | Ap on-behalf (OPD-06) | – | – | – | – | – | – | Ap **G** | Ap **G** | – |
| Production orders | V | V | VC | – | V | VCE Ap X | – | V E(status) **G** (P2) | – | – | – | – |
| Field jobs | V | V | VCE Ap(assign) | – | V | V | V E **S** | – | – | – | – | – |
| Evidence | V | V | V Ap(review) | – | – | V | VC **S** | – | – | V **G** (accepted only) | V **G** (accepted only) | – |
| Tariffs | V | V | V (sell) | – | VCE Ap(publish) X | – | – | – | – | – | – | – |
| Costs / revenue / margins | V | VX | V (A), E per own locations | – | VCE Ap(lock) X | V (production costs) | – | – | – | – | – | – |
| Tasks | VCED | V | VCE | VCE | VCE | VCE | V E **S** | – | – | – | – | – |
| Calendar | V | V | V | V | V | V | V **S** | – | – | – | – | V |
| Reports / dashboard | V X | V X | V X | V (sales) | V X | V (ops) | – | – | – | V **G** (campaign report) | V **G** | V |
| AI assistant | V | V | V | V | V | V | – | – | – | – | – | – |
| Audit log | V X | V | V (own entities) | – | V (commercial) | – | – | – | – | – | – | – |

Comments (`comment.visibility = INTERNAL | EXTERNAL`): external users only ever read or write EXTERNAL comments.

## 5. Enforcement layers (defence in depth)

1. **Route guard**: `@RequirePermission('study.publish')` checks that the key exists in the token/membership.
2. **Scope filter in the repository**: queries for scoped grants are composed with the scope predicate. For example,
   agency-scoped campaign queries add `agency_organisation_id = :orgId`. A scoped read is never "fetch then check".
3. **Row-Level Security in PostgreSQL**: tenant isolation (see 07). Scope is **not** in RLS for MVP, to keep
   policies simple and fast. It stays in the repository layer and is covered by authorization tests.
4. **Serializer redaction**: internal-only fields are stripped for principals lacking `commercial.*.read`.
5. **State-machine guards**: each transition declares its required permission (see 06).

## 6. Portal access (external)

- External users are invited by email into a membership bound to an organisation. For MVP they get full
  accounts with password or magic-link login. OPD-15 decides whether clients can approve through one-time signed links
  without an account.
- An agency user sees campaigns where `campaign.agency_organisation_id = membership.organisation_id`. OPD-16 covers
  whether agency admins can restrict individual users to specific end clients.
