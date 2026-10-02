-- Custom migration: RLS for the sales pipeline tables (standard tenant isolation, no deletes by the app).

ALTER TABLE pipeline ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE pipeline FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON pipeline
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
-- Configuration is disabled, never deleted by the app.
REVOKE DELETE ON pipeline FROM ooh_app;
--> statement-breakpoint
ALTER TABLE pipeline_stage ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE pipeline_stage FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON pipeline_stage
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
-- Stages are disabled, never deleted (opportunities reference them).
REVOKE DELETE ON pipeline_stage FROM ooh_app;
--> statement-breakpoint
ALTER TABLE activity_type ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE activity_type FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON activity_type
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
-- Configuration is disabled, never deleted by the app.
REVOKE DELETE ON activity_type FROM ooh_app;
--> statement-breakpoint
ALTER TABLE opportunity ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE opportunity FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON opportunity
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
-- Opportunities are closed or archived, never deleted by the app.
REVOKE DELETE ON opportunity FROM ooh_app;
--> statement-breakpoint
ALTER TABLE activity ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE activity FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON activity
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
-- The timeline is history: never deleted by the app.
REVOKE DELETE ON activity FROM ooh_app;
