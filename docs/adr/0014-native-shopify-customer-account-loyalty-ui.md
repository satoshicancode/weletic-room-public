# ADR 0014: Native Shopify customer account loyalty UI

- Date: 2026-08-29
- Status: Accepted
- Stakeholders: Hiro (PO), Codex (impl)

## Context

Weletic Loyalty exposes a persistent coupon wallet through a dedicated Shopify
Customer Account page and through inline Profile and Order status targets. The
loyalty data and coupon actions work, but the same full dashboard component is
currently mounted in every target. On the Profile page this duplicates the
entire Rewards experience above Shopify's native profile fields, creates a large
post-load layout shift, and becomes especially dense when reward names, codes,
and history entries wrap.

Shopify distinguishes full-page customer account extensions from inline block
extensions. Full pages are intended for standalone experiences such as loyalty
dashboards and use the native `s-page` container. Profile blocks should remain
lightweight and contextual. Shopify's Polaris web components own responsive
styling and merchant branding, so the correct integration point is the
component hierarchy and target-specific composition rather than custom CSS.

The initial rollout serves in-house brands on Shopify Basic. The customer needs
one complete place to inspect points, retrieve coupons, redeem rewards, and view
history, while Profile should provide only a useful entry point. We do not yet
have an order-specific loyalty contract that would justify an Order status
block.

## Decision

The dedicated `customer-account.page.render` target will be the complete
Weletic Loyalty hub. It will use `s-page` as its root, Shopify-native sections
and stacks, a narrow account-page layout, responsive coupon rows, and stable
loading and empty states that match the surrounding Orders and Profile pages.

The `customer-account.profile.block.render` target will use a separate compact
component that shows only the customer's current points, tier, available reward
count, and a link to the dedicated Rewards page. The generic
`customer-account.order-status.block.render` target will be removed until
Weletic has an order-specific points-earned or reward action contract.

## Alternatives considered

- **Dedicated Rewards page only** — Rejected because a small Profile summary is
  a useful, Shopify-supported discovery point for an in-house loyalty program.
- **Reuse the complete dashboard in Profile and Order status** — Rejected
  because inline targets have different layout and context requirements; the
  current implementation causes heavy rendering, layout shift, and content
  density that competes with Shopify's native account tasks.
- **Keep a generic compact block on Order status** — Rejected for now because it
  would not explain points earned by or actions relevant to the specific order.

## Consequences

### Positive

- Rewards, Orders, and Profile share Shopify's native hierarchy, spacing, and
  merchant-controlled branding.
- Profile remains useful without being displaced by the full loyalty dashboard.
- Long reward names, coupon codes, loading, empty, error, and disabled states can
  reflow through supported Polaris components without custom CSS.
- The full loyalty workflow remains available to Shopify Basic customers.

### Negative / trade-offs accepted

- Order status pages will not show loyalty information in this release.
- The page and Profile block require separate render compositions even though
  they share the same customer loyalty summary API.
- Merchants may need to remove a stale Order status block placement in the
  checkout and accounts editor after the extension target is retired.

### Follow-ups

- Introduce an order-specific loyalty projection before restoring an Order
  status target.
- Visually verify desktop and narrow reflow against the live Orders and Profile
  pages after every customer-account component upgrade.
- Keep storefront theme widgets theme-native; do not force the Customer Account
  layout onto Online Store theme app blocks.

## References

- Hiro approval in the Weletic Loyalty discussion on 2026-08-29.
- https://shopify.dev/docs/api/customer-account-ui-extensions/latest/targets/full-page
- https://shopify.dev/docs/api/customer-account-ui-extensions/2025-07/targets/profile-page-default
- https://shopify.dev/docs/api/customer-account-ui-extensions/latest/web-components
- `/Users/hironguyen/.codex/visualizations/2026/08/29/rewards-ui-audit/01-rewards-current.png`
- `/Users/hironguyen/.codex/visualizations/2026/08/29/rewards-ui-audit/02-orders-native.png`
- `/Users/hironguyen/.codex/visualizations/2026/08/29/rewards-ui-audit/04-profile-after-load.png`
- `packages/shopify-app/extensions/weletic-customer-account/src/CustomerAccountLoyalty.tsx`
- `/Users/hironguyen/.codex/memories/project_adr_0014.md`
