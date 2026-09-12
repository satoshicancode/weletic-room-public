# ADR 0024: Bounded import rollback transactions

- Date: 2026-09-09
- Status: Accepted; draft/merge hold superseded by ADR 0031
- Stakeholders: Hiro (PO), Codex (impl)

## Context

Historical import rollback currently verifies the complete immutable source and
ledger evidence in every single-row transaction. A synthetic populated 50,000-row
source required approximately 25 seconds for one real rollback row in isolated
MySQL. This is diagnostic evidence, not a measured full-source runtime or live
acceptance. Yielding between atomic rows bounds queue deliveries but does not
resolve the repeated full-source proof cost.

Proof cannot be cached across transactions: source revision does not advance for
every row, and later orphan, foreign or corrupt evidence must fail closed. Store,
program, source, installation generation and queue ownership fences remain
mandatory, as do append-only corrections and field ownership checks.

## Decision

Hiro approved bounded multi-row rollback transactions in chat. A small group of
at most ten rows will share one fresh transaction and one full-source proof under
the existing store/program/source/queue locks. Each row retains its execution and
account locks, field preparation, ledger correction and acknowledgement checks.
No proof is reused after commit. The single-row entry point remains compatible.

A failure aborts all changes in that transaction. Only after the transaction has
aborted may a fresh, same-lease-fenced transaction contain the conflicting row and
source. Previously committed groups remain durable. The existing delivery budget,
transaction timeout, durable continuation and independent finalization proof stay
in place. No schema, public API, deployment or production authority is added.

## Alternatives considered

- **Keep one-row transactions** — smallest failure unit, but repeats the expensive
  full-source proof for every row.
- **Verify only at claim and finalization** — rejected because proof from another
  transaction cannot authorize later writes against changed evidence.
- **One transaction for the entire source** — rejected because lock duration,
  timeout risk and failure scope grow with the full import.

## Consequences

### Positive

- Amortizes source verification without trusting evidence across transactions.
- Keeps bounded retry work and durable progress between groups.

### Negative / trade-offs accepted

- A late conflict rolls back earlier rows in the same group.
- More accounts remain locked until a group commits; throughput and timeout
  behavior require measurement rather than assumption.

### Follow-ups

- Verify multi-row atomicity, containment, replay and stale-owner rejection.
- Re-profile populated-source delivery and preserve honest scale limitations.
- Keep PR #13 draft pending shared-schema compatibility and release gates.

## References

- [Historical import implementation](../loyalty/historical-import-implementation.md)
- [Public draft PR #13](https://github.com/satoshicancode/weletic-room-public/pull/13)
- [Durable import jobs](0023-durable-import-jobs-and-no-tier-rollback.md)
