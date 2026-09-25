# ADR-0006: In-house authentication (argon2id, short JWT + rotating refresh)

- Status: Accepted · Date: 2026-09-25

## Decision

Global users with per-tenant memberships; argon2id; 10-minute EdDSA access JWT in memory; opaque, hashed, rotating refresh token in an httpOnly SameSite=Strict cookie with family reuse detection; magic-link login for external users; OIDC SSO later.

## Implementation notes (2026-09-25, Step 2)

- Access tokens are **HS256** (not EdDSA) while the API is their only verifier; switch to EdDSA with a published
  public key when a second service must verify tokens. `jose` is used for signing/verification.
- Refresh cookie value is `<userId>.<tokenId>.<secret>`; only SHA-256(secret) is stored. The user id lets the API
  read the token under RLS "user mode" without a SECURITY DEFINER lookup.
- Login lookup by email is the single SECURITY DEFINER function `auth_find_login_user()`, owned by the NOLOGIN
  role `ooh_auth`, which has column-level SELECT on `app_user` only.
- Reuse of a rotated refresh token revokes the whole family. Concurrent refreshes are therefore serialised in the
  browser (single-flight + Web Locks); otherwise two tabs could log each other out.
- Membership access is cached per API process for 30 s: suspensions and role changes apply within that window
  (a shared Redis cache/pub-sub invalidation can shorten it when there are several API instances).
- Magic-link login for external users (OPD-15) is deferred to the portal milestone (M7).

## Alternatives

Clerk/Auth0/WorkOS: faster start, but per-MAU cost with many external users, and a mismatch with the membership model and data residency. Revisit if enterprise SSO becomes an early requirement.
