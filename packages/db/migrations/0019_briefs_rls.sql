-- Custom migration: RLS for briefs and the cross-cutting state tables (standard tenant isolation).

ALTER TABLE brief ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE brief FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON brief
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
-- Briefs are discarded, never deleted by the app.
REVOKE DELETE ON brief FROM ooh_app;
--> statement-breakpoint
ALTER TABLE brief_line ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE brief_line FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Lines of a draft are replaced as a whole, so the app may delete them (the audit keeps the diff).
CREATE POLICY tenant_isolation ON brief_line
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE status_history ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE status_history FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON status_history
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
-- Append-only history.
REVOKE UPDATE, DELETE ON status_history FROM ooh_app;
--> statement-breakpoint
ALTER TABLE outbox_event ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE outbox_event FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON outbox_event
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
-- The worker (M3c) marks events dispatched; nothing deletes them from the app.
REVOKE DELETE ON outbox_event FROM ooh_app;
