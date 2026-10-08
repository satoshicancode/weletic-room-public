# Historical import rollback group size (candidate)

Status: isolated implementation candidate, September 25, 2026. A strict
50,000-row commit-and-rollback lifecycle passed on the candidate. Full-scale
restart recovery, provider read-plan and deployed acceptance remain open.

The rollback worker keeps one full-source reconciliation proof inside each
atomic correction transaction. With a ten-row transaction bound, a normal
50-row delivery repeats that proof five times. The proof must keep source
ownership, account/shopper identity, claimed ledger entries and global orphan
discovery; omitting any of these to improve throughput would weaken the
financial invariant.

This candidate raises the **atomic group bound from 10 to 50 rows**, matching
the existing worker-delivery cap. It retains the 30-second transaction timeout,
soft delivery time budget, source lease/revision fence and proof inside the
transaction. A late conflict aborts all earlier corrections in that group;
containment is recorded only after that transaction aborts. It introduces no
schema or provider change.

On one disposable MySQL 8.0 instance with 50,000 synthetically committed rows,
the unchanged ten-row path rolled back 50 real rows in a 32.071-second worker
delivery. The proof instrumentation recorded eight snapshot, execution and
ledger reads, consuming 7.276, 10.242 and 12.557 seconds respectively.
The 50-row candidate rolled back the same bounded 50 rows in 11.458 seconds;
it recorded four reads of each source-wide set, consuming 3.375, 4.012 and
6.109 seconds. The three non-worker proofs in each profile belong to setup and
queueing. These separate runs show the repeated-proof cost and a useful local
reduction, not a controlled throughput guarantee. Logs are local, temporary
evidence: `/tmp/weletic-import-rollback-profile-after-122-20260924.log`
(SHA-256 `682befd03db1d4463b5161bed2e8b50160eea732c13167138d8a26a26c180272`)
and `/tmp/weletic-import-rollback-profile-group50-20260924.log` (SHA-256
`65a3be69136cdccf33644afe77b75e3d3493e3eb3e2495677e273cbdeb79d8f6`).

The 13 focused batch-budget tests passed. Seven isolated real-SQL tests passed,
including a 50-row correction followed by exact replay, a conflict in row 50
that aborts the earlier 49 corrections, and rejection of 51 identifiers before
transaction entry. The bounded profile also passed with the 50-row group.
The SQL-test log is `/tmp/weletic-import-group50-containment-20260924.log`
(SHA-256 `a95de8ade06f2c53600d47565a0c91c34879438c38b634ef715edf744a52ed00`).

## Strict full-scale lifecycle on the candidate

The opt-in isolated MySQL run at source commit `09ff8052a648919042ab908120fe7cda22370efa`
passed its unchanged assertions: **50,000/50,000 actual commits** in 1,001
worker deliveries and **50,000/50,000 actual rollbacks** in 1,001 deliveries.
The final rollback delivery completed the job and marked the source rolled back.
An independent SQL aggregation checked 50,000 ledger entries and the exact
committed net, then 100,000 entries with net zero after rollback. The source
proof, execution counts and 50,000 zero-balance accounts also passed. The
test reported one pass, 62 opt-in skips and no failed delivery; it took
26,646 seconds, including both phases and cleanup. The local log is
`/tmp/weletic-import-50-full-lifecycle-20260925.log` (SHA-256
`9c0100f4260e28f08a5357667b595c620f6ab551ad37af60ac3735e689a1c2e2`).
After the test exited, a separate read-only SQL query found zero import
sources, snapshots, executions, ledger entries, accounts, shoppers, outbox
jobs and stores in the disposable database.

This is a single quiet-machine isolated run, not a provider throughput or
full-scale process-restart result. The separate 51-row real-process restart
test covers durable continuation across new worker processes at a bounded
scale. Exact-target schema, provider query plans and installed recovery still
need their own evidence.

One transaction now holds up to 50 account/ledger locks rather than ten and
may redo up to 49 earlier corrections after a late conflict. Its timeout still
fails closed. Provider-scale interruption/restart and read-plan evidence remain
gates. The group-size change and isolated lifecycle do not approve the
generated-column provenance index or any shared migration.
