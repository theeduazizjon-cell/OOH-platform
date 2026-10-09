-- Custom migration: inventory RLS, the no-overlap rule for asset terms, and the mount-position limit
-- of the asset's type (a pole has at most 2).

ALTER TABLE asset_type ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE asset_type FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON asset_type
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
REVOKE DELETE ON asset_type FROM ooh_app;
--> statement-breakpoint
ALTER TABLE dimension_preset ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE dimension_preset FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON dimension_preset
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
REVOKE DELETE ON dimension_preset FROM ooh_app;
--> statement-breakpoint
ALTER TABLE ooh_asset ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ooh_asset FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON ooh_asset
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
-- Assets are decommissioned, never deleted (research and bookings reference them).
REVOKE DELETE ON ooh_asset FROM ooh_app;
--> statement-breakpoint
ALTER TABLE mount_position ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE mount_position FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Mounts and faces may be removed while correcting an asset (bookings, later, keep theirs by FK).
CREATE POLICY tenant_isolation ON mount_position
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE advertising_face ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE advertising_face FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON advertising_face
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE asset_terms ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE asset_terms FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON asset_terms
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
-- Terms are history: a period is closed and a new one added, never deleted.
REVOKE DELETE ON asset_terms FROM ooh_app;
--> statement-breakpoint
-- One set of terms per asset at any date (05-domain-model §inventory).
ALTER TABLE asset_terms ADD CONSTRAINT asset_terms_no_overlap_ex
  EXCLUDE USING gist (tenant_id WITH =, asset_id WITH =, valid_period WITH &&);
--> statement-breakpoint
ALTER TABLE asset_block ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE asset_block FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON asset_block
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
-- Blocks are released (released_at), never deleted.
REVOKE DELETE ON asset_block FROM ooh_app;
--> statement-breakpoint
CREATE INDEX asset_block_period_idx ON asset_block USING gist (asset_id, period);
--> statement-breakpoint
-- The type template's mount limit (05-domain-model §1.3: "POLE has max 2 (DB CHECK via type template)").
CREATE OR REPLACE FUNCTION mount_position_within_type_limit() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $$
DECLARE
  max_positions integer;
  existing integer;
BEGIN
  SELECT t.max_mount_positions INTO max_positions
    FROM ooh_asset a JOIN asset_type t ON t.id = a.asset_type_id
   WHERE a.id = NEW.asset_id;
  IF max_positions IS NULL THEN
    RETURN NEW;
  END IF;
  -- Serialise concurrent inserts for the same asset.
  PERFORM 1 FROM ooh_asset WHERE id = NEW.asset_id FOR UPDATE;
  SELECT count(*) INTO existing FROM mount_position WHERE asset_id = NEW.asset_id;
  IF existing >= max_positions THEN
    RAISE EXCEPTION 'asset type allows at most % mount positions', max_positions
      USING ERRCODE = 'check_violation', CONSTRAINT = 'mount_position_type_limit_ck';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER mount_position_type_limit
  BEFORE INSERT ON mount_position
  FOR EACH ROW EXECUTE FUNCTION mount_position_within_type_limit();
