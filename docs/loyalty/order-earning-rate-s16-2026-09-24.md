# S16 recorded order earning rate — implementation candidate

Status: unmerged implementation candidate. No shared schema application, installed
merchant acceptance or whole-store historical coverage is claimed.

The signed merchant analytics snapshot now includes a UTC daily series for the
share of **recorded Weletic commerce orders** with a positive purchase-points
grant at report time. Each persisted order contributes once to the denominator,
including pending or voided orders and regardless of its number of lines. The
numerator uses the single `(storeId, orderId)` earn grant and `grossPoints > 0`.
Historical backfill grants count; a later refund does not remove the original
gross amount. The series may change when a grant is repaired. It does not
measure points currently held; reversals remain in the point-activity report.

Both requested instants are inclusive. A range requires two dates and at most
366 UTC calendar days; days without recorded orders have zero counts and an
unavailable rate. The response contains exact decimal-string counts, a
half-up-rounded integer basis-point rate (`10000` = 100%), and
`coverage: recorded_orders_only`. EN/JA/VI screens display the percentage and
explain that orders absent from Weletic history are outside this report. It
does not establish Smile parity or a whole-store order earning rate.

The aggregate query uses the actor-authorized store ID inside the signed
merchant transaction, returns no shopper or order rows, and shares the existing
owner-only JSON/CSV export gate. The additive
`(storeId, occurredAt)` index is declared in Prisma and
[`20260924_loyalty_order_earning_store_date_index.sql`](../../infra/shopify-development/migrations/20260924_loyalty_order_earning_store_date_index.sql).
Its exact-target DDL and read plan require separate review before deploying the
reader. This branch has not applied it to a shared database.

Focused service/UI tests cover authorization, export equality, EN/JA/VI labels,
zero denominator, range bounds and counts above JavaScript Number precision.
An opt-in isolated MySQL test covers mixed lines counted once, midnight
boundaries, pending and refunded records, foreign-store exclusion, the selected
index, and independent denominator/numerator queries. Its disposable fixture
cleaned to zero stores, orders, lines, grants, accounts and shoppers. The full
web unit suite passed (648 files; 10,349 tests passed, six skipped), as did
TypeScript, full web lint, Prisma validation and formatting. The production web
build passed against a disposable local MySQL schema, including its 367 static
pages; the first dummy-URL attempt correctly failed when page generation could
not reach a database. Provider and installed checks remain separate gates.
