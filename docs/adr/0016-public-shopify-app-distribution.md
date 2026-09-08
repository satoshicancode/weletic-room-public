# ADR 0016: Public Shopify app distribution for loyalty and reviews

- Date: 2026-09-05
- Status: Accepted
- Stakeholders: Hiro (PO), Codex (impl)

## Context

Weletic has merged referral, loyalty, native text/photo reviews, and native Flow
implementation work, but its six-package development release still requires
external delivery and complete shopper journeys. The existing Shopify app uses
custom distribution, and `n0pvef-cs.myshopify.com` is on Basic. Using that store
for development does not make custom-app Flow extensions eligible there.

Hiro approved pursuing public distribution after reviewing the opportunities
for Flow, Functions, customer accounts, Forms/Messaging, POS, and Shop reviews.
This is a product/distribution direction, not evidence that those integrations
are complete or that Shopify has approved the app. The existing distribution
selection cannot be converted in place; a separate app registration is needed.

The current core resolves installations by shop, persists Shopify sessions by
session ID, and uses one configured webhook secret and token authority. It does
not establish independent namespaces for two app registrations serving the same
shop. Registering a public app must therefore not be followed by blindly pointing
its credentials at the existing development backend.

## Decision

Pursue a public Shopify app while retaining Weletic's authoritative loyalty
ledger, referral and native-review services, and Shopify-facing signed gateway.
Prioritize the existing release journeys, then public-app readiness with Flow,
Functions, and customer accounts; follow with Forms/Messaging, POS and richer
reviews, and a separate application for Shop review syndication. Existing Basic
native discounts remain supported under ADR 0012; public Functions eligibility
does not authorize replacing their financial contract.

Treat app registration, environment isolation/cutover, requested permissions,
pricing, extension publication, App Store submission, and Shop partnership as
explicit gates. This ADR approves the direction, not an infrastructure allocation,
new credential, billing plan, shared-schema change, or external deployment. The
[implementation roadmap](../loyalty/public-app-roadmap.md) records the inspected
baseline, proposed work, and decisions still needed. Preserve the current custom
app and development data until a reviewed transition has passed its gates.

## Alternatives considered

- **Keep custom distribution permanently** — Does not meet the approved goal of
  native Flow on non-Plus stores or broader merchant distribution.
- **Upgrade the current store to Plus solely for custom Flow** — Could address
  that platform limitation, but adds a store-plan cost without delivering the
  approved public-distribution direction. No upgrade is authorized.
- **Use only internal automation or customer metafields** — Useful complements,
  but not substitutes for the four native Flow trigger release journeys.
- **Change the SDK distribution flag and reuse the existing app identity** —
  Rejected because a local SDK setting cannot change Shopify's remote
  distribution selection or provide independent installation ownership.
- **Build every integration before completing referral/reviews** — Rejected
  because it postpones the already-approved release evidence and increases
  operational scope before the core replacement is proven.

## Consequences

### Positive

- Public distribution provides a path to native integrations across eligible
  non-Plus stores instead of tying the product to custom-app Plus capabilities.
- Existing transactional, financial, and privacy boundaries remain authoritative.
- Every release claim stays tied to code, isolated tests, or named live evidence.

### Negative / trade-offs accepted

- A separate app identity, installation validation, App Store review, and
  protected-customer-data review add work before broad merchant installation.
- Paid app plans need a Shopify-supported billing design; existing workspace
  Stripe billing is not assumed to satisfy public-app requirements.
- Public distribution does not remove Plus-only checkout UI restrictions or
  confer approval to syndicate reviews into Shop.
- The environment-isolation and eventual existing-store cutover design remains
  a prerequisite, not an implicit shared-database migration.

### Follow-ups

- Complete the six-package release evidence without relaxing containment.
- Confirm the isolated public-app development arrangement before registration.
- Audit least-privilege scopes, onboarding, privacy, billing, and extension
  ownership; implement and validate them in bounded reviewed PRs. Retain ADR
  0012's pre-GA scheduled offline-token renewal and reconnect-alert gate.
- Design later integration contracts before implementing Forms rewards, POS
  redemption, richer review attributes, or Shop syndication.

## References

- Hiro's approval in this task on 2026-09-05.
- [Existing release plan](../loyalty/referral-reviews-live-rollout.md).
- [ADR 0008: signed Shopify/core boundary](0008-shopify-app-production-security-boundary.md).
- [ADR 0012: token authority and Basic free-product rewards](0012-shopify-token-authority-and-basic-free-product.md).
- [ADR 0015: durable compliance](0015-durable-shopify-loyalty-compliance.md).
- [Shopify distribution methods](https://shopify.dev/docs/apps/launch/distribution/select-distribution-method).
- [Flow eligibility](https://shopify.dev/docs/apps/build/flow).
- [App billing](https://shopify.dev/docs/apps/launch/billing).
- [Protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data).
- [Shop review partnership](https://shopify.dev/docs/apps/build/metaobjects/standard-review-metaobject).
