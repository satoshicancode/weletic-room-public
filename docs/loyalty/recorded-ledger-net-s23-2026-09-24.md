# S23 recorded-ledger net candidate — September 24, 2026

This is a **partial implementation candidate**, not accepted historical outstanding points or a release approval. It reports the exact signed sum of retained `WeleticPointsLedgerEntry.pointsDelta` before an explicitly selected interval, the net movement on each UTC calendar day within that interval, and the cumulative recorded net. The opening sum is taken before the selected instant, so a partial first day is intentional. The last day may also be partial. Both dates are required; the interval is capped at 366 UTC days.

Historical outstanding liability cannot be derived from this series. Entries before Weletic's retained history may be missing, and a store-wide signed net does not reconstruct positive per-account balances and separate account-level debt at each past instant. The screen and snapshot say `recorded_ledger_net_only` and do not label these values as liability. Current liability remains a separate, current-state calculation.

The report reads only the actor-authorized store from the signed merchant gateway, inside its existing repeatable-read transaction. The exact string values enter the strict signed snapshot; the existing CSV and JSON exports remain owner-only and installation-generation fenced. No shopper, order or discount identifiers are exposed. It reuses the S24 `(storeId, createdAt)` index, whose shared-target rollout is separately gated.

Local verification at the S23 candidate head:

- 37 focused service, contract and EN/JA/VI UI tests plus 20 adjacent analytics route/action/series tests passed. They cover exact values above JavaScript's safe integer range, missing/wide ranges, zero-filled days, malformed/duplicate aggregates, and truncated or tampered cumulative results.
- An isolated MySQL 8.0 schema ran the existing S24/S17 ledger fixture plus S23 checks. S23 opening and closing values matched separate direct SQL sums; the second store's entries were excluded; the opening query used the staged store/date index. The fixture ledger, database and principal were removed afterward. The local log is `/tmp/weletic-s23-standalone-sql-20260924.log` (SHA-256 `c1ddde8ab4e4a641b9f51942167ac2ec2150ebc9f2dfe52b5f58213519b149ff`).
- The complete web unit suite passed with the CI Shopify app ID: 651 test files, 10,378 passed and 6 skipped. Web TypeScript, repository-wide web lint, Prisma schema validation and the bounded Loyalty production web build also passed in this isolated worktree.

Still open: current-head CI, shared index deployment, named installed merchant acceptance, and the actual historical-liability report if retained source history and temporal debt reconstruction become available. No unavailable history is filled with zero.
