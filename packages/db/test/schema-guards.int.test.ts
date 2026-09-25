/**
 * Structural guards that every FUTURE migration must also satisfy. When a new table is added
 * without RLS or with a single-column FK across tenant tables, these tests fail.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { ownerConnection } from './helpers';

const owner = ownerConnection();
const sql = owner.client;
afterAll(() => owner.close());

/** Application tables in `public` (excludes extension-owned tables such as spatial_ref_sys). */
const appTables = () => sql`
  SELECT c.oid, c.relname, c.relkind, c.relispartition, c.relrowsecurity, c.relforcerowsecurity
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')
`;

describe('schema guards', () => {
  it('every application table has RLS enabled, forced, and at least one policy', async () => {
    const rows = await sql<
      { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean; policies: number }[]
    >`
      SELECT t.relname, t.relrowsecurity, t.relforcerowsecurity,
             (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = t.oid) AS policies
      FROM (${appTables()}) t
      WHERE NOT t.relispartition
      ORDER BY t.relname`;
    expect(rows.length).toBeGreaterThan(0);
    const offenders = rows.filter((r) => !r.relrowsecurity || !r.relforcerowsecurity || r.policies === 0);
    expect(offenders.map((r) => r.relname)).toEqual([]);
  });

  it('every policy is keyed on the tenant/user context (no permissive USING (true) policies)', async () => {
    const rows = await sql<{ table: string; policy: string }[]>`
      SELECT tablename AS table, policyname AS policy
      FROM pg_policies
      WHERE schemaname = 'public'
        AND NOT (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ~ 'app_current_(tenant|user|actor)_id\\(\\)'`;
    expect(rows).toEqual([]);
  });

  it('partitions are not directly accessible to the app role (RLS lives on the parent)', async () => {
    const rows = await sql<{ relname: string; accessible: boolean }[]>`
      SELECT t.relname,
             has_table_privilege('ooh_app', t.oid, 'SELECT,INSERT,UPDATE,DELETE') AS accessible
      FROM (${appTables()}) t
      WHERE t.relispartition`;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.accessible).map((r) => r.relname)).toEqual([]);
  });

  it('foreign keys between tenant-owned tables include tenant_id (composite FK)', async () => {
    const rows = await sql<{ conname: string }[]>`
      SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class src ON src.oid = con.conrelid
      JOIN pg_class tgt ON tgt.oid = con.confrelid
      JOIN pg_namespace n ON n.oid = src.relnamespace
      WHERE con.contype = 'f' AND n.nspname = 'public'
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = src.oid AND a.attname = 'tenant_id')
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = tgt.oid AND a.attname = 'tenant_id')
        AND NOT EXISTS (
          SELECT 1 FROM unnest(con.conkey) k
          JOIN pg_attribute a ON a.attrelid = src.oid AND a.attnum = k
          WHERE a.attname = 'tenant_id')`;
    expect(rows.map((r) => r.conname)).toEqual([]);
  });

  it('tenant-owned tables with an id expose UNIQUE (tenant_id, id) for composite references', async () => {
    const rows = await sql<{ relname: string }[]>`
      SELECT t.relname
      FROM (${appTables()}) t
      WHERE t.relkind = 'r' AND NOT t.relispartition
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = t.oid AND a.attname = 'tenant_id')
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = t.oid AND a.attname = 'id')
        AND NOT EXISTS (
          SELECT 1 FROM pg_constraint con
          WHERE con.conrelid = t.oid AND con.contype IN ('u', 'p')
            AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
                 FROM unnest(con.conkey) k
                 JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k) = ARRAY['id', 'tenant_id'])`;
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it('the runtime role cannot bypass RLS and owns nothing', async () => {
    const [roleRow] = await sql<
      { rolsuper: boolean; rolbypassrls: boolean }[]
    >`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'ooh_app'`;
    expect(roleRow).toEqual({ rolsuper: false, rolbypassrls: false });
    const owned = await sql`
      SELECT c.relname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE r.rolname = 'ooh_app'`;
    expect(owned).toHaveLength(0);
  });

  it('required extensions are installed', async () => {
    const rows = await sql<{ extname: string }[]>`SELECT extname FROM pg_extension`;
    const names = rows.map((r) => r.extname);
    for (const ext of ['postgis', 'btree_gist', 'pg_trgm', 'citext', 'unaccent'])
      expect(names).toContain(ext);
  });
});
