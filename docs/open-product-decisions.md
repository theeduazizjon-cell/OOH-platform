# Open Product Decisions

Each item is ambiguous in the roadmap and expensive to change later. **Recommended** = the default the architecture
assumes.

> **Status 2026-09-25: all recommended defaults ACCEPTED** by the product owner ("proceed with recommended defaults").
> Changing one later requires a new ADR or an update to this file.

| ID | Question | Options | Recommended | Blocks |
|---|---|---|---|---|
| **OPD-00** | Where does the code live? The current repo is an unrelated MERN movie-booking app. | (a) new repo `ooh-platform`; (b) wipe this repo | **(a)** new repo; move `docs/` there | Sprint 1 |
| **OPD-01** | Is **Lead** a separate entity? R§7 defines Lead as "before qualification" but the pipeline puts LEAD/CONTACTED/QUALIFIED in the same sequence as opportunity stages. | (a) separate Lead → converts into Organisation + Contact + Opportunity; (b) one Opportunity pipeline whose first stages are lead stages, org classified "prospect" | **(b)** for MVP: fewer entities, one kanban, matches R§7 pipeline. Add a lightweight Lead inbox (a) later if unmatched raw leads become common | M2 |
| **OPD-02** | What is the **bookable unit**? | (a) face; (b) mount position; (c) asset | **(a) Face** everywhere, with "book both faces together" for flag types (R§15: each face may carry a different arrow) | M4 |
| **OPD-03** | Does publishing a study **reserve** positions? | (a) no hold until approval; (b) tentative hold with expiry (non-exclusive, warns); (c) exclusive hold | **(b)**: tentative, 14-day configurable expiry, conflicts flagged; exclusive only on approval | M6–M7 |
| **OPD-04** | Does every **map-click candidate** become an inventory asset? | (a) yes, as PROSPECTIVE; (b) only when approved | **(a)**, so research becomes reusable knowledge [R§13] | M5–M6 |
| **OPD-05** | Is installation **evidence reviewed** before a location goes live? R§26 says "once evidence is accepted". | (a) buyer review always; (b) auto-accept when GPS within X m and photo present; (c) per-tenant setting | **(a)** in MVP with bulk-accept; (b) as a tenant option later | M9 |
| **OPD-06** | Can a buyer **record client decisions on the client's behalf** (e.g. approval received by email/phone)? | yes (with evidence + audit) / no | **Yes**, with mandatory note/attachment, flagged "recorded on behalf" | M7 |
| **OPD-07** | Study granularity: per **location** or per **campaign**? | per location / per campaign / both | **Per location** (R§12 lists study per location); portal groups them per campaign | M6 |
| **OPD-07b** | Can a brief **add locations to an existing campaign**? | yes / no | **Yes**, since clients add stores to running programmes | M3 |
| **OPD-08** | Can an approval be **revoked**? | never / before production sent / always | **Before production order is sent**, internal users only, with reason | M7 |
| **OPD-09** | When does a location go **LIVE** if only some positions are installed (e.g. 6/7)? | (a) only at 7/7; (b) at first installed, show "6/7"; (c) buyer decides with reason | **(c)**: LIVE requires all or an explicit "go live partially" with reason for the remaining ones | M9 |
| **OPD-10** | Removal timing | fixed T−7 / configurable | **Configurable** per tenant (default: reminder + job at T−7, unassigned alert T−3, critical after end + 2 days grace) | M10 |
| **OPD-11** | **Currency & VAT** | RON only / multi-currency / VAT handling | Store currency per line (RON default, EUR allowed), all amounts **net of VAT**, no FX conversion in MVP; reports grouped by currency | M8 |
| **OPD-12** | Source of **client selling price** | per-asset list price / SELL tariffs / per-campaign quote | **SELL tariff rules** (client-specific where needed) with per-line override + reason. R§32 per-asset examples are covered by asset-type/area/client rules | M8 |
| **OPD-13** | Rental **billing unit & pro-rating** | per month / per day / per campaign; pro-rate partial months? | Unit on tariff (MONTH/DAY/CAMPAIGN); pro-rate by days for MONTH | M8 |
| **OPD-14** | **Email ingestion** mechanism | (a) per-tenant forwarding address (provider inbound webhook); (b) OAuth connect to Gmail/M365 mailbox | **(a)** in MVP (simple, provider-agnostic); (b) P2 | M13 |
| **OPD-15** | External **client authentication** | full accounts / magic links / signed one-time study links | **Accounts with magic-link login** (no password needed); signed anonymous links not in MVP (weaker audit) | M7 |
| **OPD-16** | **Agency visibility granularity** | all campaigns where agency = org / restricted to assigned end clients | All where agency = org in MVP; per-user client restriction P2 | M7 |
| **OPD-17** | Are **decorators** external subcontractors, employees, or both? Are teams modelled? | | Both; a team = subcontractor organisation; jobs assignable to a user or a team (all team members see it) | M9 |
| **OPD-18** | **Hosting / data residency / AI provider terms** | | EU region; LLM + email + maps providers under DPA; zero-data-retention for LLM | M14 |
| **OPD-19** | **Google Maps ToS**: storing geocodes; Street View images in PDF studies ("where permitted" R§20) | | Store user-confirmed pins + place_id + pano references only; legal review before image exports | M5, P2 |
| **OPD-20** | **Geographic areas** for tariffs/filters | counties/cities (admin boundaries) / custom polygons / both | Seed Romanian counties + major cities; custom polygons allowed | M8 |
| **OPD-21** | **UI language** | English / Romanian / both | Both via i18n from day one (strings externalised); default Romanian? Needs confirmation | M0 |
| **OPD-22** | **Maintenance/repair** in MVP? Not in the MVP list, but the decorator example shows "3 repairs". | | Field job type exists (cheap); no special workflow | M9 |
| **OPD-23** | Can a **rejected** position be re-proposed in a later study version? | | Yes; history shows prior rejection | M6 |
| **OPD-24** | **Artwork approval**: is artwork checked by the buyer before sending to print? | received only / received + approved | Received + buyer "OK for print" flag | M8 |
