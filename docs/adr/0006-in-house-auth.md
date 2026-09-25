# ADR-0006: In-house authentication (argon2id, short JWT + rotating refresh)
- Status: Proposed · Date: 2026-09-25
## Decision
Global users with per-tenant memberships; argon2id; 10-minute EdDSA access JWT in memory; opaque, hashed, rotating refresh token in an httpOnly SameSite=Strict cookie with family reuse detection; magic-link login for external users; OIDC SSO later.
## Alternatives
Clerk/Auth0/WorkOS: faster start, but per-MAU cost with many external users, and a mismatch with the membership model and data residency. Revisit if enterprise SSO becomes an early requirement.
