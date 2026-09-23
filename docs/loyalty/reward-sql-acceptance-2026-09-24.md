# Native discount SQL acceptance increment — September 24, 2026

This is local M2 evidence for the redemption saga, not installed Shopify or
release acceptance. The test calls the production saga with real Prisma
transactions on a fresh, isolated MySQL 8 database. Only Shopify discount
transport and the customer settlement lock are mocked. The test refuses a
database outside `127.0.0.1:3307/weletic_loyalty_it_reward_<12 hex>` with its
matching restricted principal and an explicit opt-in variable.

One end-to-end test passed on a disposable database after Prisma schema push. The runner
removed the fixture database and principal and verified the retained development
ledger count stayed at 16 before and after. The test covers fixed and incremental
amount, percentage, shipping and product discount issuance; identical-request
replay; persisted provisioning snapshots; one debit and recovery job per issued
redemption, including a three-step incremental redemption and its provider
amount; a transport response lost after the remote request; terminal Shopify
rejection; one-time compensation; and independent SQL `SUM(pointsDelta)` versus
the cached wallet balance. A follow-up case in the same isolated fixture exposed
an expiry ordering defect: failed remote deactivation previously refunded points
and marked the local voucher expired. The worker now verifies the exact owned
remote code and confirms deactivation before refunding. The test proves a failed
ownership check or deactivation retains the debit and `issued` state, a successful retry expires and
refunds once, and repeated recovery does not refund again. Shopify transport
remains mocked; no remote request was sent.

The same isolated fixture now settles all five issued discount variants against
distinct synthetic order identifiers. The formerly expired voucher is reported used
late: its prior refund is offset by exactly one adjustment debit, while the
other four uses do not change wallet points. Replayed settlement adds no ledger
entry, and an independent SQL sum still equals the cached wallet. This proves
the local order-settlement transition and late-use accounting, not that any
Shopify checkout accepted these discounts or that refunds reached this path.

The mocked customer lock means this test does not prove concurrent checkout or
redaction ordering. It also does not cover actual checkout use, cancellation, order
refund, actual remote creation/lookup/deactivation, stored-value issuance or
worker restart. Those and the named yamaxdev journeys remain open under L02.

To reproduce, build workspace dependencies and generate Prisma, create a fresh
restricted local database/principal matching the test guard, apply
`prisma db push --schema prisma/schema`, then run the single file through
`vitest.loyalty-reward-db.config.ts` with `LOYALTY_REWARD_DATABASE_INTEGRATION=1` and
the fixture-only `DATABASE_URL`. Drop the fixture and principal after the run;
never point this test at retained or shared data.
