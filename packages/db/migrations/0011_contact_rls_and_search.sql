-- Custom migration: contact RLS and name search.

ALTER TABLE contact ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE contact FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON contact
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
-- Contacts are archived, or anonymised in place for GDPR erasure; never deleted by the app.
REVOKE DELETE ON contact FROM ooh_app;
--> statement-breakpoint
CREATE INDEX contact_name_key_trgm_idx ON contact USING gin (name_key gin_trgm_ops) WHERE archived_at IS NULL;
