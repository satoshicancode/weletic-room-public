# Controlled import reproduction — September 13, 2026

Status: both probes are implemented and have bounded isolated evidence below.
The earlier failure was not reproduced. L12 remains open; this document neither
authorizes a full-scale rerun nor establishes a cause for the earlier failure.

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

## Probe B evidence

On September 13, the isolated MySQL test selected the two new reporter variants
and the existing expired-lease case: **3 passed, 53 skipped, 8.35 seconds**.
Both new cases observed the pinned Prisma client's `P2028` transaction-API error
after a test-only one-second deadline. They prove identical-object propagation,
one operation and report invocation, preservation when reporting throws, exact
snapshot rollback, and zero ledger/execution writes. The event deliberately
says transaction failure, not a diagnosis of the historical import failure.

The runner verified the dedicated loopback instance identity and schema before
execution, revoked its temporary fixture grant afterward, and independently
verified all 157 fixture tables empty. No schema, runtime import deadline,
Shopify data or external delivery was changed. An earlier launch attempt stopped
before tests because dependency links were missing; its grant was also revoked
and its fixture verified empty before the corrected run.

The existing observer/polling unit tests also passed (32 tests). The controlled
transaction uses the real database and diagnostic helper but does not execute
an import row or reproduce the earlier full-scale failure. Long-duration stability
and the complete 50,000-row lifecycle remain unverified.

## Probe A evidence

Two separate invocations ran sequentially on isolated MySQL 8.0.46, without
concurrent builds, typechecks or unit/load tests. Both used base commit
`1befd02cc4e7dd7eb7b80845e665c2a4d2bb6f16` plus the reviewed test changes,
identified by test-file Git blob `7d918e51b942165a27f573104769b2e91837ab21`.
The runner verified this fingerprint was unchanged after each invocation.

| Synthetic committed prefix | Real commits, delivery 1 | Delivery 1 time | Real commits, delivery 2 | Delivery 2 time |
| -------------------------- | ------------------------ | --------------- | ------------------------ | --------------- |
| 0                          | 50                       | 7,663 ms        | 50                       | 6,670 ms        |
| 8,100                      | 50                       | 12,026 ms       | 50                       | 11,246 ms       |

Each source contained 50,000 snapshots. The prefix was wholly synthetic; exactly
200 new real commits occurred across the four deliveries. Each invocation passed
one selected test with 56 skipped (73.79 and 107.94 seconds including fixture
work and cleanup). Source/ledger reconciliation and exact account assertions
passed before delivery and after each delivery. Both sources remained committing,
with pending continuation jobs and released worker ownership.

Temporary fixture grants were revoked and independent SQL verified all 157
tables empty after **each** invocation, before the next fixture was created.
The runner imposed a 660-second outer test-process-group deadline; neither run
hit it. No production timeout, schema, query or retry policy was changed.

The populated deliveries were slower in these single samples. This is not a
statistical benchmark, a query-level diagnosis, or proof that journal size alone
caused the historical failure. No stage error occurred. Two deliveries following
a synthetic prefix do not reproduce 162 preceding real deliveries, long-lived
process/resource history, or full commit/rollback. The original failure remains
unexplained; a complete lifecycle rerun is not implicitly approved by this result.

## Local verification

### September 13 model-operation timing follow-up

The existing test-only Prisma model-operation hook now also covers the bounded
commit probe. Timing is active only around each real worker delivery, excluding
synthetic setup, independent reconciliation and cleanup. Output contains static
model/operation labels, counts and durations, not query arguments or results.
Raw SQL and lock calls are **not measured** by this hook; delivery duration also
includes instrumentation overhead. These are partial timings, not SQL plans or
a diagnosis of the original failure.

Two sequential invocations used MySQL 8.0.46, base commit
`2403dd4718e8e23cbd6c4cf6bb9a3cd492e4ce7d` and test blob
`a6679f8ddf06062fdf6d5b1223eceb07fc22f4c4`. Local typechecking and lint had
finished before measurement. Each selected test passed with 56 unrelated cases
skipped (77.98 seconds for prefix 0; 111.10 seconds for prefix 8,100).

| Synthetic prefix | Delivery 1 | Delivery 2 | New real commits |
| ---------------- | ---------- | ---------- | ---------------- |
| 0                | 7,959 ms   | 7,047 ms   | 50 + 50          |
| 8,100            | 10,592 ms  | 9,915 ms   | 50 + 50          |

For delivery 2, account evidence reads increased from 1 call/6 ms to 9 calls/
644 ms; ledger `findMany` used 51 calls in both cases (653 versus 1,272 ms).
The 50 ledger `findFirst` calls also increased from 97 to 1,274 ms. Thus the
observed difference is not confined to source-wide reconciliation. Inspect the
specific ledger lookup and discovery query plans next; do not infer missing
indexes, timeout causality or a production fix from these single samples.

Both runs retained the original accounting and zero-failure assertions. Temporary
fixture grants were revoked, and independent SQL verified all 157 fixture tables
empty after each run, before starting the next. No full-scale lifecycle rerun,
schema change, production write or runtime policy change occurred. L12 stays open.

Focused lint, formatting and web typechecking passed. The first typecheck failed
because package dependency links were missing in the new checkout; the corrected
run passed after restoring those ignored links. Independent review found no
blocker and confirmed the raw-SQL coverage limitation. Full repository lint
passed all 10 tasks. The full web unit suite passed: 503 files, 8,159 tests passed
and 6 skipped (664.82 seconds). This default suite excludes the isolated database
file; the two bounded invocations above provide that execution evidence.
Publication remains pending; none of these results closes L12.

### Captured-query plan evidence

The opt-in query-plan diagnostic initially failed with Prisma `P2010` and MySQL
`3141` while replaying query-event parameters through raw EXPLAIN. The same
failure reproduced against an empty ledger, independently of a populated source.
This was a diagnostic replay failure, not reproduction of the original import
failure. The successful model query logged JSON scalar values as plain strings;
replaying those directly into `JSON_CONTAINS` lost their JSON string encoding.

The test-only replay helper now restores encoding only for four direct
`JSON_CONTAINS` string arguments. Paths, ordinary identifiers, limits and input
arrays remain unchanged. Unsupported placeholder shapes fail with fixed errors.
Neither production queries nor accounting behavior changed. Captured SQL and
values remain in memory; only sanitized plan fields and error codes are emitted.

The corrected empty-ledger EXPLAIN passed (4.61 seconds). A separate one-row
fixture then compared the normal Prisma lookup and replayed SELECT, deliberately
preventing the non-JSON branches from matching. Both agreed on a positive JSON
identity match and a negative snapshot identity (1 passed, 59 skipped, 4.81
seconds). This supports the known string-identity query shape, not generic JSON
parameter replay. Both invocations revoked fixture grants and independently
verified all 157 tables empty.

The semantic fixture used base `e6a8225ee2a5b0587d4ef75d92a9210e1df1d955`,
integration blob `ffe80debfb8c00e6d9b071c64ee7883cf8084a64`, and helper blob
`372d664ea87746d8626d1da5a169a7bd6eed239b`. Focused helper tests passed (43).
Publication remains pending; L12 is not closed.

The corrected baseline probe then passed (1 passed, 59 skipped, 72.12 seconds).
It committed 50 rows per delivery in 8,371 and 7,451 ms. EXPLAIN ran after each
delivery, outside its measured interval: both plans used access type `ALL`, no
chosen key, and estimated 50 then 100 rows per scan. These are optimizer
estimates, not measured scanned-row counts. Original financial assertions passed;
the temporary grant was revoked and independent SQL verified 157 empty tables.
This invocation used the same integration/helper fingerprints recorded above.

The synthetic 8,100-row-prefix invocation also passed (1 passed, 59 skipped,
95.03 seconds), completing both deliveries and committing
50 new rows each in 10,721 and 10,156 ms. Both captured plans used `ALL` with no
chosen key; optimizer estimates were 7,832 and 7,882 rows per scan. Estimates are
not exact fixture counts. Financial and zero-failure assertions passed, the
temporary grant was revoked, and independent SQL verified all 157 tables empty.
The same source fingerprints were verified before and after this invocation.

These actual captured-query plans confirm a scan for the orphan lookup in both
fixtures. They do not establish that this scan caused the earlier failure, nor
justify weakening the global corruption check. A future optimization must retain
all idempotency, reference and JSON-provenance branches, including foreign-store
orphan detection. Any new index/schema design remains a separate reviewed change.
The original long-duration failure and full 50,000-row commit/rollback acceptance
remain unresolved.

Final local verification passed web typechecking, all 10 repository lint tasks,
formatting and the full unit suite (504 files; 8,202 passed, 6 skipped; 600.49
seconds). The first direct unit invocation omitted the existing synthetic CI
environment and failed 30 tests across six Shopify-related files. The complete
rerun used the existing CI-fixture runner with external queue/Redis transports
disabled and sequential files; it passed without changing assertions or
production code. Both results were retained. Adversarial review found no blockers
in the known-shape replay or JSON-only match/nonmatch coverage.

### Original bounded probe verification results

The full web unit suite passed: 500 files, 8,095 tests passed and 6 skipped
(629.61 seconds). This default suite excludes the isolated integration file;
the database evidence above comes from separate opt-in executions. Web typecheck
passed after both probe implementations. Repository lint passed, followed by
focused lint after Probe A was added. Formatting and independent adversarial
review passed. These checks do not establish native Shopify or launch acceptance.
