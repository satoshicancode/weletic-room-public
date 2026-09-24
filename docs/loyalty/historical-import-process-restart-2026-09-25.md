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

The concurrent 50,000-row full lifecycle uses a separate MySQL container and
fixture. Its result, independent 50,000-row reconciliation, provider read plan,
installed worker supervision and restore remain separate open gates.
