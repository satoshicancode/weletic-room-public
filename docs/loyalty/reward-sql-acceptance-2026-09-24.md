# Native discount SQL acceptance increment — September 24, 2026

This is local M2 evidence for the redemption saga, not installed Shopify or
release acceptance. The suite calls the production redemption saga and refund
ingestion with real Prisma transactions on a fresh, isolated MySQL 8 database.
Shopify discount transport and distributed/customer locks are mocked. The suite refuses a
database outside `127.0.0.1:3309/weletic_loyalty_it_reward_<12 hex>` with its
matching restricted principal and an explicit opt-in variable.

The original saga case passed on a disposable database after Prisma schema push. The runner
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

The mocked distributed and customer locks mean this test does not prove concurrent checkout or
redaction ordering. It also does not cover actual checkout use, cancellation,
actual remote creation/lookup/deactivation, stored-value issuance or
worker restart. Those and the named yamaxdev journeys remain open under L02.

The independent refund case creates and settles a $1 discount on a $10 order,
then runs the production refund-ingestion entry point twice with $4.50
merchandise refunds. Each event claws back 90 points from a settled 180-point
earn; webhook replay creates no additional debit. The previously used reward
stays used and receives no reward points credit. The persisted refund and line
each record $4.50; the cumulative refunded amount is $9.00 after two events,
and the order moves from `partially_refunded` to `refunded`. Independent SQL
summation still equals the cached wallet. This is a local persisted-state check; Shopify
transport, actual checkout and webhook delivery remain unproved.

The follow-up full-file run passed both SQL tests. After cleanup, independent
SQL counts found zero stores, orders, refunds, FX snapshots and ledger entries
in the disposable database; its container and credential file were removed.
Web TypeScript, lint and Prisma validation passed.

September 25 concurrency increment: a third case launches two distinct
redemptions whose individual costs exceed half the same wallet balance. The
first reservation reaches a held mocked Shopify issuance while the competing
reservation fails with insufficient points before that remote call is released.
Real MySQL transactions persist exactly one new redemption and one debit; only
one mocked remote creation occurs. Independent SQL ledger summation equals the
cached wallet after the winning issuance. The complete three-case suite passed
on a new disposable MySQL 8 schema; an independent post-test count found zero
stores, ledger entries, redemptions, orders, outbox jobs, programs and projects
before the schema and principal were dropped. The final run log is
`/tmp/weletic-reward-concurrency-20260925-final3.log` (SHA-256
`444517cbf88ecee85c6ec3aa2f7c8d7c9d276095afec908096d69268a700fa97`).
A preceding harness run surfaced an asynchronously handled test-promise
rejection; handlers were attached at launch and the final run has no unhandled
errors. This proves local database reservation serialization under the fixture's
mocked distributed lock, not actual concurrent Shopify issuance or installed
checkout acceptance.

To reproduce, build workspace dependencies and generate Prisma, create a fresh
restricted local database/principal matching the test guard, apply
`prisma db push --schema prisma/schema`, then run the single file through
`vitest.loyalty-reward-db.config.ts` with `LOYALTY_REWARD_DATABASE_INTEGRATION=1` and
the fixture-only `DATABASE_URL`. Drop the fixture and principal after the run;
never point this test at retained or shared data.
