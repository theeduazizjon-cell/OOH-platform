# ADR-0009: AI is advisory, enforced structurally

- Status: Accepted · Date: 2026-09-25

## Decision

AI outputs are drafts, suggestions or tool-grounded answers. The AI principal's permission set excludes all approve/decide/verify/availability/commercial-write/evidence-review/complete permissions (R§39). Every run is logged in ai_run with model and prompt version. Email extraction runs without tools (prompt-injection containment).
