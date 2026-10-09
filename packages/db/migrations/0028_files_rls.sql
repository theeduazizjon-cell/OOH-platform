-- Custom migration: files RLS (standard tenant isolation).

ALTER TABLE file_object ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE file_object FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON file_object
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
-- File rows are never deleted by the app (orphans and retention are purged by maintenance jobs).
REVOKE DELETE ON file_object FROM ooh_app;
--> statement-breakpoint
ALTER TABLE file_link ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE file_link FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Links can be removed (the audit trail records it); the file itself stays.
CREATE POLICY tenant_isolation ON file_link
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
