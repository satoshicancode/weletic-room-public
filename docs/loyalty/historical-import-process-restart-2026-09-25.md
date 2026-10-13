# Historical import process-restart rehearsal

Local isolated SQL evidence, September 25, 2026 JST. This does not establish
full-scale import acceptance or an installed release worker.

The opt-in test starts the production outbox CLI in a **new OS process** for
each delivery. A 51-row source exceeds the 50-row commit and rollback delivery
bounds, so both phases must persist a continuation and recover it under a
different worker ID. The test checks pending/unlocked outbox state between
processes, the terminal source states, 51 committed and then 51 rolled-back row
executions, 102 ledger entries with exact zero net points, and 51 zero-balance
accounts at ledger version 2. It does not kill a worker mid-transaction or prove
provider scheduling, supervision or alerts.

The targeted test passed on the `935895eb6e` group-50 rollback candidate in a
fresh disposable MySQL 8.0.46 container, bound only to loopback port 3313. The
fixture schema was `weletic_loyalty_it_import_restart_20260925`; Prisma schema
sync was applied there only. The process-restart test passed in 17.36 seconds
(one test; 63 unrelated integration tests skipped). Local log:
`/tmp/weletic-import-restart-20260925.log`, SHA-256
`f68b05eb523a316fde386a67e2cec20ffb0fe665e0ba9e80c6aef9401acf71cb`.
An independent post-test SQL query counted zero import sources, row executions,
ledger entries, accounts and stores. The disposable container was removed.

Current-main PR #140 adds an explicit opt-in guard for this process-restart
test: loopback port 3313, a declared dedicated instance and an explicit fixture
database are all required. A negative run using ordinary test port 3307 was
rejected before connecting (`Refusing non-isolated import source database`).
The strengthened test also directly counts 51 `rolled_back` row executions
after the second worker process. It passed again against a fresh disposable
MySQL 8.0.46 fixture at
`weletic_loyalty_it_import_restart_review_20260925` (one passed, 63 skipped);
independent post-test SQL again counted zero sources, executions, ledger rows,
accounts and stores. Positive log:
`/tmp/weletic-import-restart-review-20260925.log`, SHA-256
`325e5ba39f279e969e472686200e9bc9239687f03c3078311c6a564899968848`.
Guard log: `/tmp/weletic-import-restart-guard-20260925.log`, SHA-256
`2fab86cf28c2de3caa1c16046aaa9f2a4e122fc407a746a3aa0f0423472aaae6`.
The second disposable container was removed after the SQL check.

The complete isolated source-database suite then passed on PR #140's
reconciled head with another fresh MySQL 8.0.46 fixture: **54 passed,
10 intentionally skipped**, including 50-row late-conflict atomicity,
real-worker continuation and the process-restart test. Independent SQL again
counted zero remaining import sources, row executions, ledger rows, accounts and
stores. Log: `/tmp/weletic-import-pr140-full-sql-20260925.log`, SHA-256
`9635f35ca0b458aac41f6dbdbe6af487d6402e4fb315d67cd20c8543cb4a17e5`.
The fixture was `weletic_loyalty_it_import_pr140_20260925` on loopback port
3313 with the explicit dedicated-instance opt-in; it was removed afterward.

The separate [50,000-row isolated lifecycle](historical-import-rollback-group-2026-09-24.md)
subsequently passed both worker phases and independent SQL reconciliation. This
51-row test does not prove a process restart during a full-scale run. Provider
read plans, installed worker supervision and restore remain open gates.

## Full-scale process handoff on isolated SQL

The opt-in 50,000-row test on PR #158 head `aed5a94d` passed on September 25
in a dedicated MySQL 8.0.46 container bound to loopback port 3316. The fixture
was `weletic_loyalty_it_import_full_restart_20260925`. Before each phase's
remaining worker deliveries, one real outbox CLI process completed 50 rows and
a second process with a different worker ID resumed to 100 rows. The
remaining runner reported 999 further durable deliveries per phase before
50,000 rows reached terminal status. No failed delivery or stage failure was
reported. Vitest exited 0: one test passed and
63 unrelated tests were intentionally skipped by the focused selector.

The unchanged test assertions require 50,000 committed rows, 50,000 rolled-back
rows, 100,000 ledger entries with exact SQL net zero, a fully rolled-back
execution proof, and 50,000 zero-balance accounts at ledger version 2. The
process was allowed to finish its fixture cleanup. An independent SQL query
after exit counted zero import sources, row executions, row snapshots, ledger
entries, accounts, outbox jobs and stores in that isolated database. Local
run log: `/tmp/weletic-import-full-restart-50000-20260925.log`, SHA-256
`926e851fcb2515c4be79fddec64cde8b45ec603aeb579f82a904cbf644006853`.
The full Vitest duration was 25,632.02 seconds; no production timeout or batch
size was changed for the test.

This proves a graceful OS-process handoff through persisted continuations, not
a mid-transaction crash or a deployed supervisor restart. It does not establish
provider-scale SQL behavior, authenticated merchant import execution, target
migrations, backup restoration or installation acceptance. After the
independent cleanup query, the disposable container was stopped and its
`--rm` policy removed it; a subsequent Docker inventory showed no matching
container.
