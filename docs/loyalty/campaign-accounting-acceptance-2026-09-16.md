# Campaign accounting — September 16, 2026

Status: isolated database evidence, not live Shopify acceptance.

The production earning, refund, revision and merchant transaction implementations
are exercised without changes to production code, schema or API contracts.

## Named cases

| Case | Scope and independent expectations                                                                                                                                                                                      |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C01  | Delayed processing uses order time: start-inclusive and end-exclusive campaign boundaries; 100/200/200/100 points around the two boundaries.                                                                            |
| C02  | SKU-or-collection match, untouched nonmatching base points, concurrent earn/replay, captured 60/80/30 line allocation, partial and full refunds after policy edits.                                                     |
| C03  | A delayed order retains its historical 2x policy; a distinct order after deactivation earns base points without the campaign.                                                                                           |
| C04  | Both directions of historical VIP eligibility versus conflicting current tier; targeted campaign and tier multiplier intersection, partial refund conservation.                                                         |
| C05  | Fractional 1.5x allocation: 50/49/34 uncapped and 43/43/34 with a 120-point cap; nonmatching base points retained, concurrent earning and full refund replay.                                                           |
| C06  | Real workspace merchant transactions: stale revision rejection, overlap rejection, adjacent schedules, immutable running economics/targeting/schedule, cosmetic edits, concurrent same-revision edits and deactivation. |

The C04 and C05 parameterizations produce eight campaign cases in total. Existing
P01–P09 run alongside them. Account caches, ledger running balances and grant/line
conservation are checked independently using SQL and exact integer arithmetic.

C06 supplies synthetic workspace authority to the production transaction wrapper.
It does not claim HTTP authentication or signed-gateway browser acceptance. Its
concurrent writes must have exactly one winner and an expected revision/transaction
conflict; persisted state must match the winner. Cosmetic edits do not add a new
earning-policy revision, while deactivation does. Schedule-state transitions require
a refreshed merchant revision even without a stored configuration change.

## Isolation and remaining gates

Verification: 17 database tests and 87 focused campaign tests passed. Web
TypeScript, lint, formatting, Prisma validation and the web production build
passed. Independent adversarial review found no blockers. The build used only
temporary SELECT access to the empty disposable database, revoked on completion.
Existing missing-local-service and configuration warnings are not live evidence.

Tests run only against a new `weletic_loyalty_it_points_*` database on local
`127.0.0.1:3307`, with explicit database/principal checks. Orders, customers, tiers
and workspace authority are synthetic. External fetch is forbidden; no delivery
worker runs. Cleanup deletes only exact run-owned fixture identities. Independent
postflight checks all 157 schema tables for remaining rows.

Still required: named `yamaxdev` campaign editor and installed-store journeys,
real Shopify order/refund normalization, subscription/campaign intersections,
authenticated staff authorization and tenant/generation races through the gateway,
worker scheduling/recovery and deployed concurrency acceptance. Local assertions
do not close B3/B4/C2/G2 or the broader live acceptance gates.
