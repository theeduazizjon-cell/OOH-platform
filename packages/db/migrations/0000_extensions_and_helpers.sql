-- Custom migration: extensions and tenant-context helper functions.
-- Requires the migration role to be allowed to create extensions (postgis is not a "trusted" extension).

CREATE EXTENSION IF NOT EXISTS postgis;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS citext;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS unaccent;
--> statement-breakpoint

-- Tenant context. The application sets these with set_config(..., is_local => true) at the start of
-- every transaction (packages/db/src/tenant-context.ts). Missing or empty resolves to NULL, so RLS
-- policies comparing against NULL match no rows: the system fails closed.

-- The tenant the current transaction acts in (tenant mode).
CREATE OR REPLACE FUNCTION app_current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;
--> statement-breakpoint

-- The user in "user mode": pre-tenant flows such as listing one's own memberships at login.
-- Never set together with app.tenant_id.
CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint

-- The acting user for audit purposes (set in tenant mode). Not used by RLS policies.
CREATE OR REPLACE FUNCTION app_current_actor_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('app.actor_id', true), '')::uuid $$;
