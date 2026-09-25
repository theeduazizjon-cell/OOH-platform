# ADR-0004: Drizzle ORM with hand-written SQL for advanced constraints
- Status: Proposed · Date: 2026-09-25
## Decision
Drizzle for schema and type-safe queries; drizzle-kit to generate migrations that are reviewed and committed; RLS, exclusion constraints, triggers and partitions as hand-written SQL migrations in the same sequence.
## Alternatives
Prisma (limited PostGIS/RLS/exclusion support, opaque engine); TypeORM; Kysely (good, but less schema tooling).
