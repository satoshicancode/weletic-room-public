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
the cached wallet balance. No remote request was sent.

The mocked customer lock means this test does not prove concurrent checkout or
redaction ordering. It also does not cover discount use, expiry, cancellation,
refund, actual remote creation/lookup/deactivation, stored-value issuance or
worker restart. Those and the named yamaxdev journeys remain open under L02.

To reproduce, build workspace dependencies and generate Prisma, create a fresh
restricted local database/principal matching the test guard, apply
`prisma db push --schema prisma/schema`, then run the single file through
`vitest.loyalty-reward-db.config.ts` with `LOYALTY_REWARD_DATABASE_INTEGRATION=1` and
the fixture-only `DATABASE_URL`. Drop the fixture and principal after the run;
never point this test at retained or shared data.
