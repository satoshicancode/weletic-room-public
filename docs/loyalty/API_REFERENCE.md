# Weletic Customer Loyalty API reference

**Last updated:** 2026-09-01

The loyalty core is not a public customer API. A Shopify gateway must authenticate the client request, establish its trusted shop/session context, and forward a signed request to Weletic. App Proxy and Customer Account gateways derive trusted customer identity from Shopify; the POS customer-binding limitation is documented below. Clients must never send a trusted `storeId` or `shopifyCustomerId` directly to the core.

This reference covers the in-house Shopify Basic surfaces, including standard-checkout reward acceptance, plus the built Shopify POS gateway. POS activation remains deferred until its customer-selection binding and threat model are confirmed. The custom Shopify Plus Checkout UI extension and the external partner-store service also remain deferred.

## Shopify-facing gateways

These routes live in `packages/shopify-app`.

### Online Store App Proxy

Route: `apps.proxy.$.ts`

- `GET program`
- `GET customer`
- `POST customer/redeem`
- `POST customer/referral/bind`
- `POST customer/activity/claim`
- `POST referral/claim`

The route calls `authenticate.public.appProxy`. Customer redemption, referral binding, and activity claims require Shopify's verified `logged_in_customer_id`. Anonymous friend referral claims use the verified shop plus bounded abuse signals and do not accept a trusted customer identity from the browser. The gateway replaces any caller-provided shop/customer identity with verified values before signing the internal request.

### New Customer Accounts

Route: `api.customer-account.$.ts`

- `GET program`
- `GET customer`
- `POST customer/redeem`
- `POST customer/referral/bind`
- `POST customer/birthday`
- `POST customer/activity/claim`

The route calls `authenticate.public.customerAccount` and derives the shop and customer ID from the verified `dest` and `sub` claims.

### Shopify Plus Checkout UI extension — deferred

Route: `api.checkout.$.ts`

- `GET loyalty/customer`
- `POST loyalty/checkout/reserve`
- `POST loyalty/checkout/release`

The route calls `authenticate.public.checkout`. Reserve/release bodies contain reward and reservation inputs only; shop and customer identity come from the verified session token.

The gateway compiles, but activation is deferred for the current in-house Shopify Basic scope. This does not defer native reward-code or financial-value acceptance in standard Shopify Basic checkout.

### Shopify POS

Route: `api.pos.loyalty.ts`

- `GET /api/pos/loyalty`
- `POST /api/pos/loyalty`

The gateway verifies `authenticate.public.pos`; the signed POS session token proves the shop and staff/POS context, and the route derives the shop from its verified `dest`. Customer identity has a weaker boundary: `GET` accepts `customerId` from the query and `POST` accepts `shopifyCustomerId` from the body, then only normalizes that caller-supplied value to a numeric Shopify customer ID. The gateway therefore does not cryptographically prove that this customer is selected on the current POS cart. Before internal signing, the redemption path overwrites `shop`, uses the normalized customer ID, and pins `redemptionChannel` to `pos`. The POS extension exposes only amount and percentage rewards configured for POS or both channels, but POS activation remains deferred until the customer-selection binding and its threat model are confirmed.

## Signed internal routes

These routes live under `apps/web/app/api/internal/shopify/loyalty` and accept only requests signed with `WELETIC_SHOPIFY_SERVICE_SECRET`:

- `GET /api/internal/shopify/loyalty/program`
- `GET /api/internal/shopify/loyalty/customer`
- `POST /api/internal/shopify/loyalty/customer/redeem`
- `POST /api/internal/shopify/loyalty/customer/referral/bind`
- `POST /api/internal/shopify/loyalty/customer/birthday`
- `POST /api/internal/shopify/loyalty/customer/activity/claim`
- `POST /api/internal/shopify/loyalty/referral/claim`
- `POST /api/internal/shopify/loyalty/checkout/reserve`
- `POST /api/internal/shopify/loyalty/checkout/release`

The signature covers timestamp, HTTP method, exact path/query, and raw body. Requests outside the five-minute clock-skew window or 256 KiB body limit fail closed.

## Retired direct customer routes

The legacy routes under `/api/shopify/loyalty/customer*` and `/api/shopify/loyalty/checkout/*` return HTTP 410. They are intentionally disabled because query/body customer IDs are not proof of Shopify customer identity.

Redemption responses expose `artifactKind` and a shopper-safe `artifactCode`. Discount and Gift Card artifacts return a code; Store Credit returns `artifactCode=null` because value is added directly to the customer's Shopify balance. `discountCode` remains a transitional compatibility alias and must not be rendered unless `artifactKind=discount_code`.

## Merchant admin routes

Routes under `/api/shopify/loyalty/admin` use `withWorkspace` and derive the connected store from the authenticated workspace. The caller does not choose another tenant by passing `storeId`.

| Route                 | Operations             | Purpose                                                                                                                            |
| --------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `settings`            | GET, POST              | Program status, earn rate, holding period, expiry, surfaces, VIP policy, and kill switch                                           |
| `branding`            | GET, POST              | Storefront presentation settings                                                                                                   |
| `earn-rules`          | GET, POST, DELETE      | Order earning rules and conditions; POST handles create and update                                                                 |
| `campaigns`           | GET, POST, DELETE      | Time-bounded order multipliers; POST handles create and update                                                                     |
| `tiers`               | GET, POST, PUT, DELETE | VIP tier definitions                                                                                                               |
| `rewards`             | GET, POST, PUT, DELETE | Reward catalog and cancellation behavior                                                                                           |
| `referrals`           | GET, POST, PATCH       | Referral settings, records, and fraud-review state                                                                                 |
| `review-integrations` | GET, POST              | Encrypted review-provider configuration and connection status                                                                      |
| `accounts`            | GET, POST              | Shopper account lookup and owner-guarded financial action                                                                          |
| `adjust`              | POST                   | Owner-guarded idempotent points adjustment                                                                                         |
| `activity`            | GET                    | Ledger/activity query and export                                                                                                   |
| `analytics`           | GET                    | Store-scoped program metrics                                                                                                       |
| `backfill`            | GET, POST              | Immutable per-order preview and cancellation; owner-authorized commit currently returns 503 until the backfill release gate passes |

Use the route Zod schemas as the source of truth for request/response shapes; this document intentionally avoids examples containing shopper PII or stale field names.

## Background operation

- `GET|POST /api/cron/weletic/loyalty/outbox` runs an authenticated batch through the existing `withCron` boundary.
- `pnpm --filter web loyalty:outbox-worker` runs the long-lived polling worker.
- Shopify commerce and discount webhooks drive earning, refund, referral, and redemption-use transitions.

## Response serialization

Customer and internal responses pass BigInt monetary/points values through the loyalty serializer. Callers should treat serialized point and minor-unit values as decimal strings when a value may exceed JavaScript's safe integer range.
