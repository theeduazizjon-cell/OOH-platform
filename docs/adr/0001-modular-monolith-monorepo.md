# ADR-0001: Modular monolith in a pnpm/Turborepo monorepo

- Status: Accepted · Date: 2026-09-25

## Context

One team; a tightly coupled domain where a single client approval touches research, inventory, commercial and tasks in one transaction; strong consistency required.

## Decision

One NestJS codebase with strict bounded-context modules and two entrypoints (HTTP API, worker). A React SPA with three route shells (app, portal, field). Shared `contracts` and `db` packages. Cross-module side effects go through a transactional outbox.

## Consequences

Simple deploy and ACID workflows. Module boundaries must be enforced (lint rule: no cross-module repository imports). Services can be extracted later along module and outbox lines.

## Alternatives

Microservices (distributed transactions, ops cost); Next.js full-stack (weak fit for workers and external API).
