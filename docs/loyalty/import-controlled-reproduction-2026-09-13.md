# Controlled import reproduction — September 13, 2026

Status: execution specification only. These probes have not run. L12 remains
open; this document neither authorizes a full-scale rerun nor establishes a
cause for the earlier failure.

## Question and baseline

The [retained failure evidence](./import-failure-evidence-2026-09-13.md)
records 8,100 real commits before a failed delivery on a 50,000-row source.
The nested cause is unknown. Separate these questions before changing runtime:

- Does selecting and processing a bounded batch become slow with a populated
  execution journal, even without hours of preceding worker activity?
- Can the existing stage observer retain a real database error without losing
  the original error, leaking private material or changing accounting?

Use public main at a recorded SHA, not the parked import branch. Record the
MySQL version, verified isolated instance identity, schema revision, process
concurrency, source size, synthetic prefix size and exact test selector. Do not
publish connection strings, database credentials, fixture identities or raw SQL
results containing shopper data.

## Implementation boundary

Extend the existing opt-in isolated suite at
`apps/web/tests/weletic/historical-import-source-db.integration.test.ts` and its
test-only helpers. No production timeout, lease, retry, index, schema, API or
accounting changes are part of this experiment. No changes to CI workflows.

Use the already isolated loopback MySQL runner only after verifying its exact
instance and disposable database allowlist. Refuse a missing or mismatched
identity; never fall back to the regular application database. Preserve the
runner's temporary-grant revocation and independent empty-table verification.
Do not start Shopify, email, deployment or external queue consumers.

## Probe A: populated-journal differential

Create two sequential disposable fixtures, never concurrent fixtures:

1. A 50,000-row source with no committed prefix.
2. An otherwise equivalent 50,000-row source with an explicitly **synthetic**
   8,100-row committed prefix. Reuse the populated-rollback fixture pattern to
   construct internally consistent accounts, opening-balance ledger entries,
   snapshots and execution records. Reuse its record-construction approach,
   not its real-row template execution: this prefix must be wholly synthetic,
   with no runtime commits during setup. Do not fabricate historical earns.

Explicitly clean up and independently verify the first fixture before creating
the second. Sequential test execution alone is insufficient: the current suite
normally removes database fixtures in `afterAll`, not `afterEach`.

Verify the synthetic prefix using the existing independent execution-proof
reader before invoking a worker. A fixture that does not reconcile is a fixture
failure, not a runtime finding. Retain immutable source provenance and current
store/program/installation-generation ownership in every relation.

Run at most **two real worker deliveries per fixture**, with the existing batch
limit and time budget unchanged. Expect positive bounded progress, not exactly
50 rows: the runtime may yield early when its batch time budget is reached.
Determine the committed delta independently from SQL before and after each
delivery. Stop immediately on a failed/dead-lettered delivery or proof mismatch.

After each delivery assert:

- No duplicate opening-balance ledger entries or cross-store writes.
- Exact ledger net and account balances agree with the independently counted
  committed rows, using integer arithmetic.
- Unprocessed rows have no execution or financial effects.
- Successful continuation leaves the source committing and its outbox job
  pending with released worker ownership and no consumed failure attempt.
- Independent reconciliation succeeds and does not report full completion.

Capture bounded stage-failure markers and sanitized job/source diagnostics
using the existing observer. Add test-only monotonic timings if required to
separate recovery, batch and continuation; never infer a nested SQL cause from
elapsed time. Compare equivalent measured stages, excluding fixture seeding.

This probe performs no more than 200 new real row commits across both fixtures.
The 8,100-row prefix is synthetic: passing does not prove 8,100 worker commits,
long-duration stability, complete rollback or the 50,000-row lifecycle.

## Probe B: diagnostic error preservation

Use a separate one-row fixture and an explicitly test-only short transaction
deadline to induce an actual interactive-transaction failure. Do not modify the
production import deadline or sleep while holding unrelated fixture locks.
Observe the failure through `observeImportStage`; retain the actual allowlisted
Prisma code if present, without requiring a guessed code across client versions.

Assert that the identical thrown object reaches the caller, the operation runs
once, diagnostic failure cannot mask the original error, and no transaction
writes survive. A successfully induced timeout validates diagnostic coverage
only; it is **not evidence that the earlier import failed from a timeout**.
Keep the existing expired-lease rejection probe as the separate ownership case.

## Stop conditions and next decision

Set explicit test and outer-run deadlines before execution. On timeout, stop
the exact test process, revoke fixture grants and reconcile cleanup; do not
automatically restart or increase timeouts. Run without concurrent builds or
load tests and record that condition, without calling prior concurrency causal.

- If a real stage failure is retained, inspect that primitive and design a
  focused regression test before proposing a runtime correction.
- If only the populated fixture slows, use read-only query-plan analysis on the
  disposable fixture to distinguish selection from proof/recovery costs.
- If both pass, report that the failure was not reproduced. The remaining
  long-duration/worker-history hypothesis stays unknown; do not declare a fix
  or automatically launch the full-scale test.
- If cleanup cannot be independently verified, quarantine that exact fixture
  and report the failure. Do not continue into another database or erase a
  broad directory/container collection.

Definition of done for this bounded investigation: committed test implementation,
focused tests and typecheck, adversarial review, recorded run SHA and sanitized
results for each executed probe, exact accounting reconciliation, and verified
grant revocation/fixture cleanup. Full-scale import acceptance is a separate
gate and remains subject to unchanged zero-failure and financial assertions.
