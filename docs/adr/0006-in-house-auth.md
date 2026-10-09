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

## Refresh grace window (2026-10-03)

The browser dedupes refreshes, but a refresh can still be **lost**: the server rotates the token, then the
response never reaches cookie storage (page reload, closed tab, network drop). The browser keeps the old cookie,
and before this change its next refresh looked like reuse, which revoked the family and signed the user out.

- `REFRESH_REUSE_GRACE_MS` (30 s, `auth.service.ts`): within 30 s of its rotation, the token rotated immediately
  before the family's live token is accepted once more. The family is **rotated again** (same `family_id`), the
  previous token's `replaced_by_id` points at the new token, and the live successor the browser never received is
  revoked (`revoked_reason = 'superseded_by_grace'`). Audit: `auth.refresh_grace_used` (familyId,
  supersededTokenId).
- Everything else is still reuse and revokes the family (`auth.refresh_reuse_detected`): a previous token after
  the window; a token two or more rotations old; a revoked token, including a successor superseded by the grace
  path; and a previous token whose successor was already rotated (the browser demonstrably stored it).
- The window is measured from the original `rotated_at`, which the grace path never moves, so repeated retries
  can't extend it. No schema change.
- Rotation is now one transaction (claim the old row, insert the successor, link `replaced_by_id`). A refresh
  racing an in-flight rotation blocks on the row lock and then sees a complete chain; before this change it
  could see a rotated token without a successor.
- Security trade-off: a thief replaying a token within 30 s of the victim's rotation gets a session, but this
  revokes the victim's live token. The victim's next refresh is then reuse, which kills the family, so detection
  is delayed rather than lost.

## Alternatives

Clerk/Auth0/WorkOS: faster start, but per-MAU cost with many external users, and a mismatch with the membership model and data residency. Revisit if enterprise SSO becomes an early requirement.
