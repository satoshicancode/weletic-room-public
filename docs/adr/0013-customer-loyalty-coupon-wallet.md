# ADR 0013: Customer loyalty coupon wallet

- Date: 2026-08-28
- Status: Accepted
- Stakeholders: Hiro (PO), Codex (impl)

## Context

Weletic already records every points redemption in the loyalty bounded context
and provisions the corresponding native discount in the exact connected Shopify
store. The customer-facing Shopify account extension, however, only presents a
newly issued coupon from temporary component state. Refreshing or reopening the
account page removes the code from view even though the redemption remains in
Weletic and the discount remains valid in Shopify.

The first rollout targets in-house brands on Shopify Basic. Smile provides the
relevant non-Plus baseline through its persistent "Your rewards" wallet: a
customer can return to issued rewards, copy a code, and understand whether a
reward is available, used, or expired. Checkout extensions and Shopify Plus-only
capabilities remain outside the rollout.

## Decision

`WeleticRewardRedemption` remains the authoritative customer coupon lifecycle.
The authenticated customer loyalty summary API will expose a tenant-scoped,
customer-scoped wallet projection derived from those records and their reward
snapshot metadata. The immutable points ledger supplies the display snapshot for
older records; rows that predate both snapshots use a neutral label rather than
the mutable current reward definition. The projection will include only
customer-safe fields and statuses, including the reward name, code, points
spent, issue time, expiry, usage time, and linked order when present.

Shopify Customer Accounts and the storefront loyalty widget will render the
same projection as persistent "Your rewards" experiences. Internal
`provisioning` and `failed` states will not reveal unusable codes. Shopify's
native discount remains the checkout enforcement mechanism; no coupon history
will be duplicated into Shopify customer metafields.

The storefront app proxy must derive customer identity exclusively from
Shopify's verified `logged_in_customer_id`; caller-supplied query parameters are
never forwarded to the signed internal customer API. New cancellations store an
immutable `cancelledAt` timestamp in existing redemption metadata. Legacy
cancellations without trustworthy metadata display no cancellation date rather
than a mutable or fabricated one.

## Alternatives considered

- **Keep the one-time success banner** — Rejected because a refresh makes an
  unused coupon inaccessible and creates avoidable support work.
- **Store the wallet in Shopify customer metafields** — Rejected because it
  duplicates mutable coupon lifecycle state, introduces synchronization races,
  and weakens Weletic's tenant-scoped source of truth.
- **Rely only on Shopify order history** — Rejected because unused rewards have
  no order and customers need to retrieve a code before checkout.
- **Wait for a Shopify Plus checkout extension** — Rejected because the initial
  in-house brands use Shopify Basic and can apply native discount codes without
  Plus.

## Consequences

### Positive

- Customers can retrieve an issued coupon after refresh or on another visit.
- Customer Accounts and the storefront widget share one lifecycle projection.
- Coupon status remains auditable against immutable points-ledger entries and
  Shopify order settlement.
- No Prisma migration or duplicated customer-metafield state is required.

### Negative / trade-offs accepted

- The customer summary response becomes larger. Valid outstanding coupons are
  intentionally uncapped so a purchased code cannot disappear; terminal and
  expired history is capped at the latest 50 records.
- Wallet bucket reads use a repeatable-read transaction and defensive ID
  deduplication so concurrent Shopify lifecycle webhooks cannot duplicate or
  temporarily hide a coupon in one response.
- Coupon visibility depends on availability of the Weletic customer API.
- Shopify Admin and Weletic can briefly disagree until webhook or recovery
  processing settles a discount's final state.

### Follow-ups

- Add the bounded wallet projection to the authenticated customer summary.
- Render available and historical rewards in both Shopify customer surfaces.
- Add regression coverage for tenant isolation, customer isolation, status
  visibility, refresh persistence, and order association.
- Keep checkout-native redemption deferred until Shopify Plus work is reopened.

## References

- Hiro approval in the Weletic Loyalty discussion on 2026-08-28.
- https://help.smile.io/en/articles/9188741-how-customers-redeem-points
- https://help.smile.io/en/articles/4036256-understand-reward-issuing
- `docs/adr/0003-customer-loyalty-bounded-context.md`
- `docs/adr/0012-shopify-token-authority-and-basic-free-product.md`
- `apps/web/prisma/schema/weletic-loyalty.prisma`
- `apps/web/lib/weletic/loyalty/customer.ts`
- `packages/shopify-app/extensions/weletic-customer-account/src/CustomerAccountLoyalty.tsx`
- `/Users/hironguyen/.codex/memories/project_adr_0013.md`
