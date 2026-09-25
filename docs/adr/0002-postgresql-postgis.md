# ADR-0002: PostgreSQL + PostGIS as the single system of record
- Status: Proposed · Date: 2026-09-25
## Context
GIS is mission-critical (R§47C): radius/viewport search, distances, point-in-area tariff matching, clustering over tens of thousands of assets. Integrity rules: no double booking, no duplicate tariffs.
## Decision
PostgreSQL 16 + PostGIS 3.4 with btree_gist, pg_trgm, citext, unaccent. Points stored as geography(Point,4326). Business invariants enforced by exclusion constraints. No search engine in MVP.
## Consequences
One datastore to operate and back up. Requires managed Postgres with PostGIS in every environment.
## Alternatives
MongoDB (weak relational integrity, no exclusion constraints); Elasticsearch (unnecessary at this scale).
