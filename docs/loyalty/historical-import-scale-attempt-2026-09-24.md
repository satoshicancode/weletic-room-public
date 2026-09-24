# Historical import 50,000-row lifecycle attempt — September 24, 2026

Status: **failed rollback; no full-scale acceptance**. This was an isolated
MySQL run from the unmerged import-index worktree at `aaaaa2de03`, not a shared
provider or company-store import. The source test was invoked with the
`durable worker continuations` filter. Its local log is
`/tmp/weletic-import-full-20260924-attempt2.log` (SHA-256
`6ff118dd436a644cea554222617b999b673fbc5c02d939b6b5c5e36c61fc787e`).
That temporary log is not a durable release artifact.

The real worker reported **50,000/50,000 committed rows** and a completed
commit phase after 1,001 deliveries. Rollback advanced to **4,290/50,000**
through 109 deliveries. Delivery 110 failed in `rollback_batch` with Prisma
`P2028`; the job became `failed` with one attempt while the source remained
`rolling_back` at 4,290 rows. The strict test assertion failed. It did not
execute a complete rollback, restart-recovery proof or final independent
reconciliation. No rate or completion claim is inferred from the successful
commit phase.

The last successful rollback delivery took 62.3 seconds, versus roughly
40–46 seconds for preceding deliveries. The rollback implementation uses
30-second interactive transactions and repeated full-source proof. A local
Docker image build overlapped the failure, but the evidence does not isolate
whether contention, query growth or both caused the transaction error. Do not
raise the timeout or weaken the assertion as a substitute for diagnosis.

After test exit, a read-only query against that disposable MySQL database
returned zero source, snapshot, execution, ledger, account, shopper and outbox
rows. This checks fixture cleanup only; it does not change the failed result.

Next: profile the exact failing rollback transaction and source-proof query on
the isolated database, identify a bounded recovery-safe change, then rerun a
fresh 50,000-commit **and** 50,000-rollback lifecycle without competing heavy
builds. Keep the original replay, restart, tenant-isolation and independent SQL
assertions.
