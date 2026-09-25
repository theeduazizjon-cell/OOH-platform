# ADR-0008: Advertising face is the bookable unit

- Status: Accepted (OPD-02 accepted) · Date: 2026-09-25

## Decision

Asset → Mount Position → Advertising Face. Bookings reference faces; flag types book both faces of a mount together while storing a per-face creative/arrow. Double booking is prevented by a GiST exclusion constraint on (tenant_id, face_id, period) for confirmed/installed states.

## Consequences

One integrity rule for all asset types; mount position and face stay distinct concepts (R§15).
