-- Custom migration: Row-Level Security for identity tables, the partitioned audit trail, and grants
-- for the runtime role `ooh_app` (created by sql/bootstrap-roles.sql).
-- Design: docs/architecture/07-database.md §2 and §7.

-- ═════════════════════════════════════════════════════════════════════════════
-- tenant: visible when it is the active tenant, or (user mode) when the user is a member.
-- ═════════════════════════════════════════════════════════════════════════════
ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenant FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_select ON tenant FOR SELECT
  USING (
    id = app_current_tenant_id()
    OR (app_current_tenant_id() IS NULL
        AND id IN (SELECT m.tenant_id FROM membership m WHERE m.user_id = app_current_user_id()))
  );
--> statement-breakpoint
CREATE POLICY tenant_update ON tenant FOR UPDATE
  USING (id = app_current_tenant_id())
  WITH CHECK (id = app_current_tenant_id());
--> statement-breakpoint
-- No INSERT/DELETE policy: tenants are provisioned by the platform role, never by tenant users.

-- ═════════════════════════════════════════════════════════════════════════════
-- app_user (global identity): yourself (user mode) or members of the active tenant.
-- Login lookups by email and user creation happen through SECURITY DEFINER functions
-- added with the auth module, not through broad policies.
-- ═════════════════════════════════════════════════════════════════════════════
ALTER TABLE app_user ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app_user FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY app_user_select ON app_user FOR SELECT
  USING (
    (app_current_tenant_id() IS NULL AND id = app_current_user_id())
    OR id IN (SELECT m.user_id FROM membership m WHERE m.tenant_id = app_current_tenant_id())
  );
--> statement-breakpoint
CREATE POLICY app_user_update_self ON app_user FOR UPDATE
  USING (id = coalesce(app_current_user_id(), app_current_actor_id()))
  WITH CHECK (id = coalesce(app_current_user_id(), app_current_actor_id()));
--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- Tenant-owned tables: standard isolation policy.
-- ═════════════════════════════════════════════════════════════════════════════
ALTER TABLE membership ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE membership FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON membership
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
-- User mode only: a user can list their own memberships across tenants (tenant picker at login).
CREATE POLICY membership_self_select ON membership FOR SELECT
  USING (app_current_tenant_id() IS NULL AND user_id = app_current_user_id());
--> statement-breakpoint

ALTER TABLE role ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE role FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON role
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint

ALTER TABLE role_permission ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE role_permission FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON role_permission
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint

ALTER TABLE membership_role ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE membership_role FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON membership_role
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- audit_event: append-only, monthly range partitions (UTC month boundaries).
-- ═════════════════════════════════════════════════════════════════════════════
CREATE TYPE actor_type AS ENUM ('USER', 'SYSTEM', 'AI', 'API');
--> statement-breakpoint
CREATE TABLE audit_event (
  id                  uuid        NOT NULL DEFAULT uuidv7(),
  occurred_at         timestamptz NOT NULL DEFAULT now(),
  tenant_id           uuid        REFERENCES tenant (id),
  actor_type          actor_type  NOT NULL,
  actor_user_id       uuid,
  actor_membership_id uuid,
  action              text        NOT NULL CONSTRAINT audit_event_action_format_ck CHECK (action ~ '^[a-z_]+(\.[a-z_]+)+$'),
  subject_type        text,
  subject_id          uuid,
  changes             jsonb,
  metadata            jsonb,
  request_id          text,
  ip                  inet,
  user_agent          text,
  CONSTRAINT audit_event_pk PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
--> statement-breakpoint
CREATE INDEX audit_event_subject_idx ON audit_event (tenant_id, subject_type, subject_id, occurred_at DESC);
--> statement-breakpoint
CREATE INDEX audit_event_tenant_time_idx ON audit_event (tenant_id, occurred_at DESC);
--> statement-breakpoint

ALTER TABLE audit_event ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_event FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY audit_select ON audit_event FOR SELECT
  USING (tenant_id = app_current_tenant_id());
--> statement-breakpoint
-- Tenant events carry the active tenant; pre-tenant events (e.g. failed login) carry NULL and are
-- then readable only by the platform role.
CREATE POLICY audit_insert ON audit_event FOR INSERT
  WITH CHECK (tenant_id IS NOT DISTINCT FROM app_current_tenant_id());
--> statement-breakpoint

-- Creates monthly partitions from the current month up to `months_ahead`. Called here and, later,
-- by a scheduled platform job. Partitions are revoked from the app role: RLS is defined on the
-- parent, so direct access to a partition would bypass it.
CREATE OR REPLACE FUNCTION audit_event_ensure_partitions(months_ahead int DEFAULT 2) RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  month_start timestamp; -- UTC wall-clock, no time zone: month arithmetic must not follow session TZ/DST
  partition_name text;
BEGIN
  FOR i IN 0..months_ahead LOOP
    month_start := date_trunc('month', now() AT TIME ZONE 'UTC') + make_interval(months => i);
    partition_name := format('audit_event_%s', to_char(month_start, 'YYYYMM'));
    IF to_regclass(partition_name) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF audit_event FOR VALUES FROM (%L) TO (%L)',
        partition_name,
        month_start AT TIME ZONE 'UTC',
        (month_start + interval '1 month') AT TIME ZONE 'UTC');
      EXECUTE format('REVOKE ALL ON %I FROM ooh_app', partition_name);
    END IF;
  END LOOP;
END
$$;
--> statement-breakpoint
-- Safety net so an insert never fails for lack of a partition. Rows landing here mean the
-- partition job is behind (to be monitored).
CREATE TABLE audit_event_default PARTITION OF audit_event DEFAULT;
--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- Grants for the runtime role. Future tables created by the migration role inherit the defaults.
-- ═════════════════════════════════════════════════════════════════════════════
GRANT USAGE ON SCHEMA public TO ooh_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ooh_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ooh_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ooh_app;
--> statement-breakpoint
-- PostGIS reference data: read-only for the app.
REVOKE INSERT, UPDATE, DELETE ON spatial_ref_sys FROM ooh_app;
--> statement-breakpoint
-- The audit trail is append-only for the app.
REVOKE UPDATE, DELETE ON audit_event FROM ooh_app;
--> statement-breakpoint
REVOKE ALL ON audit_event_default FROM ooh_app;
--> statement-breakpoint
SELECT audit_event_ensure_partitions(2);
