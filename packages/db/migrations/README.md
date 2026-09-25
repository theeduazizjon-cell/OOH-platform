# Migrations

Applied in journal order by `pnpm db:migrate` (Drizzle migrator, tracked in schema `drizzle`).

- **Generated** migrations come from `drizzle-kit generate` (schema files listed in `drizzle.config.ts`).
- **Custom** migrations (`drizzle-kit generate --custom --name=…`) hold what drizzle-kit can't express:
  extensions, RLS policies, grants, exclusion constraints, triggers, partitioned tables.
- Every statement must be separated by `--> statement-breakpoint`.
- Never edit a migration after it has been merged. Add a new one.
- A new tenant-owned table needs an RLS migration in the same PR; `test/schema-guards.int.test.ts` enforces it.
