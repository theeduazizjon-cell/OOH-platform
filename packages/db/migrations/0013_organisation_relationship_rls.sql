-- Custom migration: organisation_relationship RLS. Relationships are links, removable by the app
-- (the audit trail keeps their history).

ALTER TABLE organisation_relationship ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE organisation_relationship FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON organisation_relationship
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
