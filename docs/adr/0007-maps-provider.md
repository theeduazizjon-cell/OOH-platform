# ADR-0007: Google Maps Platform behind provider interfaces
- Status: Proposed · Date: 2026-09-25
## Decision
Google Maps JS + Street View + Places in the browser (referrer-restricted key); Geocoding + Routes from the backend (server key) behind a GeoProvider interface. All spatial computation that doesn't need Google (distance, radius, areas, clustering) runs in PostGIS.
## Consequences
Street View requirement satisfied. Usage costs must be monitored (quota alerts). ToS limits on caching need legal review (OPD-19).
## Alternatives
Mapbox/MapLibre + OSM (no Street View-equivalent coverage in Romania).
