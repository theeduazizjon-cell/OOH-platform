# ADR-0005: REST + OpenAPI generated from shared Zod contracts

- Status: Accepted · Date: 2026-09-25

## Decision

REST /api/v1, state changes as POST .../actions/{action}, RFC 9457 errors, cursor pagination, ETag/If-Match concurrency. Zod schemas in packages/contracts are the single source for validation, TS types and OpenAPI.

## Alternatives

GraphQL (field-level authorization and tenant scoping complexity, no clear benefit; external integrators prefer REST).
