# ADR 0004: Loyalty activation and balance policies

- Date: 2026-08-16
- Status: Accepted
- Stakeholders: Hiro (PO), Codex (impl)

## Context

ADR 0003 established one Shopify app with separate Partner Affiliate and
Customer Loyalty bounded contexts. Before implementation, four policies still
affected the authentication boundary, loyalty participation model, historical
data scope, and refund accounting behavior.

The current Shopify connection has separate embedded-app and Weletic workspace
trust paths. A Shopify-first install would require account discovery and
workspace selection after OAuth, while a Weletic-first flow can bind the store
to a known tenant through a signed, expiring installation intent. Existing
stores contain development-era session and credential fallbacks, so retaining
those credentials would weaken the new trust boundary.

Customer participation also has competing trade-offs. Automatic enrollment is
simple when an order contains a stable Shopify customer ID, but guest-order
claims require identity reconciliation and additional fraud controls. Starting
points only at activation minimizes liability, whereas honoring all historical
orders gives existing customers continuity but requires Shopify historical-order
access, a resumable backfill, complete refund reconciliation, and a liability
preview before activation.

Finally, customers can spend points before a late refund arrives. Capping a
refund reversal at zero is friendlier visually but causes the merchant to absorb
unrecovered reward value. Allowing a negative balance preserves an exact ledger
and lets future earnings offset the debt.

## Decision

Shopify connection will be Weletic-first. A workspace-authorized user creates a
signed, one-time, expiring installation intent; Shopify OAuth consumes it and
binds the authenticated shop to that workspace. Existing connected stores must
complete one controlled reconnect so the new encrypted persistent session is
the sole Admin API credential source.

Weletic will automatically create a Shopper and Loyalty Account when an eligible
Shopify order contains a stable customer ID. Customerless guest orders remain in
the commerce ledger but do not earn points in this phase. Weletic will perform a
full historical Shopify order and refund backfill for identified customers, not
only orders after loyalty activation. Historical import must be resumable,
idempotent, previewable, and reconciled before points become customer-visible.
This requires approved `read_all_orders` access in addition to `read_orders`.

If points from an order have already been spent when a refund is processed, the
exact reversal may make the available balance negative. Redemption is blocked
while the balance is negative, and future eligible earnings offset the debt.
The ledger never caps or silently discards a valid reversal.

## Alternatives considered

- **Shopify-first connection** — Install from Shopify, then authenticate to
  Weletic and select or create a workspace. Rejected for the initial release
  because it adds account-linking states and weakens the simplest tenant-binding
  path.
- **Explicit loyalty opt-in** — Create accounts only after the customer joins.
  Rejected because it reduces continuity for existing identified customers and
  adds consent UI that is not required for the core points ledger.
- **Claimable guest points** — Hold guest rewards and reconcile them after
  account creation. Rejected for this phase because identity matching,
  self-claim abuse, and privacy handling substantially expand scope.
- **Activation-forward accrual or a recent-window backfill** — Avoid historical
  permissions and limit opening liability. Rejected because Hiro chose full
  customer continuity across the store's order history.
- **Cap late-refund balances at zero** — Prevent customers from seeing negative
  points. Rejected because it makes the ledger economically inaccurate and
  leaves unrecovered reward value with the merchant.

## Consequences

### Positive

- Every Shopify installation has an explicit, auditable workspace owner and
  tenant binding.
- Identified existing customers receive continuity rather than starting at zero.
- Automatic enrollment avoids a separate loyalty registration funnel.
- Historical processing and live processing can share the same idempotent order,
  refund, and points contracts.
- Refund accounting remains exact even after points have been redeemed.

### Negative / trade-offs accepted

- Existing stores must reconnect once before the hardened integration can run.
- Guest customers receive no points until a future guest-claim design is
  approved.
- Full backfill requires Shopify approval for `read_all_orders`, longer-running
  jobs, pagination checkpoints, throttling, historical refund reconstruction,
  and substantially more reconciliation than activation-forward accrual.
- Historical points create an opening reward liability that must be previewed
  and accepted before publication.
- Customers can see negative balances after late refunds, requiring clear
  customer-facing explanation and support tooling.

### Follow-ups

- Implement signed installation intents, encrypted persistent Shopify sessions,
  and a controlled reconnect flow.
- Request and document the business need for Shopify `read_all_orders`; fail
  closed if the permission is not approved or granted.
- Define the historical earning-rule policy and cutoff semantics before running
  a liability-producing backfill.
- Build a dry-run backfill report with customer count, order/refund coverage,
  proposed opening points, negative-balance count, and estimated reward
  liability.
- Require an explicit merchant activation action after the preview reconciles;
  backfill calculations remain hidden until activation.
- Add negative-balance states, redemption blocking, future-earn offset behavior,
  merchant adjustment tooling, and customer-facing explanation.
- Revisit explicit opt-in and guest-point claims only through a later ADR.
- Run a protected-customer-data and retention review before production rollout.

## References

- Hiro approval of the four Phase 0-1 policy choices in the Weletic Room
  architecture discussion on 2026-08-16.
- `docs/adr/0003-customer-loyalty-bounded-context.md`
- `/Users/hironguyen/.codex/memories/project_adr_0004.md`
- `packages/shopify-app/app/shopify.server.ts`
- `apps/web/app/(ee)/api/shopify/integration/callback/route.ts`
- `apps/web/app/(ee)/api/shopify/integration/webhook/orders-paid.ts`
- https://shopify.dev/docs/apps/build/authentication-authorization/app-installation/manage-access-scopes
- https://shopify.dev/docs/api/usage/access-scopes
