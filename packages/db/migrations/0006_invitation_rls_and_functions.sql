-- Custom migration: invitation RLS and the two identity functions invitations need.
-- Requires the roles from sql/bootstrap-roles.sql (ooh_app, ooh_auth). The migration role must be
-- a superuser or a member of ooh_auth to transfer function ownership.

-- ═════════════════════════════════════════════════════════════════════════════
-- invitation: standard tenant isolation. Anonymous access goes through auth_find_invitation only.
-- ═════════════════════════════════════════════════════════════════════════════
ALTER TABLE invitation ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE invitation FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON invitation
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
-- Invitations are revoked or accepted, never deleted by the app (they go away only with their
-- INVITED membership when an invitation is cancelled, through the FK cascade).
REVOKE DELETE ON invitation FROM ooh_app;
--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- Invite: resolve an email to a global user, creating the user when the email is new.
-- app_user is global and RLS lets a tenant see only its own members, so the app role can neither
-- find nor create a user by email itself. Callable only inside a tenant context (an admin acting
-- in a tenant); the API additionally requires the users.invite permission.
-- Returns NULL for an archived (deactivated) account.
-- ═════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION invitation_ensure_user(p_email text, p_display_name text)
  RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  found_id uuid;
  found_archived_at timestamptz;
BEGIN
  IF app_current_tenant_id() IS NULL THEN
    RAISE EXCEPTION 'invitation_ensure_user requires a tenant context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO app_user (email, display_name)
    VALUES (p_email::citext, p_display_name)
    ON CONFLICT ON CONSTRAINT app_user_email_uq DO NOTHING;
  SELECT u.id, u.archived_at INTO found_id, found_archived_at
    FROM app_user u WHERE u.email = p_email::citext;
  IF found_archived_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  RETURN found_id;
END
$$;
--> statement-breakpoint
GRANT INSERT (email, display_name) ON app_user TO ooh_auth;
--> statement-breakpoint
ALTER FUNCTION invitation_ensure_user(text, text) OWNER TO ooh_auth;
--> statement-breakpoint
REVOKE ALL ON FUNCTION invitation_ensure_user(text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION invitation_ensure_user(text, text) TO ooh_app;
--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- Accept: the anonymous lookup of an invitation link. Matches on id AND token hash, so only the
-- holder of the secret learns anything. Validity (expiry, revoked, accepted, statuses) is decided
-- by the caller from the returned columns, so it can give a precise message.
-- ═════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION auth_find_invitation(p_invitation_id uuid, p_token_hash text)
  RETURNS TABLE (
    tenant_id uuid,
    tenant_name text,
    tenant_status tenant_status,
    membership_id uuid,
    membership_status membership_status,
    user_id uuid,
    email citext,
    display_name text,
    password_hash text,
    expires_at timestamptz,
    accepted_at timestamptz,
    revoked_at timestamptz
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT i.tenant_id, t.name, t.status, i.membership_id, m.status, m.user_id, i.email,
           u.display_name, u.password_hash, i.expires_at, i.accepted_at, i.revoked_at
    FROM invitation i
    JOIN tenant t ON t.id = i.tenant_id
    JOIN membership m ON m.tenant_id = i.tenant_id AND m.id = i.membership_id
    JOIN app_user u ON u.id = m.user_id
    WHERE i.id = p_invitation_id AND i.token_hash = p_token_hash AND u.archived_at IS NULL
  $$;
--> statement-breakpoint
GRANT SELECT (id, tenant_id, membership_id, email, token_hash, expires_at, accepted_at, revoked_at)
  ON invitation TO ooh_auth;
--> statement-breakpoint
GRANT SELECT (id, name, status) ON tenant TO ooh_auth;
--> statement-breakpoint
GRANT SELECT (id, tenant_id, user_id, status) ON membership TO ooh_auth;
--> statement-breakpoint
GRANT SELECT (display_name) ON app_user TO ooh_auth;
--> statement-breakpoint
ALTER FUNCTION auth_find_invitation(uuid, text) OWNER TO ooh_auth;
--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_find_invitation(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_find_invitation(uuid, text) TO ooh_app;
