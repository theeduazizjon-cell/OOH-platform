-- Custom migration: name normalisation for CRM duplicate detection (docs/architecture/07-database.md §Search).
-- Must run before the organisation table, whose generated `name_key` column uses crm_name_key().

-- unaccent() is only STABLE because it resolves its dictionary through search_path. With the
-- dictionary named explicitly the result is fixed, so this wrapper can be IMMUTABLE (required for
-- generated columns and index expressions).
CREATE OR REPLACE FUNCTION immutable_unaccent(value text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  SET search_path = public, pg_temp
  AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, value) $$;
--> statement-breakpoint

-- Comparable form of a company name: lower case, no diacritics (Râșnov = Rasnov), legal forms removed
-- ("Carrefour Romania S.R.L." = "carrefour romania"), punctuation collapsed to single spaces.
CREATE OR REPLACE FUNCTION crm_name_key(name text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  SET search_path = public, pg_temp
  AS $$
    SELECT btrim(regexp_replace(
      regexp_replace(
        lower(immutable_unaccent(name)),
        '\m(s\.?\s?r\.?\s?l|s\.?\s?a|s\.?\s?c\.?\s?s|pfa|ltd|llc|inc|gmbh|plc|ag|bv|nv)\M\.?',
        ' ', 'g'),
      '[^a-z0-9]+', ' ', 'g'))
  $$;
