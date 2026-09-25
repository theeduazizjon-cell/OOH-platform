# 06 — State Machines

## Implementation pattern

- Each aggregate declares a **transition table** in `packages/contracts/src/state-machines/*.ts`:
  `{ from, action, to, permission, guard?, effects[] }`. The web app imports it to show only the allowed
  actions, and the API is the authority.
- Status columns are PostgreSQL enums (or `text` + `CHECK`), so the DB rejects unknown values.
- Status is **never** set through a generic PATCH. Only `POST /…/{id}/actions/{action}` changes it. The handler:
  `SELECT … FOR UPDATE` → check `from` + permission + guard → update + `status_history` + `audit_event`
  - `outbox_event` → commit. An invalid transition returns `409 INVALID_TRANSITION` with the allowed actions.
- Optimistic concurrency: clients send `If-Match: <version>`, and a stale version returns `412`.
- Actions whose actor is `system` are executed only by workers under the system principal.
- Legend: **Actor** B=Buyer/AM, S=Sales, F=Finance, P=Production Mgr, D=Decorator, C=Client/Agency user, SYS=system.

## 1. Lead (if OPD-01 = separate entity)

| From                    | Action     | To           | Actor | Preconditions            | Side effects                                                                     |
| ----------------------- | ---------- | ------------ | ----- | ------------------------ | -------------------------------------------------------------------------------- |
| NEW                     | contact    | CONTACTED    | S     | activity logged          | —                                                                                |
| CONTACTED               | qualify    | QUALIFIED    | S     | org + contact identified | —                                                                                |
| NEW/CONTACTED/QUALIFIED | convert    | CONVERTED    | S     | —                        | creates/links organisation (dup check), contact, opportunity at first OPEN stage |
| NEW/CONTACTED/QUALIFIED | disqualify | DISQUALIFIED | S     | reason                   | —                                                                                |

## 2. Opportunity (stages configurable; semantics fixed by stage kind)

| From kind | Action     | To kind    | Actor          | Preconditions               | Side effects                                  |
| --------- | ---------- | ---------- | -------------- | --------------------------- | --------------------------------------------- |
| OPEN      | move_stage | OPEN (any) | S (own) / Mgmt | —                           | activity auto-logged                          |
| OPEN      | win        | WON        | S              | estimated value, close date | event `opportunity.won` → task "Create brief" |
| OPEN      | lose       | LOST       | S              | lost_reason                 | —                                             |
| WON/LOST  | reopen     | OPEN       | Mgmt           | reason                      | audit                                         |

## 3. Brief

| From            | Action            | To        | Actor       | Preconditions         | Side effects                           |
| --------------- | ----------------- | --------- | ----------- | --------------------- | -------------------------------------- |
| —               | create / ai_draft | DRAFT     | B / SYS(AI) | —                     | AI: notify buyer                       |
| DRAFT           | confirm           | CONFIRMED | B           | required fields valid | AI fields → human-confirmed            |
| CONFIRMED       | reopen            | DRAFT     | B           | not converted         | —                                      |
| CONFIRMED       | convert           | CONVERTED | B           | client org set        | creates campaign + locations (same tx) |
| DRAFT/CONFIRMED | discard           | DISCARDED | B           | reason                | email marked handled                   |

## 4. Campaign (umbrella; mostly derived)

| From      | Action        | To               | Actor    | Preconditions                     | Side effects                 |
| --------- | ------------- | ---------------- | -------- | --------------------------------- | ---------------------------- |
| —         | create        | ACTIVE           | B        | —                                 | —                            |
| ACTIVE    | complete      | COMPLETED        | SYS      | all locations COMPLETED/CANCELLED | notify owner                 |
| ACTIVE    | cancel        | CANCELLED        | B + Mgmt | every location cancellable        | cascades cancel to locations |
| ACTIVE    | hold / resume | ON_HOLD / ACTIVE | B        | —                                 | pauses automation scans      |
| COMPLETED | reopen        | ACTIVE           | Mgmt     | new location added                | —                            |

The UI's "campaign status" (e.g. _LIVE 7/7_) is computed from its locations.

## 5. Campaign Location (the operational state machine)

```
DRAFT → RESEARCH → AWAITING_APPROVAL → APPROVED → IN_PRODUCTION → READY_FOR_INSTALLATION
      → INSTALLING → LIVE → REMOVAL_DUE → REMOVING → COMPLETED
(any pre-LIVE) → CANCELLED        (any) ↔ ON_HOLD (remembers previous)
```

| From                   | Action                                   | To                                     | Actor   | Preconditions                                                  | Side effects                                                                     |
| ---------------------- | ---------------------------------------- | -------------------------------------- | ------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| DRAFT                  | start_research                           | RESEARCH                               | B       | store pin CONFIRMED                                            | task research                                                                    |
| RESEARCH               | (study.published)                        | AWAITING_APPROVAL                      | SYS     | —                                                              | follow-up task                                                                   |
| AWAITING_APPROVAL      | (study.decided, ≥1 approved)             | APPROVED                               | SYS     | —                                                              | production generation                                                            |
| AWAITING_APPROVAL      | (study.decided, 0 approved) / revise     | RESEARCH                               | SYS / B | —                                                              | new study version allowed                                                        |
| APPROVED               | (production generated) / skip_production | IN_PRODUCTION / READY_FOR_INSTALLATION | SYS / B | skip needs reason                                              | installation job DRAFT                                                           |
| IN_PRODUCTION          | (production completed)                   | READY_FOR_INSTALLATION                 | SYS     | —                                                              | —                                                                                |
| READY_FOR_INSTALLATION | (installation job IN_PROGRESS)           | INSTALLING                             | SYS     | —                                                              | —                                                                                |
| INSTALLING             | (all bookings INSTALLED)                 | LIVE                                   | SYS     | accepted evidence per booking                                  | notify client; lines confirmed                                                   |
| LIVE                   | (T − N days)                             | REMOVAL_DUE                            | SYS     | end_date set                                                   | removal job + task                                                               |
| LIVE / REMOVAL_DUE     | extend                                   | LIVE                                   | B       | new end_date > old; faces free for extension (exclusion check) | cancel pending removal job, extend bookings                                      |
| REMOVAL_DUE            | (removal job IN_PROGRESS)                | REMOVING                               | SYS     | —                                                              | —                                                                                |
| REMOVAL_DUE/REMOVING   | (all bookings REMOVED)                   | COMPLETED                              | SYS     | —                                                              | —                                                                                |
| pre-LIVE states        | cancel                                   | CANCELLED                              | B       | reason                                                         | releases holds/bookings, cancels orders/jobs (with confirmation if already SENT) |
| any non-terminal       | hold / resume                            | ON_HOLD / previous                     | B       | reason                                                         | scans paused                                                                     |

Changing `start_date/end_date` after APPROVED re-runs the booking exclusion check and is audited ("who changed campaign dates" [R§40]).

## 6. OOH Asset

Two independent dimensions.

**Lifecycle**

| From            | Action           | To             | Actor    | Preconditions                                     | Side effects                           |
| --------------- | ---------------- | -------------- | -------- | ------------------------------------------------- | -------------------------------------- |
| —               | create_candidate | PROSPECTIVE    | B        | duplicate check passed/overridden                 | —                                      |
| — / PROSPECTIVE | activate         | ACTIVE         | B / Mgmt | asset_terms present (owner or supplier), ≥1 photo | enters "real inventory" lists          |
| ACTIVE          | suspend          | SUSPENDED      | B        | reason                                            | blocks new bookings (existing flagged) |
| SUSPENDED       | reinstate        | ACTIVE         | B        | —                                                 | —                                      |
| any             | decommission     | DECOMMISSIONED | Mgmt     | no future CONFIRMED bookings                      | —                                      |

**Verification** (humans only; AI never [R§39])

| From                          | Action                             | To             | Actor | Preconditions  |
| ----------------------------- | ---------------------------------- | -------------- | ----- | -------------- |
| NOT_VERIFIED / FIELD_VERIFIED | request_verification               | TO_BE_VERIFIED | B     | —              |
| NOT_VERIFIED / TO_BE_VERIFIED | record_verification                | FIELD_VERIFIED | D / B | photo evidence |
| FIELD_VERIFIED                | (verification older than N months) | TO_BE_VERIFIED | SYS   | tenant setting |

## 7. Candidate Position

| From                 | Action           | To          | Actor | Side effects     |
| -------------------- | ---------------- | ----------- | ----- | ---------------- |
| —                    | add              | SHORTLISTED | B     | —                |
| SHORTLISTED          | select_for_study | SELECTED    | B     | —                |
| SHORTLISTED/SELECTED | discard          | DISCARDED   | B     | kept for history |
| DISCARDED            | restore          | SHORTLISTED | B     | —                |

## 8. Study

| From              | Action                      | To         | Actor | Preconditions                              | Side effects                            |
| ----------------- | --------------------------- | ---------- | ----- | ------------------------------------------ | --------------------------------------- |
| —                 | create                      | DRAFT      | B     | ≥1 selected candidate                      | —                                       |
| DRAFT             | mark_ready (buyer approval) | READY      | B     | completeness validation                    | snapshot built                          |
| READY             | reopen                      | DRAFT      | B     | —                                          | —                                       |
| READY             | publish                     | PUBLISHED  | B     | recipients exist or internal-decision mode | TENTATIVE holds, notifications          |
| PUBLISHED         | (all items decided)         | DECIDED    | SYS   | —                                          | location → APPROVED or back to RESEARCH |
| PUBLISHED         | withdraw                    | WITHDRAWN  | B     | reason                                     | holds released, client notified         |
| PUBLISHED/DECIDED | supersede (new version)     | SUPERSEDED | B     | new study created                          | outstanding holds released              |

## 9. Client Decision (per study item)

| From     | Action          | To                | Actor                              | Preconditions                                 | Side effects                                      |
| -------- | --------------- | ----------------- | ---------------------------------- | --------------------------------------------- | ------------------------------------------------- |
| PROPOSED | approve         | APPROVED          | C (scope G) / B on behalf (OPD-06) | study PUBLISHED; booking can become CONFIRMED | booking TENTATIVE→CONFIRMED; rental lines drafted |
| PROPOSED | reject          | REJECTED          | C / B on behalf                    | comment recommended                           | hold → RELEASED                                   |
| PROPOSED | comment         | PROPOSED          | C / B                              | —                                             | notify other side                                 |
| APPROVED | revoke (OPD-08) | PROPOSED/REJECTED | B + Mgmt                           | no production order SENT for it               | booking released, lines voided                    |

## 10. Face Booking (availability + execution + end-of-campaign)

```
TENTATIVE → CONFIRMED → INSTALLED → REMOVAL_REQUIRED → REMOVED
TENTATIVE → RELEASED     CONFIRMED → CANCELLED
```

| From             | Action           | To               | Actor                                | Preconditions / constraint                                                                                   |
| ---------------- | ---------------- | ---------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| —                | hold             | TENTATIVE        | SYS (study publish)                  | no CONFIRMED/INSTALLED overlap; TENTATIVE overlaps allowed but flagged                                       |
| TENTATIVE        | confirm          | CONFIRMED        | SYS (client approval)                | **exclusion constraint**: no other CONFIRMED/INSTALLED/REMOVAL_REQUIRED on same face with overlapping period |
| TENTATIVE        | release / expire | RELEASED         | SYS                                  | rejection, withdrawal, or `hold_expires_at` passed                                                           |
| CONFIRMED        | install          | INSTALLED        | SYS (installation evidence accepted) | accepted evidence exists (AI can't trigger this [R§39])                                                      |
| CONFIRMED        | cancel           | CANCELLED        | B                                    | —                                                                                                            |
| INSTALLED        | require_removal  | REMOVAL_REQUIRED | SYS (T−N)                            | —                                                                                                            |
| REMOVAL_REQUIRED | remove           | REMOVED          | SYS (removal evidence accepted)      | face becomes available [R§27]                                                                                |

The physical rule: a new installation on a face can't be accepted while an earlier booking on that face is still
INSTALLED/REMOVAL_REQUIRED. The old material must come down first.

## 11. Production Order

| From          | Action     | To            | Actor             | Preconditions                        | Side effects                       |
| ------------- | ---------- | ------------- | ----------------- | ------------------------------------ | ---------------------------------- |
| —             | generate   | DRAFT         | SYS               | approved items                       | —                                  |
| DRAFT         | send       | SENT          | P                 | supplier, deadline, artwork RECEIVED | email supplier; calendar deadline  |
| SENT          | confirm    | CONFIRMED     | P / supplier (P2) | —                                    | —                                  |
| CONFIRMED     | start      | IN_PRODUCTION | P / supplier      | —                                    | —                                  |
| IN_PRODUCTION | mark_ready | READY         | P / supplier      | —                                    | notify buyer                       |
| READY         | complete   | COMPLETED     | P                 | delivered                            | cost lines; installation job draft |
| non-terminal  | cancel     | CANCELLED     | P + B             | reason; if SENT → supplier notified  | —                                  |

## 12. Field Job (installation / maintenance / removal / verification)

| From           | Action               | To          | Actor                        | Preconditions                                           | Side effects                           |
| -------------- | -------------------- | ----------- | ---------------------------- | ------------------------------------------------------- | -------------------------------------- |
| —              | create               | DRAFT       | SYS / B                      | —                                                       | task "Assign"                          |
| DRAFT          | assign               | ASSIGNED    | B                            | assignee is decorator                                   | notify decorator; price estimate lines |
| ASSIGNED       | reassign             | ASSIGNED    | B                            | —                                                       | notify both                            |
| ASSIGNED       | start                | IN_PROGRESS | D (implicit on first upload) | —                                                       | —                                      |
| IN_PROGRESS    | submit               | SUBMITTED   | D                            | each item has required evidence (or partial per OPD-09) | review task                            |
| SUBMITTED      | (all items accepted) | COMPLETED   | SYS                          | —                                                       | bookings advance; lines confirmed      |
| SUBMITTED      | (any item rejected)  | IN_PROGRESS | SYS                          | —                                                       | notify decorator (rework)              |
| DRAFT/ASSIGNED | cancel               | CANCELLED   | B                            | reason                                                  | —                                      |

Field Job Item: `PENDING → SUBMITTED → DONE | REWORK → SUBMITTED`; `PENDING → SKIPPED` (B, reason).

## 13. Removal

Removal = Field Job of type REMOVAL + booking `REMOVAL_REQUIRED → REMOVED` + location `REMOVAL_DUE → REMOVING → COMPLETED`.
Escalation ladder (automation rules, all configurable): T−7 reminder + job created → T−3 unassigned alert →
T0 not completed warning → T+grace **critical** daily until done.

## 14. Tariff Rule

| From   | Action  | To                                                   | Actor | Preconditions                                                                                                                                                  | Side effects                   |
| ------ | ------- | ---------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| —      | create  | DRAFT                                                | F     | —                                                                                                                                                              | —                              |
| DRAFT  | publish | ACTIVE                                               | F     | no ACTIVE rule with same `dimension_key` and overlapping validity (DB exclusion); ambiguity check warns about rules of equal specificity that could both match | audit "who changed a tariff"   |
| DRAFT  | delete  | (hard delete)                                        | F     | —                                                                                                                                                              | —                              |
| ACTIVE | revise  | ACTIVE (old: validity closed at D−1; new row from D) | F     | D ≥ today, or backdating permission + reason                                                                                                                   | lines already priced unchanged |
| ACTIVE | retire  | RETIRED                                              | F     | —                                                                                                                                                              | validity closed                |

ACTIVE rows are immutable except for closing `valid_period` (enforced by trigger).

## 15. Commercial Line

`DRAFT → CONFIRMED → LOCKED`. `DRAFT/CONFIRMED → VOID` (reason). LOCKED is immutable. Corrections are new
ADJUSTMENT lines. Billing: `NOT_BILLED → READY → EXPORTED → INVOICED` (revenue only).
