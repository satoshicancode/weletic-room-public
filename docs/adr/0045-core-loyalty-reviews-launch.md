# ADR 0045: Core loyalty and reviews launch with Shopify pricing

- Date: 2026-09-26
- Status: Accepted
- Stakeholders: Hiro (PO), Codex (impl)

## Context

The full company-store completion matrix expanded faster than deployed acceptance.
Most core purchase, wallet and product-review paths exist, while persistent hosting,
public extension identity, protected-data approval and real delivery remain open.
Hiro approved a smaller launch and explicitly chose paid access for outside merchants.

## Decision

Launch one-time purchase points, fixed-value native coupons, wallet/history,
verified text/photo product reviews, one disclosed participation-points award per
order, and four Flow triggers plus the existing bounded points adjustment action.
Start fresh without historical migration. Retain EN/JA/VI and independent modules.

Use a limited-visibility public listing with Shopify App Pricing: USD 500 monthly,
no public trial, annual or usage tier, and a private free plan for selected company
stores. Verified paying merchants receive the same launch features and basic
support. Price discourages installation; it is not an access-control mechanism.
Server-verified entitlements replace manual company approval for paid activation;
explicit suspension, tenant/staff authority and privacy fences remain authoritative.

The [core launch checklist](../loyalty/core-launch-checklist.md) supersedes conflicting
launch scope and sequencing in ADR 0040 and older matrices. Deferred capabilities
remain preserved, disabled and outside launch acceptance. Retain ADR 0034's hosting
topology; no persistence/queue rewrite. Required schema compatibility remains even
for disabled modules whose tables are read by shared privacy/delivery consumers.

## Alternatives considered

- **Full Smile/Judge.me parity before launch** — rejected because imports,
  advanced analytics, video and other expansion prolong release without proving
  the core customer journeys.
- **Free company-only public listing** — rejected by Hiro in favor of a real
  USD 500 public subscription and a private company plan.
- **Price as an installation barrier** — rejected as an authorization mechanism;
  an outside merchant who pays must receive working access.
- **Replace hosting or rebuild billing UI** — rejected; preserve the approved
  runtime and use Shopify-hosted plan selection.

## Consequences

### Positive

- A finite launch checklist prioritizes installed behavior and provider operation.
- Shopify Flow and native apps remain the integration direction.
- Existing implementations and financial history are preserved for later releases.

### Negative / trade-offs accepted

- Paid outside access requires minimal onboarding, entitlements and basic support.
- Some merged features cannot be enabled in the core release.
- Schema, provider and Shopify approvals remain necessary despite reduced scope.

### Follow-ups

- Implement server/worker/UI release restrictions and subscription persistence.
- Prepare exact resource, migration, test-send/order and publication packets.
- Validate installed core journeys, submit, then separately activate production.
- Add Forms, segments and Messaging first after launch, then referrals and VIP.

## References

- Hiro's explicit implementation approval in chat, September 26, 2026.
- [Shopify App Pricing](https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing)
- [Private plans](https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing/plans)
