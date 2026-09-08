# Weletic commerce operations

## Required Shopify scopes and webhooks

The installed Shopify app needs `read_products`, `read_markets`, `read_orders`,
`read_all_orders`, and `read_translations`. Subscribe the signed webhook endpoint (`/api/shopify/integration/webhook`) to:

- `orders/paid`
- `refunds/create`
- `products/create`, `products/update`, `products/delete`
- `markets/create`, `markets/update`, `markets/delete`
- Shopify mandatory privacy and uninstall topics (`customers/data_request`, `customers/redact`, `shop/redact`, `app/uninstalled`)

Reconnect stores after changing scopes or webhook subscriptions.

## Durable loyalty compliance operations

Shopify privacy and uninstall webhooks acknowledge only after an idempotent
compliance request has been durably persisted. The worker then advances one
bounded phase at a time. A retry must resume the persisted phase/cursor; do not
manually skip a phase or edit a compliance subject.

### Customer access and redaction coverage

- `customers/data_request` writes encrypted export artifacts in deterministic
  pages of at most 100 records. In addition to identity, ledger, redemption,
  tier, referral, and order data, the export includes customer-owned
  `WeleticLoyaltyEarnGrant`, `WeleticLoyaltyOrderLineEarn`, and
  `WeleticLoyaltyBackfillPreviewItem` records.
- The earn-grant and backfill queries are scoped by the durable shopper/account
  owner and Shopify store. If no durable owner resolves, the worker advances
  without running an unscoped query.
- `customers/redact` processes at most 20 records per step. It deletes linked
  backfill preview items, scrubs customer-derived values from earn-grant
  `calculationSnapshot`/`metadata`, and scrubs order-line earn `metadata`.
- Redaction does not null account, shopper, grant, order-line, ledger, program,
  tier, or reward foreign keys needed by retained financial records. Replaying a
  completed page is safe: deletion and neutralization remain tenant-scoped and
  idempotent.

### Shop-redact loyalty ordering

The shop-redact worker must complete loyalty cleanup before catalog and
credential erasure:

1. Scrub customer-derived values from every retained earn-grant calculation
   snapshot/metadata and order-line earn metadata in bounded pages.
2. Delete backfill preview items in bounded pages, then delete the now-empty
   backfill jobs.
3. Delete executable earning rules, bonus campaigns, and referral rules, scoped
   through the store's loyalty program.
4. Neutralize retained tier definitions (name, thresholds, multipliers, perks,
   icon, color, and criteria) without deleting the tier rows.
5. Neutralize and archive retained reward definitions, including descriptions,
   Shopify price-rule IDs, targeting, combination flags, limits, and expiry
   configuration, without deleting the reward rows.
6. Neutralize program branding/metadata and surface settings, and leave the
   program disabled with `killSwitchActive = true`.

Program, tier, and reward rows are retained as privacy-safe foreign-key targets
for historical redemptions, grants, tier history, ledger, and other financial
evidence. Do not manually hard-delete them while the configured financial
retention window is active.

### Installation-generation authority

- Each accepted connect/reconnect creates a new immutable
  `installationGeneration`. The identical value must be present on
  `WeleticShopifyStore.installationGeneration` and in the installed integration
  credential document.
- Credential binding requires a verified canonical shop domain, proof of the
  current access token, and an exact generation match. Verification evidence is
  published only after re-reading the store and credential under the store row
  lock.
- Treat the digest of the decrypted access token as the credential version
  inside an installation generation. Callback and signed offline-session
  refreshes must compare their observed prior digest under the store lock; a
  conflict means another refresh won and the stale callback/session must be
  retried from the current authority rather than force-written.
- Never cache or copy a raw access token into application diagnostics. The
  canonical resolver intentionally re-reads InstalledIntegration on every use;
  production discount operations prefer the standalone Shopify token authority
  and local fallbacks must validate the exact current credential row.
- The signed `app/uninstalled` request captures the store's locked
  `installationGeneration` in its encrypted compliance subject. Freeze and
  credential cleanup compare this captured generation with the current store
  and credential; an older request after reconnect completes as
  `stale_after_reinstall` and must not erase the newer installation.
- `InstalledIntegration.updatedAt`, `shopVerifiedAt`, `receivedAt`,
  `triggeredAt`, and other timestamps are diagnostic observations, not
  installation authority. Never repair a mismatch by copying or comparing
  timestamps.
- A missing or mismatched generation is a fail-closed operator-review condition.
  Confirm the store and credential records refer to the same installation; if
  they do not, use the approved reconnect/recovery path rather than editing the
  generation in place.
- A token-digest mismatch within an otherwise matching generation is also a
  fail-closed concurrency signal. Do not repair it by copying
  `InstalledIntegration.updatedAt`, `shopVerifiedAt`, session timestamps, or a
  token from logs; restart the signed OAuth/session refresh against the current
  stored credential.

When investigating a stalled request, inspect only request type, phase, cursor,
attempt count, next retry time, and sanitized error. Compliance payloads and
export chunks are encrypted private data and must not be copied into logs or
support tickets.

## Catalog sync architecture

- An authenticated workspace owner can trigger a manual sync via `POST /api/weletic/shopify/sync`.
- Product and market webhooks queue the signed internal sync endpoint.
- Webhook bursts are automatically debounced (20-second per-workspace window in Redis) to coalesce rapid batch updates into a single full sync.
- A token-safe distributed Redis lock (`weletic:catalog-sync:<workspaceId>`, 30-minute TTL, released via Lua script) prevents overlapping full sync runs.
- The credential installation generation is required by the transaction that creates or attaches a sync run. A stale credential cannot attach work to a newer store generation; a run that becomes stale may record its own failure, but cannot mark the current store failed.
- Markets, regions, products, variants, collections, and contextual market prices are paginated with cursor support.
- Cleanup (retiring removed products, variants, or market prices) executes **only** after 100% of remote pages and market prices complete without errors.
- Inspect the most recent `WeleticShopifySyncRun` and `lastSyncError` when a catalog appears stale.

## Financial reconciliation

- An authenticated workspace owner can trigger reconciliation via `POST /api/weletic/reconciliation`.
- `GET /api/weletic/reconciliation` returns current open and resolved issues.
- `/api/cron/weletic/reconcile` is cron-authenticated and reconciles every successfully synced store. Add it to the deployment scheduler only after the production cadence is approved; daily is the recommended starting cadence.

### Shopify discount cleanup safety

For this release, discount reconciliation is report-only for every destructive
Shopify action. `autoHeal` may only disable a local `DiscountCode` after a full
scan proves that Shopify no longer has an active code. It never deactivates or
deletes a Shopify discount node or redeem code.

The reconciler snapshots eligible local Shopify `DiscountCode` rows before its
first Shopify request. A local auto-disable is an exact compare-and-swap on the
snapshot row ID, code, active state, and `updatedAt`; a code created,
reactivated, or otherwise updated during the scan is left untouched for the
next run.

An active Shopify code is classified as Weletic-managed only when the scan has
authoritative evidence for that exact code: a current local `DiscountCode` row,
or an existing durable issue that captured the exact row ID, Shopify discount
node ID, and Shopify redeem-code ID before the row disappeared. Code text alone
does not transfer ownership to a replacement remote object. A shared
`Discount.couponId` proves only parent membership; it does not prove that every
sibling redeem code was created by Weletic. Titles
containing “Dub” or “Weletic”, and the fact that a node contains one code, are
also not ownership evidence. Merchant-created or otherwise unmanaged discounts
are not cleanup candidates.

The scan paginates both top-level discount nodes and every nested redeem-code
connection. Missing `pageInfo`, a missing or repeated cursor, or any empty
continuation page (including a terminal page) aborts the run before any issue
publication, local disable, cache purge, or completion marker.

When an issue reports `requiresManualCleanup: true`:

1. Confirm the store, code, Shopify node ID, and `ownershipEvidence` against the
   current local records and Shopify Admin. Stop if any value is ambiguous.
2. For a bulk parent, target only the exact redeem code. Do not delete the
   parent node while any other code may still be valid.
3. Manually deactivate or delete the exact code in Shopify Admin using the
   merchant-authorized operational procedure.
4. Run a new full reconciliation. Only the new Shopify observation may resolve
   the durable issue; do not edit the issue row or mark it healed by hand.

`manualCleanupCount` is the number of issues in the current run that still need
this procedure. Historical title-based or parent-only issues without exact-row
ownership evidence remain open with
`cleanupMode: ownership_verification_required` while a same-text active remote
code exists, but are neither presented as verified cleanup candidates nor
included in `manualCleanupCount`. They resolve only after a full scan observes
that code text absent or inactive. No Shopify mutation is performed.

### Discrepancy Resolution Procedure

Critical reconciliation issues include:

1. `order_missing_in_shopify`: Check if the order was deleted or test data was cleaned up.
2. `order_amount_mismatch` / `refund_amount_mismatch`: Compare Shopify currency conversion against the immutable ledger.
3. `refund_missing_in_ledger`: Re-deliver the missing `refunds/create` webhook payload.
4. `commission_reversal_mismatch` / `commission_reversal_exceeds_sale`: Review applied commission rules.

To resolve: Fix the upstream source data or trigger a missing event replay, then re-run reconciliation. **Never edit historical ledger amounts in place.**

## Payouts & Settlement Verification

Payout amounts in Dub remain in the program accounting currency (`USD`). The Weletic quote stores the partner settlement currency, rate snapshot snapshot, and provider reference. Stale quotes and statements are automatically invalidated on payout amount or commission modifications.

### Manual & Bank Transfer Profile Verification Procedure

1. Navigate to Partner Payout Settings in the Workspace Admin.
2. Review the requested payout currency, bank routing/SWIFT, and account holder details.
3. Verify that the bank account name matches the partner's legal identity or registered business entity.
4. Confirm that the destination account last 4 digits (`accountLast4`) are present and accurate.
5. Enter required audit notes (`verificationNotes`) explaining the verification method.
6. Approve (`status: "verified"`). This automatically triggers re-quoting of all pending payouts for that partner.

### Provider Rail Constraints

- **Stripe Connect:** Requires USD accounting and USD settlement. Verified program-scoped Stripe profile required.
- **PayPal:** Multi-currency batching (1 batch per settlement currency). Idempotent sender batch ID (`<invoiceId>:<currency>`). If a currency batch fails, other currency batches still dispatch successfully, and failed payouts can be retried without duplicate payouts.
- **Bank Transfer / Manual:** Operations-led settlement. Partner receives itemized statement in their local currency; operations team initiates wire transfer and marks payout as completed.

## Storefront localization & theme requirements

Partner affiliate links start from the selected Shopify Market's locale-specific root URL.
The Weletic Shopify theme / headless storefront must:

1. Read `wlt_country` and `wlt_market` URL parameters upon arrival.
2. Establish the Shopify buyer market and localization context.
3. Preserve `wlt_country`, `wlt_market`, and Dub affiliate click tokens across navigation and into the Shopify Checkout session.
4. Verify EN, VI, and JA links for each launch market in a clean signed-out browser session prior to marketing campaigns.
