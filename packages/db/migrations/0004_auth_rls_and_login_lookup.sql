-- Custom migration: refresh-token RLS and the pre-authentication login lookup.
-- Requires the roles from sql/bootstrap-roles.sql (ooh_app, ooh_auth). The migration role must be
-- a superuser or a member of ooh_auth to transfer function ownership.

-- ═════════════════════════════════════════════════════════════════════════════
-- refresh_token: user mode only, own rows only. Tenant-mode transactions never see tokens.
-- ═════════════════════════════════════════════════════════════════════════════
ALTER TABLE refresh_token ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE refresh_token FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY refresh_token_owner ON refresh_token
  USING (app_current_tenant_id() IS NULL AND user_id = app_current_user_id())
  WITH CHECK (app_current_tenant_id() IS NULL AND user_id = app_current_user_id());
--> statement-breakpoint
-- Tokens are revoked, never deleted by the app (history for reuse detection and audit).
REVOKE DELETE ON refresh_token FROM ooh_app;
--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- Login lookup. The only way for the app role to read a user without knowing its id.
-- Returns just what password verification needs; archived users are excluded.
-- ═════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION auth_find_login_user(p_email text)
  RETURNS TABLE (user_id uuid, password_hash text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT u.id, u.password_hash
    FROM app_user u
    WHERE u.email = p_email::citext AND u.archived_at IS NULL
  $$;
--> statement-breakpoint
GRANT SELECT (id, email, password_hash, archived_at) ON app_user TO ooh_auth;
--> statement-breakpoint
ALTER FUNCTION auth_find_login_user(text) OWNER TO ooh_auth;
--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_find_login_user(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_find_login_user(text) TO ooh_app;
