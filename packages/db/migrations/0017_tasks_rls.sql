-- Custom migration: task RLS (standard tenant isolation). Tasks are cancelled, never deleted by the app.

ALTER TABLE task ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE task FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON task
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
REVOKE DELETE ON task FROM ooh_app;
