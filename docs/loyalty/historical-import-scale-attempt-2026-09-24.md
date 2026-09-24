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

A separate bounded profile on the same disposable MySQL instance and source
revision `aaaaa2de03` passed with a synthetic 50,000-row committed evidence set.
It queued rollback in 12.7 seconds and completed one real worker delivery in
50.5 seconds, rolling back 40 rows before its soft yield. Across seven
full-source proofs, the query instrumentation recorded 350 account lookups
(29.8 seconds total), 350 ledger-reference lookups (10.7 seconds), seven
snapshot reads (7.3 seconds) and seven execution reads (9.0 seconds). Its local
log is `/tmp/weletic-import-rollback-profile-20260924.log` (SHA-256
`f988b4d4112400577953a4cbadaeb678bdfd904e35da4210360f5b91f6be225a`).
This synthetic fixture isolates a large repeated-proof cost; it does not prove
50,000 real commits or rollbacks and does not establish the sole cause of P2028.

An uncommitted 5,000-ID lookup-batch experiment on the synchronized index
branch cut account and ledger-reference calls from 350 each to 60 each in the
same bounded profile. One worker delivery still took 44.6 seconds for 30 rows;
account and reference lookups still consumed 26.1 and 11.1 seconds across six
proofs. The experiment passed the focused unit test and profile, but was
reverted because it did not remove the repeated full-source cost. Its local log
is `/tmp/weletic-import-rollback-profile-batch5000-20260924.log` (SHA-256
`4a9a26c4b19f9354dff9c41bf11557ce67900a405558d3550b358c63fbb4887b`).
Read-only counts after both profiles found zero source, snapshot, execution,
ledger, account, shopper and outbox rows on the disposable database.

Next: reduce and remeasure the repeated full-source proof cost while preserving
orphan discovery, tenant checks and coherent transaction boundaries. Then run a
fresh 50,000-commit **and** 50,000-rollback lifecycle without competing heavy
builds. Keep the original replay, restart, tenant-isolation and independent SQL
assertions.
