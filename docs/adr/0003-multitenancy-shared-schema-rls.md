# ADR-0003: Shared schema + tenant_id + Row-Level Security

- Status: Accepted · Date: 2026-09-25

## Context

R§5: independent companies, secure isolation, one tenant at first, SaaS later.

## Decision

Every tenant-owned table has tenant_id, UNIQUE(tenant_id,id), composite FKs, and FORCEd RLS policies keyed on the transaction-local `app.tenant_id`. The app DB role lacks BYPASSRLS. Tenant comes only from the verified token. A meta-test guarantees coverage.

## Consequences

Cheap and simple operations; defence in depth against application bugs. Every query must run inside the tenant transaction helper. Platform-level jobs use a separate role.

## Alternatives

Schema-per-tenant (migration drift, pooling issues); DB-per-tenant (cost; premature).
