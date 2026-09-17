# Paid-order regression fixes — September 18, 2026

Scope: address the two blockers found by the bounded yamaxdev test. No schema,
public API, authentication, delivery-provider or installation changes. No new
Shopify orders, replay of refunded fixtures, ledger repair or deployment.

## Discount evidence

The parsed webhook previously dropped native `discount_allocations`. Commerce
then read `total_discount_set`, which was zero for the observed native discount.
Shopify recommends allocation evidence for line discount amounts; each allocation
contains shop and presentment amounts. See the official
[Order field reference](https://shopify.dev/docs/api/admin-rest/latest/resources/order).
This is documentation of the webhook payload, not a new REST API client.

The parser now retains selected allocation fields, discount application identity
and shipping allocations. The recorder sums line allocations with exact integer
minor units, separately per currency. Explicit empty allocations mean zero;
legacy totals remain a compatibility fallback only when allocations are absent.
The two sources are never added together. Negative, fractional-minor-unit,
wrong-currency and above-gross amounts fail closed.

Retaining the selected application/shipping evidence also lets coupon-use
settlement inspect actual allocations after repeated parsing. Unknown fields are
still stripped. Existing order and line financial snapshots are not rewritten.

## Optional affiliate queue

Company bootstrap creates an internal program even for loyalty-only use. Program
existence is therefore not an affiliate enablement signal. The missing-pixel
branch now checks for a workspace-owned link before waiting in QStash. With no
links, it acknowledges the already-recorded commerce/loyalty result without
caching the order or publishing an unnecessary attribution job.

This is not a global affiliate disable switch. Existing-customer, program-code
and known-click paths remain ahead of the check. Any workspace-owned link keeps
the queue path enabled; queue errors still propagate for retry. The check does
not bypass admission, privacy, generation or settlement locks.

## Verification scope

- Production recorder tests use mocked database delegates to assert new stored
  shop/presentment/accounting/commissionable net of 900 from gross 1,000 and
  allocation 100, despite legacy discount zero.
- Duplicate and later-attribution tests preserve captured financial columns.
  The latter has no commission rule and does not prove commission issuance.
- Calculator tests cover native and legacy input, multiple allocations/lines,
  JPY and USD, currency separation and malformed evidence.
- Paid-order handler tests cover no-link acknowledgment, configured queue/error
  preservation, customer/click/code precedence, shipping coupon evidence and
  generation rejection. Transports and persistence are mocked.

Local web and Shopify type-checks, focused ESLint, Prettier and Prisma validation
passed. Both the Shopify app build and the credential-isolated loyalty-profile
web production build passed (353 generated pages). Type and lint validation ran
separately from the web build. Independent adversarial review found no blockers.
The full local web unit run passed 514 files: 8,393 tests passed and 6 were skipped.
The final focused run passed 101 tests across seven files. Skipped cases are not
claimed as accepted, and neither run replaces live SQL/Shopify acceptance.

## Still required before a live pass

The already-refunded yamaxdev order retains its original blocked earn and
reconciliation issue. Do not claim that deploying this change repairs it.
Historical repair needs a reviewed, order-scoped procedure that accounts for its
refunds and immutable evidence. Any further test orders require a fresh bounded
authorization; the previous two-order allowance is exhausted. Verify corrected
native discount earning, terminal webhook states, partial/full reversals and SQL
reconciliation on an authorized fixture before marking the live journey passed.
