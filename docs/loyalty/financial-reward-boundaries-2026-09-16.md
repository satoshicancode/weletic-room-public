# Stored-value reward boundaries — September 16, 2026

Status: local implementation and verification; not live acceptance.

This is the first rewards slice in the approved staged loyalty completion batch.
It does not certify the rewards/wallet or subscription workstreams complete.

## Corrected boundaries

- A duplicate Gift Card code without one exact recoverable artifact is an
  **unknown remote outcome**, not proof that no value was issued. Keep the
  redemption provisioning and its points reserved until reconciliation. Do not
  issue an automatic compensating points credit on that response.
- Gift Card initial value and Store Credit credit/debit amounts use exact decimal
  equality. Insignificant trailing zeros are equivalent; floating-point epsilon,
  unsafe-integer rounding, malformed decimals, and reversed signs are not.
- No schema, public API, scope, retry policy, or live configuration changes.

## Verification boundary

Adapter tests call production code with synthetic GraphQL responses. They cover
duplicate lookup absence, mismatches, disabled cards, multiple matches, network,
authorization and GraphQL errors, exact adoption, and monetary comparisons in
USD, JPY and KWD. Tests include large adjacent values, subminor discrepancies,
malformed values, trailing zeros and debit/credit signs.

Saga regression evidence uses mocked persistence and transport. It cannot prove
real database concurrency, actual Shopify financial-instrument issuance, checkout
consumption, or independent balance reconciliation. Those gates remain open in
the [acceptance matrix](unified-acceptance-matrix.md).

The focused six-suite run passed **176 tests**, including 63 financial adapter
tests and 70 generic saga tests. Independent adversarial review found no blockers
and independently reran the duplicate reservation regression. This count is
local test evidence, not a count of live accepted journeys.

Web and Shopify builds, Shopify typecheck, web lint, Prisma validation and
changed-file formatting passed. The web build used temporary SELECT-only access
to an isolated empty schema; postflight found all 157 tables empty. Access was
revoked and the isolated MySQL container and Docker Desktop were stopped.

## Next rewards acceptance

Run actual reservation/issuance/replay/cancellation/expiry/settlement handlers on
an isolated MySQL fixture for fixed, incremental, percentage, shipping and product
discounts. Reconcile ledger entries, balances and uniqueness independently with
SQL. Label remote Shopify transport as mocked. Keep stored-value cancellation and
expiry protections distinct from ordinary discount-code compensation.

After separately authorized live execution, record named yamaxdev issuance,
checkout use, retries, cancellation/expiry and refund journeys for each eligible
reward type. Gift Card and Store Credit must stay visibly unavailable where
capabilities are absent. No live checkbox is closed by this document.

## Subscription dependency discovered during this batch

Current ingestion synthesizes a series from selling plan and item and infers a
payment sequence from locally recorded orders. Missing history, out-of-order
delivery, distinct contracts sharing an item and concurrent renewals invalidate
that inference. Missing order/line context must also not become proof of a
one-time purchase. These ingestion changes are not included in this reward fix.

The existing purchase-policy unit fixtures do not prove real successful-payment
ordinals. Shopify's own-subscription scopes do not grant general access to other
providers' contracts; a billing cycle index is not a count of successful payments.
See [access scopes](https://shopify.dev/docs/api/usage/access-scopes),
[billing cycles](https://shopify.dev/docs/api/admin-graphql/latest/objects/SubscriptionBillingCycle),
and [Shopify's cross-app clarification](https://community.shopify.dev/t/recommended-pattern-for-non-subscription-apps-to-detect-active-subscriptions-created-by-shopify-subscriptions/32590/2).

Before implementing an evidence bridge, decide its authoritative source and trust
contract. Do not silently add subscription-management scopes or use local counts
as acceptance evidence. A fail-closed ingestion slice can prevent unsafe awards;
full cross-provider first/first-N acceptance remains dependent on that decision.
