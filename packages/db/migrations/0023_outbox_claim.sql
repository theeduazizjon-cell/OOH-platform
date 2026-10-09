-- Custom migration: the worker's cross-tenant read path into the outbox. The runtime role is bound to
-- one tenant by RLS, so pending events of all tenants are leased through this SECURITY DEFINER
-- function (owned by ooh_auth, BYPASSRLS, column-scoped grants). Handlers then run inside each event's
-- tenant context and mark the event dispatched there, under normal RLS.

CREATE OR REPLACE FUNCTION outbox_claim(p_limit integer, p_lease_seconds integer)
  RETURNS TABLE (id uuid, tenant_id uuid, event_type text, payload jsonb, attempts integer, occurred_at timestamptz)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
#variable_conflict use_column
BEGIN
  IF app_current_tenant_id() IS NOT NULL THEN
    RAISE EXCEPTION 'outbox_claim runs outside any tenant context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  WITH picked AS (
    SELECT e.id AS picked_id
    FROM outbox_event e
    WHERE e.dispatched_at IS NULL
      AND e.failed_at IS NULL
      AND e.next_attempt_at <= now()
      AND (e.locked_until IS NULL OR e.locked_until < now())
    ORDER BY e.next_attempt_at, e.occurred_at
    LIMIT least(greatest(p_limit, 1), 100)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE outbox_event e
     SET locked_until = now() + make_interval(secs => least(greatest(p_lease_seconds, 5), 600))
    FROM picked
   WHERE e.id = picked.picked_id
  RETURNING e.id, e.tenant_id, e.event_type, e.payload, e.attempts, e.occurred_at;
END
$$;
--> statement-breakpoint
GRANT SELECT (id, tenant_id, event_type, payload, attempts, occurred_at, dispatched_at, failed_at, next_attempt_at, locked_until),
      UPDATE (locked_until)
  ON outbox_event TO ooh_auth;
--> statement-breakpoint
ALTER FUNCTION outbox_claim(integer, integer) OWNER TO ooh_auth;
--> statement-breakpoint
REVOKE ALL ON FUNCTION outbox_claim(integer, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION outbox_claim(integer, integer) TO ooh_app;
