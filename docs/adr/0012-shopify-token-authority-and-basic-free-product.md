# ADR 0012: Shopify token authority and Basic free product rewards

- Date: 2026-08-28
- Status: Accepted
- Stakeholders: Hiro (PO), Codex (impl)

## Context

Weletic's Shopify integration runs across two independently deployed processes.
`packages/shopify-app` owns Shopify OAuth and persists the complete Shopify
session through the signed internal session-storage API, including the refresh
token needed for expiring offline access tokens. `apps/web` owns the loyalty
domain and provisions reward discounts, but its migrated credential resolver can
read copied session or integration tokens that do not participate in the
official Shopify Remix refresh lifecycle. Treating either copy as authoritative
can make loyalty fulfillment fail after an access token expires.

The first Weletic Loyalty rollout targets in-house brands on ordinary Shopify
Basic stores. A previous free-product implementation used a Shopify Discount
Function path, which is not a dependable baseline for those stores. A blanket
100% product discount would work more broadly but could give away an unbounded
variant value when a merchant's product pricing changes. Smile's non-Plus
product-reward model instead establishes the useful product-level behavior: the
reward is delivered as a code for eligible merchandise while Shopify continues
to own cart, checkout, tax, and inventory enforcement.

## Decision

`packages/shopify-app` is the sole production authority for Shopify Admin API
access tokens. `apps/web` obtains a current token through a signed internal GET
request scoped to an exact validated `*.myshopify.com` domain. The Shopify app
loads the offline session through `unauthenticated.admin(shop)`, allowing the
maintained Shopify Remix library to refresh an expiring token before returning
only the short-lived access-token projection. Refresh tokens never cross the
service boundary. When this authority is configured, the web process fails
closed and does not fall back to stale local session or integration tokens.

For Shopify Basic stores, a `free_product` loyalty reward is provisioned as a
native `discountCodeBasicCreate` fixed-amount code targeted to the configured
product or variant. Every active free-product reward requires a positive
`maxDiscountValue` stored in minor currency units. The amount is converted using
the store currency exponent, applies once across eligible items rather than once
per item, and retains the existing customer, minimum-order, expiry, combination,
and redemption-limit controls. The customer pays any eligible item value above
the cap. The Shopify Discount Function implementation remains dormant for a
future Shopify Plus decision and is not used by the loyalty dispatcher.

## Alternatives considered

- **Refresh Shopify tokens in `apps/web`** — Rejected because it duplicates OAuth
  secrets and refresh-token handling in the loyalty service and creates two
  credential authorities.
- **Keep using copied database or integration tokens** — Rejected for production
  because those records can be stale and cannot reliably refresh through the
  official Shopify session lifecycle.
- **Use an uncapped 100% product discount** — Rejected because the merchant's
  liability can increase silently when eligible product or variant prices
  change.
- **Require a Shopify Discount Function** — Rejected for the current rollout
  because the in-house brands use Shopify Basic and Plus-only behavior is
  explicitly deferred.

## Consequences

### Positive

- Loyalty discount provisioning uses a fresh token without copying refresh
  credentials into the Weletic core.
- Exact shop-domain binding and HMAC signing preserve the existing multi-tenant
  service boundary.
- Basic-store free-product rewards use Shopify-native discounts and inventory
  behavior without a Function deployment.
- A merchant-visible monetary cap bounds reward liability even when catalog
  prices change.
- The implementation requires no Prisma migration.

### Negative / trade-offs accepted

- Discount provisioning now depends synchronously on availability of the
  Shopify app process.
- On-demand refresh alone does not renew a dormant shop's refresh token; a
  scheduled renewal and reconnect-alert workflow is required before general
  availability.
- Both deployments must share the HMAC secret and the web deployment must know
  the Shopify app's internal base URL.
- A capped fixed discount is not literally a zero-price item when the selected
  variant costs more than the configured cap.
- The Basic path does not yet provide Plus checkout extensions or a custom
  Discount Function experience.

### Follow-ups

- Deploy both services with the same `WELETIC_SHOPIFY_SERVICE_SECRET` and set
  `SHOPIFY_APP_URL` for the core web deployment.
- Reconnect or reopen the test store's embedded app once so its offline session
  can refresh, then run an end-to-end reward-code checkout on the Basic store.
- Before general availability, schedule a renewal sweep comfortably inside
  Shopify's refresh-token lifetime and surface stores that require reconnect.
- Keep Shopify Plus-only capabilities paused until a separate product and
  architecture decision explicitly reopens them.

## References

- Hiro approval of Option A in the Weletic Loyalty staging discussion on
  2026-08-28.
- [Shopify access-token documentation](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens)
- `docs/adr/0003-customer-loyalty-bounded-context.md`
- `docs/adr/0008-shopify-app-production-security-boundary.md`
- `packages/shopify-app/app/routes/api.internal.admin-session.ts`
- `apps/web/lib/weletic/shopify/token-authority.ts`
- `apps/web/lib/weletic/loyalty/shopify-discounts.ts`
- `/Users/hironguyen/.codex/memories/project_adr_0012.md`
