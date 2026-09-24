# Recorded earning sources (S25)

Status: implementation candidate, September 24, 2026. This is a partial
Weletic-defined report, not a reconstruction of Smile's unknown `Total` formula
or installed acceptance.

The signed merchant analytics snapshot now groups retained positive
`EARN_ORDER`, `EARN_REFERRAL`, `EARN_BONUS` and `TIER_BONUS` ledger entries by
source within the selected inclusive instants. It reports exact decimal-string
**ledger-entry count** and **gross earned points**, ranked by points with a
deterministic source tie-break. Missing dates include all retained history.
Backfill, manual adjustments and nonpositive entries are excluded. A later
refund remains a separate ledger movement; it does not remove the original
gross earning event. The report does not claim unique customers, unique orders,
net points, pre-Weletic history or erased records. It does not infer an
unobserved reference formula.

The existing signed actor-store gateway, owner-only CSV/JSON export, installation
generation fence and EN/JA/VI merchant screen carry the new aggregate. No
customer or order rows leave the database. There is no migration or new writer.

Local evidence: 43 focused service, contract and EN/JA/VI screen tests pass,
with large exact values, duplicate/invalid aggregate rejection, store-scoped
query parameters and matched CSV/JSON. A disposable MySQL 8.0 fixture on
loopback port 3312 passed an independent row-level reconciliation of exact
event counts and gross points, inclusive partial-instants, excluded backfill /
manual / nonpositive entries, cross-store isolation and the existing
`(storeId, createdAt)` index read plan. It was not a provider-scale plan.
The focused files and full web lint pass, the complete web TypeScript check
passes with the repository's 8 GB Node heap, and Prisma schema validation
passes. The final combined head passes 50 focused VIP/earning-source contract
and EN/JA/VI screen tests and one isolated SQL test. The complete web suite
passed 654 files, 10,397 tests with 6 skipped; its local log is
`/tmp/weletic-s25-web-unit-final-20260924.log` (SHA-256
`879eb227be858f4fb8c402387562cdaa9b9aaab38bfa183df0383f75fa98f84c`).
The offline loyalty-release-profile production build passed with the existing
`WELETIC_WEB_BUILD_PROFILE=loyalty-only` and separate-validation configuration;
its local log is `/tmp/weletic-s25-web-build-loyalty-profile-20260924.log`.
An ordinary all-portal build compiled but could not prerender unrelated partner
routes without a local database. Exact-head CI and named installed merchant
acceptance remain release gates.
