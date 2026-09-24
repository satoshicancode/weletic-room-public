# Historical import rollback group size (candidate)

Status: isolated implementation candidate, September 24, 2026. No 50,000-row
rollback, restart recovery or deployed provider acceptance is claimed.

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

One transaction now holds up to 50 account/ledger locks rather than ten and
may redo up to 49 earlier corrections after a late conflict. Its timeout still
fails closed. Concurrency, interruption/restart, 50,000 actual commits and
50,000 actual rollbacks, independent final reconciliation and provider read-plan
evidence remain gates. The group-size change alone does not approve the
generated-column provenance index or any shared migration.
