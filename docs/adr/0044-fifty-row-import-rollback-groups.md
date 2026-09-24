# ADR 0044: Fifty-row import rollback groups

- Date: 2026-09-25
- Status: Accepted
- Stakeholders: Hiro (PO), Codex (impl)

## Context

ADR 0024 bounds historical-import rollback to ten rows per atomic transaction,
with one fresh full-source proof inside each transaction. That proof checks
source ownership, account and shopper identity, claimed ledger evidence and
global orphans. It cannot be cached across transactions without weakening the
financial invariant.

A strict isolated 50,000-row lifecycle committed all 50,000 rows but stopped
after 11,970 confirmed rollback rows when delivery 242 hit Prisma `P2028`.
The run did not establish restart recovery or final reconciliation. A separate
bounded profile on a populated synthetic source rolled back 50 rows in 32.071
seconds with ten-row groups and repeated the full-source reads eight times.
A 50-row prototype took 11.458 seconds with four such reads. These are local
measurements, not a provider throughput guarantee.

## Decision

Raise `HISTORICAL_IMPORT_ROLLBACK_TRANSACTION_ROWS` from 10 to 50, matching the
existing worker-delivery row cap. Each group still performs one fresh proof
under the store, program, source and queue locks within a repeatable-read
transaction. Row-level execution, account, field ownership, ledger correction,
acknowledgement and final lease checks remain. The 30-second transaction
timeout, soft delivery budget and independent finalization proof remain.
No proof crosses a transaction boundary.

If any row or final fence fails, the entire group aborts before a separate
same-lease transaction may contain the conflicting row and source. Previously
committed groups remain durable. This amends the bound in ADR 0024, not the
schema or the code-integration versus release distinction in ADR 0031.

## Alternatives considered

- **Keep ten-row groups and optimize proof queries** — retains the smaller
  failure unit, but repeats complete proofs for a normal 50-row delivery and
  did not address the observed timeout under the unchanged verifier.
- **Cache a proof across groups** — rejected because changed source or orphan
  evidence between transactions could authorize an invalid correction.
- **Use an adaptive or unbounded group** — rejected because failure scope and
  lock duration would no longer have one auditable maximum.

## Consequences

### Positive

- Amortizes the mandatory full-source proof across the existing 50-row
  delivery cap without relaxing financial or tenancy assertions.
- Reduces transaction and proof count in the measured bounded profile.

### Negative / trade-offs accepted

- A late conflict can abort 49 earlier corrections, and up to 50 accounts and
  ledger rows can remain locked until the transaction ends.
- The unchanged timeout may still fail on a larger or contended provider source;
  the bounded profile does not prove 50,000-row acceptance.

### Follow-ups

- Verify atomicity, stale-owner rejection, interruption and replay at the new
  bound with real SQL and supervised worker recovery.
- Re-run 50,000 actual commits and 50,000 actual rollbacks with unchanged
  assertions, then perform independent final reconciliation.
- Keep exact-target schema and provider read-plan, deployment and live-operation
  gates separate from code integration.

## References

- [ADR 0024](0024-bounded-import-rollback-transactions.md)
- [ADR 0031](0031-import-code-integration-release-separation.md)
- [Rollback group profile](../loyalty/historical-import-rollback-group-2026-09-24.md)
- [Latest failed scale attempt](../loyalty/historical-import-scale-attempt-2026-09-24.md)
