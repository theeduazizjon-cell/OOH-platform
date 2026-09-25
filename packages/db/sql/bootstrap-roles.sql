-- Cluster-level bootstrap. Run ONCE per PostgreSQL cluster, as a superuser, BEFORE migrations.
--
-- Roles are cluster objects, so they don't belong in per-database migrations. Locally this file is
-- mounted into the postgis container's /docker-entrypoint-initdb.d. Integration tests run it
-- themselves. In staging/production the role is provisioned by infrastructure code with a secret
-- password; the migrations only reference it by name.
--
--   ooh_app : the runtime role used by the API and worker (DATABASE_URL).
--             NOSUPERUSER + NOBYPASSRLS, so Row-Level Security always applies to it.
--             It owns nothing and receives only DML grants from the migrations.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ooh_app') THEN
    CREATE ROLE ooh_app LOGIN PASSWORD 'ooh_app' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;
