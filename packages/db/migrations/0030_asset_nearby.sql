-- Custom migration: same-kind assets near many points at once (CSV import duplicate check).
-- Under RLS, PostgreSQL won't use non-leakproof functions as index conditions, and PostGIS's && /
-- ST_DWithin aren't leakproof: as ooh_app the query reads every asset of the tenant per point (≈ 3 s
-- for 1000 points over 20k assets). This SECURITY DEFINER function (owned by ooh_auth, BYPASSRLS,
-- column-scoped grants) filters the caller's tenant explicitly, so the GiST index is used (≈ 70 ms).
-- It only answers inside a tenant context and returns identifiers, codes and distances, nothing else.

CREATE OR REPLACE FUNCTION asset_nearby_same_kind(p_points jsonb, p_radius_m double precision)
  RETURNS TABLE (line integer, id uuid, code text, lifecycle asset_lifecycle, distance_m double precision)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
#variable_conflict use_column
DECLARE
  v_tenant uuid := app_current_tenant_id();
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'asset_nearby_same_kind needs a tenant context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF jsonb_typeof(p_points) <> 'array' OR jsonb_array_length(p_points) > 1000 THEN
    RAISE EXCEPTION 'asset_nearby_same_kind takes an array of at most 1000 points' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  WITH p AS MATERIALIZED (
    SELECT x.line, x.kind, ST_SetSRID(ST_MakePoint(x.lng, x.lat), 4326)::geography AS g
    FROM jsonb_to_recordset(p_points) AS x(line integer, lat double precision, lng double precision, kind text)
  )
  SELECT p.line, n.id, n.code, n.lifecycle, n.distance_m
  FROM p
  CROSS JOIN LATERAL (
    SELECT a.id, a.code, a.lifecycle, ST_Distance(a.location, p.g) AS distance_m
    FROM ooh_asset a
    JOIN asset_type t ON t.tenant_id = a.tenant_id AND t.id = a.asset_type_id
    WHERE a.tenant_id = v_tenant
      AND ST_DWithin(a.location, p.g, least(greatest(p_radius_m, 0), 100))
      AND t.kind::text = p.kind
      AND a.lifecycle <> 'DECOMMISSIONED'
    ORDER BY ST_Distance(a.location, p.g)
    LIMIT 3
  ) n
  ORDER BY p.line, n.distance_m;
END
$$;
--> statement-breakpoint
GRANT SELECT (tenant_id, id, code, lifecycle, location, asset_type_id) ON ooh_asset TO ooh_auth;
--> statement-breakpoint
GRANT SELECT (tenant_id, id, kind) ON asset_type TO ooh_auth;
--> statement-breakpoint
ALTER FUNCTION asset_nearby_same_kind(jsonb, double precision) OWNER TO ooh_auth;
--> statement-breakpoint
REVOKE ALL ON FUNCTION asset_nearby_same_kind(jsonb, double precision) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION asset_nearby_same_kind(jsonb, double precision) TO ooh_app;
