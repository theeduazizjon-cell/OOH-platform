-- Custom migration: RLS for campaigns and their locations (standard tenant isolation). Both are
-- cancelled (or archived), never deleted by the app.

ALTER TABLE campaign ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE campaign FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON campaign
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
REVOKE DELETE ON campaign FROM ooh_app;
--> statement-breakpoint
ALTER TABLE campaign_location ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE campaign_location FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON campaign_location
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
REVOKE DELETE ON campaign_location FROM ooh_app;
