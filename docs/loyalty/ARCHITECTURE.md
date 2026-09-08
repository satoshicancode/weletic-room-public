# Weletic Customer Loyalty architecture

**Last updated:** 2026-09-01

This architecture covers Weletic's in-house Shopify Basic scope. Native reward acceptance in standard checkout is included. A Shopify POS amount/percentage gateway and extension are built, but POS activation remains deferred until customer-selection binding and its threat model are confirmed. The custom Shopify Plus Checkout UI extension and the external partner-store service also remain deferred.

## System boundary

Loyalty is a store-scoped bounded context inside Weletic Room. A workspace owns a connected `WeleticShopifyStore`; that store owns shoppers, the loyalty program, balances, rules, tiers, rewards, referrals, backfill jobs, and asynchronous outbox jobs.

Shopper loyalty identities are deliberately separate from Dub affiliate `Partner`, `ProgramEnrollment`, `Commission`, and `Payout` records. Dub links may be reused for referral URLs, but referring shoppers do not become affiliate Partners.

```text
Shopify order/refund webhooks ─┐
                              ├─> commerce records ─> loyalty earn/refund core
Authenticated storefront ─────┤
customer-account/checkout ─────┤
Shopify POS extension ─────────┤
Merchant workspace APIs ───────┘
                                           │
                                           ├─> append-only points event ledger
                                           ├─> earn grants and line allocation
                                           ├─> tiers and referrals
                                           ├─> reward redemptions
                                           └─> durable outbox
                                                    │
                                                    ├─> holding release / inactivity expiry
                                                    ├─> tier review / metafield sync
                                                    ├─> discount / financial reward recovery
                                                    └─> birthday / referral / privacy cleanup
```

## Financial event model

`WeleticPointsLedgerEntry` is an append-only signed-delta event ledger. It is not double-entry accounting: there is one loyalty account balance projection rather than paired debit/credit accounts.

Each entry has:

- a monotonic `sequenceNumber` unique within an account;
- a store-scoped `idempotencyKey`;
- `pointsDelta`, `pendingDelta`, and `balanceAfter` snapshots;
- an event type and source reference.

`WeleticLoyaltyAccount` stores cached available/pending balances and lifetime totals. Mutations update the account and append the ledger entry in one transaction using `ledgerVersion` optimistic concurrency control. Serialization/deadlock conflicts are retried; reconciliation can detect and repair a cached available-balance drift from the ledger.

## Earn and refund lifecycle

Order earning uses the store's base-currency minor units, exact rational multipliers, and deterministic largest-remainder line allocation. A `WeleticLoyaltyEarnGrant` snapshots the selected rule/campaign/tier and its line-level source allocation.

- With no hold, the grant settles and credits the ledger in the order transaction.
- With a hold, the grant increases the pending cache and creates a scheduled `HOLDING_PERIOD_RELEASE` outbox job.
- Refunds reverse the source line allocation. Pending points are voided before settled points are debited.
- A post-redemption refund may create a negative available balance. The engine does not discard a valid source-based reversal.

## Reward lifecycle

Supported reward definitions are amount off, percentage off, free shipping, free product, Gift Card, and Store Credit. Amount and percentage rewards may target the Online Store, Shopify POS, or both channels. Redemption crosses a local MySQL/Prisma transaction and Shopify GraphQL Admin API `2026-07`, so it uses compensation rather than pretending to be atomic across systems.

Discount-code rewards use the following lifecycle:

1. validate tenant/account/reward and reserve points locally;
2. create or adopt the Shopify discount;
3. finalize the redemption as issued and schedule unused-voucher expiry;
4. restore points exactly once if a terminal provisioning failure is confirmed.

Recovery never treats a Shopify network/authentication failure as proof that a discount does not exist. Redemption use, cancellation, and expiry use conditional state transitions to prevent double refunds.

Gift Card and Store Credit rewards use a separate financial-reward saga. Both persist immutable customer, currency, amount, expiry, installation-generation, and currency-generation snapshots before remote dispatch. Gift Card issuance supports deterministic-code lookup and adoption after an uncertain response. Store Credit records a durable pre-dispatch marker and fails closed to manual reconciliation after an ambiguous outcome because Shopify does not accept a caller idempotency key. Shopper responses distinguish discount codes, Gift Card codes, and code-less Store Credit artifacts.

The Shopify POS tile/modal authenticates through the POS session-token gateway, exposes only amount or percentage rewards configured for POS or both channels, and applies the issued native discount code to the cart. The gateway derives shop and staff/POS context from the verified token, but the numeric customer ID remains caller-supplied and is not cryptographically bound to the active cart. POS activation therefore remains deferred; extension deployment alone does not prove a safe real POS cart lifecycle.

## Shopify identity boundaries

- Online Store traffic terminates at a verified Shopify App Proxy route.
- Customer Account traffic terminates at its verified session-token gateway. The Checkout session-token gateway exists, but activation of the custom Shopify Plus Checkout UI extension is deferred.
- Shopify POS traffic terminates at `authenticate.public.pos`; the gateway derives shop and staff/POS context from the verified session, while the numeric customer ID remains caller-supplied and is not cryptographically bound to the active cart.
- All gateways derive trusted shop context from Shopify. App Proxy and Customer Account gateways also derive trusted customer identity; the deferred POS gateway does not yet provide that customer-binding guarantee. Gateways forward to the Weletic core using a signed internal request.
- Direct legacy customer/checkout core routes return HTTP 410.
- Merchant APIs derive the store from the authenticated workspace and enforce loyalty RBAC/owner guards.
- Theme markup contains store/public configuration only; it does not embed shopper IDs, names, email addresses, phone numbers, birthdays, balances, or referral codes.

## VIP, referrals, and Weletic reuse

VIP supports amount-spent, points-earned, or combined milestones over rolling 12 months, calendar year, or lifetime. Tier history records upgrades/downgrades; the outbox supports scheduled maintenance and grace-period reviews.

Referral URLs reuse Dub's link platform while loyalty accounts and points remain separate from affiliate identities and cash commissions. Binding includes tenant checks and fraud signals; qualification and refund clawback are driven by commerce events.

Existing Weletic conditions can inform loyalty rule targeting, but loyalty-specific validation is required. Existing workspace RBAC, commerce ingestion, Shopify sessions, links, cron authentication, and API conventions are reused directly.

## Deployment dependencies

The core is not operational merely because the code compiles. A deployment must also provide:

- the Prisma schema and preflighted unique constraints;
- connected-store offline credentials and required Shopify scopes;
- verified webhook subscriptions;
- the signed service secret shared by the Shopify app and web app;
- either the continuous outbox worker or a reliable schedule for the cron route;
- deployed/enabled theme and Customer Account extensions; enable Shopify POS only after its customer-binding gate passes;
- monitoring for webhook failures, outbox retries/dead letters, and ledger reconciliation.
