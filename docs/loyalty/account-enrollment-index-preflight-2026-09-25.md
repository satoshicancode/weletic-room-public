# Account enrollment index: isolated preflight

September 25, 2026 JST. This is a code and disposable-MySQL migration
candidate, not approval to run DDL on an acceptance or production database.

The current-account CSV and retained-enrollment series both filter by canonical
store and `enrolledAt`. The existing account indexes start with store/status or
store/ID, so a 2,001-row output cap still permits a broad store scan. The
additive `(storeId, enrolledAt)` index supports both readers without changing
their API, privacy filtering, writers, historical promises or worker phases.
It does not make the export a complete customer-history report.

On isolated MySQL 8.0.46, a clean baseline Prisma schema was loaded before the
candidate migration. A synthetic fixture held **50,000 accounts**, split
equally across two stores, with enrollment dates spread over 400 days. The
original ordered account-export candidate query used a September 2026 window
containing 1,860 rows for one store. `EXPLAIN ANALYZE` before the index read all
**25,000** accounts in that store through `storeId_id_key`, then filtered and
sorted; observed time was **43.9 ms**. After applying the checked-in SQL file,
MySQL used `WeleticLoyaltyAccount_storeId_enrolledAt_idx` for the store/date
range, reading **1,860** rows; observed time was **4.6 ms**.

An adversarial 365-day request still made MySQL choose the old store/ID index,
scan all 25,000 rows and sort before refusing an over-limit file. The candidate
read therefore now uses an unsorted `LIMIT 2001` to decide whether it can
return a complete file; the subsequent locked read still sorts returned rows.
With the final query, the narrow window scanned **1,860** rows through the new
index in **3.47 ms**. The broad request stopped after **2,206** examined rows
and 2,001 matches, using the existing store/ID index in **3.19 ms**. The
retained-enrollment monthly grouping used the new 1,860-row index range. Its
opening-count query still chose the old store/ID index and scanned 25,000
rows in **34 ms** locally. These are single observations, not a provider
benchmark or a latency SLA; opening counts and high-volume provider plans
remain release gates.

Evidence logs:

- `/tmp/weletic-enrollment-index-before.log` — SHA-256
  `a2825166e5c2b8cdc011305859c2135731fe6a1e4bbd14fbb7d317eabe42f960`
- `/tmp/weletic-enrollment-index-after.log` — SHA-256
  `6b5d1d30ee42c76185c4060c267a561cfc5645049c69f1f1d685b522e297e4f8`
- `/tmp/weletic-enrollment-series-after.log` — SHA-256
  `307fff5090703ef881e4dd770bfecd44bb962115ed8a68dfa4bcf47c59308723`
- `/tmp/weletic-enrollment-index-broad-and-opening.log` — SHA-256
  `82eaec493d902fbeb92df08976df3193fb554a8dd8e7dfd1a5e33a6f162b630a`
- `/tmp/weletic-enrollment-index-final-candidate.log` — SHA-256
  `6d4839956d5b7d42f84fbc63edff24f409aac2e26b613e775ec373025ad47473`

The account-export SQL integration suite passed **3/3** on a separate
disposable database, including the 2,001-row cap, cross-store exclusion and
an erasure race. Focused service, route, action and UI tests passed **62/62**.
The complete web suite passed **669 files, 10,482 tests** with six skipped
(`/tmp/weletic-enrollment-index-full-unit-20260925.log`, SHA-256
`16d9bf7991f4e5e4443e805e0cb72293de66f01ebdf5ff665f29515e338d8118`).
Full web lint, sequential TypeScript check and production web build passed;
the build log is `/tmp/weletic-enrollment-index-web-build-20260925.log`
(SHA-256 `24873bdee912768ba74a65c1d17b1824b5e85e79e3e53eff351d8da563addcba`).

Prisma validation passed, and a post-DDL **disposable** `prisma db push`
reported the candidate schema already in sync. Do **not** use shared
`prisma db push` as the rollout: it could apply this index and unrelated schema
drift outside the reviewed packet. The migration has not been run on any shared
target. Before application, capture exact-target table/index metadata, confirm
absence of an equivalent index, inspect the provider's DDL behavior and write
load, then approve a bounded maintenance packet with a post-DDL query plan and
containment. MySQL index creation is not transactional; a partial failure
requires forward inspection. A target-specific `DROP INDEX` is a possible
rollback only after metadata and traffic inspection, not an automatic step.
