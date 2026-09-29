-- Custom migration: RLS for the CRM/config tables, trigram search on organisation names, and the
-- membership → organisation reference that external members need (deferred in 0001 until the CRM).

-- ═════════════════════════════════════════════════════════════════════════════
-- Standard tenant isolation.
-- ═════════════════════════════════════════════════════════════════════════════
ALTER TABLE organisation_classification ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE organisation_classification FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON organisation_classification
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
-- Configuration is disabled, never deleted by the app (business rows keep referencing it).
REVOKE DELETE ON organisation_classification FROM ooh_app;
--> statement-breakpoint

ALTER TABLE organisation ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE organisation FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON organisation
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
-- Organisations are archived (soft delete, 05-domain-model §4), never deleted by the app.
REVOKE DELETE ON organisation FROM ooh_app;
--> statement-breakpoint

ALTER TABLE organisation_classification_link ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE organisation_classification_link FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON organisation_classification_link
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- Fuzzy duplicate detection and search on the normalised name (pg_trgm, 07-database §Search).
-- ═════════════════════════════════════════════════════════════════════════════
CREATE INDEX organisation_name_key_trgm_idx ON organisation USING gin (name_key gin_trgm_ops)
  WHERE archived_at IS NULL;
--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- External members represent an organisation of the same tenant (composite FK, like every
-- tenant-owned reference). membership_external_has_organisation_ck already requires it once active.
-- ═════════════════════════════════════════════════════════════════════════════
ALTER TABLE membership ADD CONSTRAINT membership_organisation_fk
  FOREIGN KEY (tenant_id, organisation_id) REFERENCES organisation (tenant_id, id);
