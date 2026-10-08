# Subscription cadence source audit — September 25, 2026

Scope: read-only inspection of public `main` at
[`1a5055be`](https://github.com/satoshicancode/weletic-room-public/commit/1a5055be5fc91299ea3279ed9af4a85f1a666a54)
and Shopify's 2026-07 API documentation. This audit is an L03/B5–B7 release
blocker, not a change to earning, reward or referral behavior and not installed
acceptance.

## Current evidence and failure case

- [`getShopifyOrderLineContext`](../../apps/web/lib/weletic/shopify/order-context.ts)
  reads the line's selling plan and category. For a subscription it constructs
  `subscriptionSeriesKey` from selling-plan ID and variant/product ID. It does
  not read a subscription-contract ID or billing-cycle index.
- [`record-order`](../../apps/web/lib/weletic/commerce/record-order.ts)
  counts earlier locally retained orders for the same shopper and key, then
  stores that count plus one as `subscriptionSequence`.
- [`purchase-policy`](../../apps/web/lib/weletic/loyalty/purchase-policy.ts)
  treats this positive number as the first-payment or first-N boundary. Points
  earning and referral qualification both call that eligibility predicate.
  Shopify's native recurring discount fields are a separate mechanism and
  still need installed checkout and use evidence.

Two different subscription contracts for the same shopper, selling plan and
item receive the same local key. The first order on the second contract can be
classified as payment two. Missing earlier orders, late ingestion or an
incomplete local history can conversely classify a renewal as payment one.
These are consequences of the inspected key/count algorithm, not observed
yamaxdev incidents. A repeated webhook for one order is not a distinct renewal.
The existing local tests with supplied sequence numbers do not prove that the
number came from an authoritative contract.

Shopify documents an order-line [contract reference](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/LineItem)
and a [billing-cycle index](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/SubscriptionBillingCycle).
The [contract API](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/SubscriptionContract)
requires `read_own_subscription_contracts` or
`write_own_subscription_contracts`. Neither checked-in app configuration asks
for those scopes. Shopify describes contracts as owned by a subscription app;
adding a scope alone must **not** be assumed to expose another provider's
contracts. No grant, live query or provider-owned contract was tested here.

## Required disposition before activation

1. Contain locally inferred sequence values: first-payment and first-N
   points/referral eligibility must fail closed when only the selling-plan/item
   key is known. Show the unsupported state in the merchant controls and avoid
   silently promising an award for existing active policies. Preserve immutable
   historical decisions and any Shopify-native reward discount constraints.
2. Establish an authorized, per-contract and per-billing-cycle evidence source
   for the selected company-store subscription provider. Prove the access grant
   and exact line-to-contract/renewal mapping on an approved installed store.
   If Shopify's own-contract scope cannot expose that provider's contracts,
   specify a separately authenticated provider integration before re-enabling
   cadence-specific points/referral rules.
3. Test two distinct contracts sharing a selling plan and item, first and later
   payments, first-N boundary, missing/out-of-order history, mixed lines,
   webhook replay, refunds and installation replacement. Reconcile independent
   SQL with the provider's contract/billing receipts.

Until those conditions pass, L03 first-payment/first-N points and referrals
are **not accepted**. Every-payment earning and Shopify-native recurring
discounts remain separate acceptance paths; neither is certified by this
source audit. No app configuration, scope, database or live store changed.

## Read-only Yamax provider inventory — September 25

The [Yamax installed-app list](https://admin.shopify.com/store/n0pvef-cs/settings/apps)
shows **Subscriptions by Shopify**, installed July 19. Its app setup guide shows
**0 of 7 steps complete**, including creating the first subscription plan. The
[Shopify Subscriptions contracts screen](https://admin.shopify.com/store/n0pvef-cs/apps/subscriptions-remix/app/contracts)
shows its empty state: contracts will appear after a customer purchases a
subscription. This establishes an installed candidate provider but supplies no
contract ID, billing-cycle receipt or two-renewal evidence for L03. It does not
prove that no subscription exists in another provider or in Shopify history.
No plan, contract, order, setting or permission was changed during inspection.

The next L03 acceptance packet must identify the exact provider and scope,
two distinct test contracts using the same selling plan/item, their first and
later paid orders, expected first-N decisions, operation and spend limits,
refund/cancellation steps and cleanup. Do not lift the merged cadence hold or
settle held referral claims from this empty-state observation.

## Shopify Flow bridge candidate — source review, not cycle proof

Shopify Flow's [subscription billing attempt success trigger](https://help.shopify.com/en/manual/shopify-flow/reference/triggers/subscription-billing-attempt-success)
provides the billing attempt, created order and subscription contract to a
workflow. A Weletic [Flow app action](https://shopify.dev/docs/apps/build/flow/actions/endpoints)
could receive a Shopify-signed request with those IDs. This is a plausible
way to receive **provider-owned contract identity** without claiming that
Weletic's `read_own_subscription_contracts` scope grants access to Shopify
Subscriptions contracts. The action must authenticate Shopify's HMAC, verify
its own handle and bound store/installation, persist a replay key, and match
the referenced order to its normal signed order ingestion before any award.
Merchant workflow installation and a real provider event are still required.

The trigger documentation does **not** promise a billing-cycle index. The
[billing-cycle API](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/SubscriptionBillingCycle)
has `cycleIndex`, but requires own-contract access. Counting received success
actions would be unsafe: Flow retries, missing runs, late installation,
out-of-order delivery and failed/skipped cycles can all change that count.
The [Flow HTTP action](https://help.shopify.com/en/manual/shopify-flow/reference/actions/send-http-request)
has plan restrictions; use of a signed app action must be verified in the
installed workflow and must not be represented as a substitute for the
missing index. Do not enable first-payment/first-N earning or adjudicate held
referrals based on the Flow trigger alone.

The next proof step is read-only configuration validation followed by a
scoped installed test: confirm that Flow can populate an app action with the
contract, attempt and order IDs from this trigger; establish an authoritative
cycle number or an independently complete contract history; and compare it
with two distinct contracts, later renewals and the source order lines.
If the selected provider cannot expose that evidence, keep those policies
disabled and use a provider-specific authenticated integration only after its
data contract and permissions are documented. No workflow, app action or
provider permission was installed by this source review.

## Merged containment boundary

The [follow-up implementation](https://github.com/satoshicancode/weletic-room-public/pull/147)
disables new cadence-specific points/referral
promises and separates new one-time referral defaults from historical null
policies. Existing subscription orders with unverified or incomplete cycle
identity retain an open critical reconciliation issue without consuming the
unique points-grant key. Referral claims remain pending, including a mixed cart
whose one-time subtotal is below the threshold; a later order cannot turn a
held claim into a fraud rejection. These are local controls, not cycle proof.

The held original referral order has no authorized adjudication/replay route.
Clearing a hold in the database would not prove its billing cycle and could
collide with the current first-order check. Do not manually clear or settle
these holds; the provider-source and fenced adjudication work remains an L03
release blocker. No historical award is reinterpreted as one-time by the new
default.
