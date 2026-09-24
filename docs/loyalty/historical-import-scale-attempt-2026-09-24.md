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

## Same-day proof-reader follow-up

A local change replaced per-1,000 account and ledger-reference lookups with two
source-bounded joins inside the existing transaction. The same isolated synthetic
50,000-row committed profile passed: queueing took 9.5 seconds and one worker
delivery rolled back 50 real rows in 33.5 seconds. The preceding account-only
join profile took 46.3 seconds for 50 rows; the earlier mainline profile took
50.5 seconds for 40 rows. These runs had different fixture and machine timing,
so they show a useful bounded result, not a controlled throughput guarantee.
The final run made eight metadata ledger reads rather than 408 reference-batch
reads; account reads were also eliminated. A separate real-SQL test found a
reference-only orphan with absent source metadata. The synthetic fixture was
cleaned after the profile.

**The full-scale lifecycle remains failed/unaccepted.** The profile did not
execute 50,000 worker commits and 50,000 rollbacks, restart recovery or the final
independent reconciliation. Those unchanged gates still precede release.

## Later unchanged-assertion run after the proof-reader joins

A second isolated full-lifecycle run reached **50,000/50,000 actual commits**
through 1,001 deliveries. Rollback reached 11,970 rows in 241 successful
deliveries, then delivery 242 failed with Prisma `P2028` in `rollback_batch`.
The failure poll showed the source still `rolling_back` with 11,980 completed
rows and a failed job awaiting retry; ten rows from that delivery were durable.
The strict test assertion failed. No complete rollback, restart recovery or
final independent reconciliation was executed. The local log is
`/tmp/weletic-import-full-after-122-20260924.log` (SHA-256
`afb277e926387f7a431f34b023178366620c0af4d7fd0de7f0a28340e94a5085`).
The harness did not stamp the runner SHA; this is diagnostic rather than named
release evidence. The run overlapped heavy local verification, so it does not
isolate contention from query growth as the sole cause. It is not release
acceptance.

A quiet bounded profile against 50,000 synthetically committed rows rolled
back 50 real rows in 32.071 seconds. Across eight full-source proofs, snapshot,
execution and ledger reads consumed 7.276, 10.242 and 12.557 seconds. Its
local log is `/tmp/weletic-import-rollback-profile-after-122-20260924.log`
(SHA-256 `682befd03db1d4463b5161bed2e8b50160eea732c13167138d8a26a26c180272`).
This identifies the repeated-proof hot path; it does not prove that a quiet
50,000-row lifecycle will complete. Keep the unchanged assertions and recovery
gates for the next candidate.

The [bounded group-size investigation](historical-import-rollback-group-2026-09-24.md)
measured repeated full-source reads and tested a 50-row atomic group without
changing the timeout or proof assertions. Full-scale and recovery gates remain
open until that candidate is independently verified on a quiet host.
