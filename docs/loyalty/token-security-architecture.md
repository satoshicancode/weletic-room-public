# Token Security & Storefront Authorization Architecture

**Document Version:** 2.1.0 (implementation reference; see capability matrix for validation status)

**Last Updated:** 2026-09-01
**Scope:** `packages/shopify-app/`, `apps/web/lib/weletic/shopify/service-auth.ts`, `apps/web/lib/api/rbac/permissions.ts`

The active product scope is in-house Shopify Basic, including standard-checkout reward acceptance. A Shopify POS amount/percentage gateway is built, but POS activation remains deferred until its customer-selection binding and threat model are confirmed. The custom Shopify Plus Checkout UI extension and the external partner-store service also remain deferred; compiled gateways are not activation evidence.

---

## 1. Security Boundary Topology

The Weletic Customer Loyalty platform enforces a zero-trust cryptographic boundary between public browser storefronts, Shopify App Bridge extensions, and internal database controllers.

```
+---------------------------------------------------------------------------------------------------+
|                                  SHOPIFY BROWSER / CLIENT SURFACES                                 |
+---------------------------------------------------------------------------------------------------+
             | (Theme App Proxy Request)                               | (New Customer Account Request)
             v                                                         v
+--------------------------------------------------+ +----------------------------------------------+
| Remix Proxy Route: apps.proxy.$.ts               | | Remix CA Route: api.customer-account.$.ts        |
| - authenticate.public.appProxy(request)          | | - authenticate.public.customerAccount(request)  |
| - Verifies Shopify Proxy Query Signature         | | - Validates JWT `dest` (shop) and `sub` (GID)    |
| - Extracts `logged_in_customer_id`               | | - Sanitizes Customer ID GID                     |
| - Rejects unauthenticated mutating actions (401) | | - Zero DOM PII transmission                     |
+--------------------------------------------------+ +----------------------------------------------+
                         \                                           /
                          \                                         /
                           v                                       v
+---------------------------------------------------------------------------------------------------+
|                        INTERNAL SIGNED HMAC SERVICE GATEWAY (weletic-api.server.ts)                |
| - Header: x-weletic-timestamp (Unix Epoch ms)                                                     |
| - Header: x-weletic-signature (HMAC-SHA256 of Canonical Request with WELETIC_SHOPIFY_SERVICE_SECRET)|
| - Canonical Request: `${timestamp}\n${method.toUpperCase()}\n${path}\n${body}`                    |
+---------------------------------------------------------------------------------------------------+
                                                   |
                                                   v
+---------------------------------------------------------------------------------------------------+
|                     WELETIC CORE INTERNAL CONTROLLERS (/api/internal/shopify/loyalty/*)           |
| - verifyWeleticShopifyRequest(): timing-safe HMAC equality check                                 |
| - Max Clock Skew: <= 5 minutes (300,000 ms)                                                      |
| - Max Payload Limit: <= 256 KB (262,144 bytes)                                                   |
| - Store Resolution: resolveShopifyStoreByDomain() -> Authoritative Store & Workspace Context     |
+---------------------------------------------------------------------------------------------------+
```

Shopify POS is a third authenticated client surface. It terminates at `api.pos.loyalty.ts`, where a verified POS session token proves shop and staff/POS context before the request enters the same signed internal service boundary. The customer ID is separate caller-supplied numeric input; the token does not cryptographically bind it to the current cart or customer selection.

---

## 2. Storefront Traffic Termination

### 2.1 Online Store Theme App Proxy (`packages/shopify-app/app/routes/apps.proxy.$.ts`)

- **Shopify HMAC Termination**: Calls `@shopify/shopify-app-remix` `authenticate.public.appProxy(request)`. If signature validation fails, Shopify middleware aborts immediately with HTTP 401.
- **Identity Derivation**:
  - `shop`: Derived from verified session `session.shop` or `url.searchParams.get("shop")`.
  - `customerId`: Derived strictly from Shopify-verified `url.searchParams.get("logged_in_customer_id")`.
  - **Customer Action Guard**: `customer/redeem`, `customer/referral/bind`, and `customer/activity/claim` reject unauthenticated requests ($401\text{ Unauthorized}$) if `customerId` is absent.
  - **Anonymous Friend Claim**: `referral/claim` does not trust a browser customer ID. It uses the verified shop, bounded IP/user-agent abuse signals, rate limits, and HMAC-derived friend identity before the core accepts the claim.

### 2.2 New Customer Account Session Tokens (`packages/shopify-app/app/routes/api.customer-account.$.ts`)

- **Session Token Verification**: Calls `authenticate.public.customerAccount(request)`.
- **Claim Extraction & Validation**:
  - `dest`: Verified target store URL. Sanitized via `extractShopDomain(dest)` $\to$ `domain.myshopify.com`.
  - `sub`: Verified customer GID (`gid://shopify/Customer/789123456`). Sanitized via `extractCustomerId(sub)` $\to$ numeric ID string.
  - Rejects missing claims with $401\text{ Unauthorized}$.
- **Allowed Mutations**: Redemption, referral binding, birthday capture, and customer-intent activity claims replace any caller-supplied shop/customer identity with the verified session values before internal signing.

### 2.3 Shopify POS Session Tokens (`packages/shopify-app/app/routes/api.pos.loyalty.ts`)

- Calls `authenticate.public.pos(request)`. The verified token establishes shop and staff/POS context, and the route derives the shop from its `dest` claim.
- The loader reads `customerId` from the query; the action reads `shopifyCustomerId` from the request body. Both paths only normalize this caller-supplied value to a numeric Shopify customer ID. The token and gateway do not cryptographically prove current cart state or that this customer is the active POS selection.
- The action overwrites `shop`, forwards the normalized customer ID, and pins `redemptionChannel` to `pos` before entering the canonical HMAC gateway.
- Keep POS activation deferred until the customer-selection binding and associated threat model are confirmed.
- Does not make a Shopify discount object technically POS-exclusive; channel visibility and the numeric-customer input guard are application policy, while Shopify performs native code validation.

### 2.4 Canonical HMAC Gateway (`apps/web/lib/weletic/shopify/service-auth.ts`)

1. **Secret Invariant**: `WELETIC_SHOPIFY_SERVICE_SECRET` must be $\ge 32$ characters.
2. **Canonical String Construction**:
   ```typescript
   export function createWeleticShopifyCanonicalRequest({
     timestamp,
     method,
     path,
     body,
   }: Omit<SignatureInput, "secret">) {
     return `${timestamp}\n${method.toUpperCase()}\n${path}\n${body}`;
   }
   ```
3. **Verification Constraints**:
   - `x-weletic-timestamp`: Must be a valid integer with $|\text{now} - \text{timestamp}| \le 300,000\text{ ms}$ (5 minutes).
   - `x-weletic-signature`: 64-character hexadecimal SHA-256 digest.
   - Verified via `crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))` to prevent timing attacks.
   - Max payload size strictly capped at 256 KB.

---

## 3. Merchant Admin RBAC & Owner Guards

All merchant admin loyalty routes (`/api/shopify/loyalty/admin/*`) are protected by `withWorkspace`:

```typescript
// apps/web/lib/api/rbac/permissions.ts
export const ROLE_PERMISSIONS = [
  { action: "loyalty.read", roles: ["owner", "member", "viewer", "billing"] },
  { action: "loyalty.write", roles: ["owner", "member"] },
];
```

### 3.1 Authoritative Store Derivation

- Admin routes **never** trust caller-supplied `storeId` or `shop` query parameters.
- Store context is strictly derived from the authenticated workspace:
  ```typescript
  const store = await prisma.weleticShopifyStore.findUnique({
    where: { projectId: workspace.id },
  });
  if (!store)
    throw new DubApiError({
      code: "not_found",
      message: "Shopify store not connected.",
    });
  ```

### 3.2 Owner Authorization Guard (`requiredRoles: ["owner"]`)

The following high-risk financial and program actions strictly enforce the `owner` role:

1. **Program Activation / Deactivation**: Toggling program status (`active`, `disabled`, `draft`).
2. **Emergency Kill-Switch**: Activating `killSwitchActive: true`.
3. **Manual Points Adjustments**: Calling `POST /api/shopify/loyalty/admin/adjust` or `POST /api/shopify/loyalty/admin/accounts`.
4. **Historical Backfill Execution**: Committing or cancelling backfill jobs via `POST /api/shopify/loyalty/admin/backfill`.
5. **Activity Ledger CSV Export**: Requesting full transaction history exports.

---

## 4. Zero-PII DOM Leakage Architecture

Liquid templates and storefront assets must adhere to the Zero-PII DOM standard:

- **Prohibited DOM Attributes**: `data-customer-email`, `data-customer-first-name`, `data-customer-last-name`, `data-customer-phone`.
- **Allowed Context Attributes**: `id="weletic-loyalty-root"`, `data-shop="{{ shop.permanent_domain }}"`, `data-logged-in="{% if customer %}true{% else %}false{% endif %}"`, `data-currency="{{ cart.currency.iso_code | default: shop.currency }}"`.
- All customer loyalty metrics (balance, tier progress, referral links) are fetched dynamically over authenticated App Proxy endpoints in memory without rendering cleartext PII into HTML markup.
- Discount and Gift Card codes are shopper-safe artifacts returned through authenticated customer responses (and, after its binding gate passes, POS responses). The anonymous friend-referral path may return a one-time discount through its verified-shop, rate-limited claim response and send it to the intended recipient email. Codes must not appear in logs or committed evidence. Store Credit returns no shopper code because value is attached directly to the Shopify customer balance.
