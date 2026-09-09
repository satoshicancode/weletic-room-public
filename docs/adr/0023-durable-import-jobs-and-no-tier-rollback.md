# ADR 0023: Durable import jobs and no-tier rollback history

- Date: 2026-09-09
- Status: Accepted
- Stakeholders: Hiro (PO), Codex (implementation)

## Context

Historical loyalty imports already have immutable source/row evidence and atomic
opening-balance execution. Their three tables exist only in the isolated local
database. Request-local execution cannot provide durable retries, supervision or
dead letters across process failure. The existing loyalty outbox supplies those
mechanisms, but its job-type enum does not include import work.

An imported tier may replace no prior tier. Contained, append-only rollback must
represent restoration to that actual state rather than fabricate a tier or erase
history. The current tier-history destination is required. Making it nullable
requires auditing readers so absence is not confused with an unknown tier or a
new achievement.

## Decision

Add dedicated import commit and rollback outbox job types with bounded, validated,
installation-bound source references. Connect them to the existing durable outbox
and source execution/reconciliation model. Never persist raw files, shopper
identities or worker lease tokens in public responses. Preserve tenant, program,
revision, installation-generation and worker-ownership checks.

Allow a null destination in `WeleticLoyaltyTierHistory` to record a real transition
back to no tier. Rollback stays append-only and contains conflicting later
activity; it does not delete awards, erase ledger history, invent tier-entry
rewards or overwrite later customer changes.

Hiro explicitly approved implementation and schema application **only** to local
MySQL `weletic_loyalty_dev`, `127.0.0.1:3307`, using the isolated application
principal. Apply only reviewed enum/nullable-column changes after identity and
schema checks. This is not approval for shared/production schema application,
store-approval rollout, Flow action authorization, Shopify deployment or sends.

## Alternatives considered

- **Request-local or in-memory import dispatch** — rejected because a process
  exit loses scheduled progress and cannot provide durable retry/dead-letter
  evidence.
- **Reuse an unrelated outbox type** — rejected because it would misrepresent
  payload contracts, ownership and operational behavior.
- **Invent a base tier or omit rollback history** — rejected because either
  changes the original customer state or removes the audit trail.
- **Apply the full Prisma schema to every environment** — rejected because the
  approval is narrowly isolated and unrelated/shared changes remain gated.

## Consequences

### Positive

- Import work can use existing supervision and durable retry mechanisms.
- No-tier restoration has explicit, truthful history.

### Negative / trade-offs accepted

- Job consumers and tier-history readers need compatibility updates and tests.
- Local DDL proof is not authenticated merchant or live-store acceptance.

### Follow-ups

- Complete commit/rollback orchestration and merchant journeys.
- Prove interruption, replay, containment, privacy and exact fixture cleanup.
- Keep shared deployment and named `yamaxdev` acceptance separately gated.

## References

- [Isolated import tables](0021-isolated-loyalty-import-tables.md)
- [Import implementation](../loyalty/historical-import-implementation.md)
- [Company-store acceptance matrix](../loyalty/unified-acceptance-matrix.md)
- Hiro's explicit approval in this task on 2026-09-09, following the isolated
  import outbox/no-tier schema approval question.
