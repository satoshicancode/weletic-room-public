# Public Shopify app: readiness audit and implementation roadmap

**Historical roadmap.** The approved 12-package plan and
[unified acceptance matrix](unified-acceptance-matrix.md) supersede conflicting
scope and sequencing below. In particular, video, imports and subscriptions are
now in scope; POS, external syndication, public launch and billing remain outside
current acceptance. Keep the dated findings below as historical evidence, not
current app-registration or deployment status.

Date: 2026-09-05. Inspected source: `a65349d4dc193c5e005c73af130bc2a7b1eea7dd`
([PR #54](https://github.com/satoshicancode/weletic-room/pull/54)).
Direction approved by Hiro; see [ADR 0016](../adr/0016-public-shopify-app-distribution.md).
Scope: `weletic-room` only. This is a plan, not a public-app launch certificate.

## Outcome and order

Deliver a reliable referral, loyalty, and verified text/photo review product,
then extend it through Shopify-native integration points. The existing
[six-package release gates](referral-reviews-live-rollout.md) remain mandatory.
Public distribution resolves a product constraint; it does not replace live
delivery evidence, grant Shopify approvals, or change a store's plan.

| Phase                     | Deliverable                                                                                                                         | Exit evidence                                                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0. Readiness              | This audit, accepted direction, truthful release status, and gated implementation sequence                                          | Reviewed documentation; no runtime or platform mutation                                                                                            |
| 1. Core journeys          | Verified transactional delivery, private photo lifecycle, real referral and review journeys, bounded workers                        | Named test customers/orders, actual inbox delivery, exact ledger/refund reconciliation and privacy cleanup                                         |
| 2. Public foundation      | Isolated app setup, onboarding, permissions/privacy/billing readiness, four Flow triggers, qualified Functions and account surfaces | Fresh install/reinstall and isolation tests; real workflow/lifecycle evidence; feature-specific Basic/Plus checks; review-ready submission package |
| 3. Forms and Messaging    | Enrollment/preferences through Forms metafields and consent-aware Flow marketing workflows                                          | Idempotent enrollment/rewards; consent opt-out tests; approved real marketing delivery                                                             |
| 4. POS and richer reviews | Harden existing POS prototype; design structured review attributes and safe storefront projections                                  | Staff/customer-selection threat-model resolution, redemption/refund tests, private-data-free search/rating projections                             |
| 5. Shop syndication       | Apply for approved review-app access, then implement the accepted contract                                                          | Separate Shopify partner approval and successful eligible-review ingestion; no pre-approval claim                                                  |

Phase 2's eligibility work can unblock Flow while phase 1 evidence progresses.
Do not postpone referral/review correctness until the entire integration roadmap
is finished. Do not declare the six-package release complete before Flow passes.

## What exists, and what it does not prove

| Area                    | Inspected implementation                                                                                                                                                                       | Remaining boundary                                                                                                                                                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| App identity            | `packages/shopify-app/shopify.app.toml` identifies the existing custom app; `app/shopify.server.ts` selects SDK distribution from an environment setting                                       | SDK `AppStore` is not remote public distribution. A new registration is required; do not replace the current client ID or copy credentials into tracked files                                                                              |
| Sessions and tenancy    | `WeleticShopifyAppSession.id` is the sole primary key; `WeleticShopifyStore.shopDomain` is unique in `apps/web/prisma/schema/weletic-commerce.prisma`; the signed sessions route upserts by ID | No demonstrated app-registration namespace. `installationGeneration` fences reinstall/workers; it is not a second app identity. Do not share this data plane between old and new registrations without a reviewed isolation/cutover design |
| Runtime endpoints       | One internal HMAC authority, one configured webhook secret, and configured `shopify.weletic.com` / `app.weletic.com` origins                                                                   | Revalidate DNS, HTTPS, redirects, App Proxy, webhook origin, scheduler authentication, and app-owned extension IDs for the chosen environment                                                                                              |
| Scopes                  | TOML includes `write_app_proxy`; the runtime's fallback scope list does not. Finance code checks gift-card/store-credit permissions; backfill rejects long lookbacks without `read_all_orders` | Create one reviewed scope inventory and reconcile actual granted scopes. Do not silently widen permissions or request historical-order access while commits are disabled                                                                   |
| Financial rewards       | ADR 0012 dispatches capped free-product rewards through native Basic discounts. `weletic-free-product` contains a Function extension                                                           | The Function is not the active replacement for Basic issuance. Enable only after its reward/discount contract and refund evidence are approved                                                                                             |
| Flow                    | Four trigger manifests plus lifecycle callback and transactional outbox services are merged; development schema applied                                                                        | Current custom-app/Basic pairing is ineligible. No published-trigger or real workflow/lifecycle evidence is claimed                                                                                                                        |
| Account and checkout UI | Dedicated account page and compact Profile block exist. The checkout-slider extension also targets checkout reductions and Thank you                                                           | Account evidence is partial. Do not market the checkout reductions target as Basic-compatible; a public app does not remove checkout-step Plus restrictions                                                                                |
| POS                     | Existing tile/modal and authenticated gateway enter the redemption saga                                                                                                                        | Customer selection is caller-supplied; current capability matrix defers activation until binding/threat-model review. Prototype presence is not POS readiness                                                                              |
| Reviews                 | Native collection/moderation, review points/clawbacks, rating projections, and privacy jobs exist                                                                                              | Real fulfillment/email/photo/moderation/cleanup journey is pending. Shop review syndication has separate partner eligibility                                                                                                               |
| Billing and privacy     | Core contains workspace Stripe billing; ADR 0015 defines durable Shopify compliance                                                                                                            | No public-app billing compliance or protected-data approval is claimed. Audit install entry, merchant entitlements, charging boundaries, retention, and redacted-data behavior before submission                                           |

These are bounded source findings, not a complete security audit or proof that
every existing feature is release-ready.

## Implementation slices and contracts

Each slice receives its own tight plan and reviewed PR; do not turn this roadmap
into one schema/billing/extension megachange.

1. **Environment and identity preflight.** Touch Shopify configuration/env
   documentation and a read-only readiness validator. Reconcile app client ID,
   distribution, canonical store, public origins, scope sets, and extension
   ownership without printing secrets. Recommend a separate development app and
   isolated backend/database/queue/media namespace with disposable data. Distinct
   environment names or shop names alone are not isolation. No shared-schema
   migration is proposed in this slice. Confirm the actual arrangement before
   creating credentials or connecting it.
2. **Install and least-privilege readiness.** Inspect
   `packages/shopify-app/app/shopify.server.ts`, session storage, internal session
   and install routes, webhook provisioning, and customer-data consumers.
   Document each scope and protected field against its feature; request only the
   minimum selected feature set. Exercise denied/redacted fields, installation
   refresh, uninstall/reinstall, exact-shop ownership, and delayed old workers.
   Implement and prove ADR 0012's scheduled offline-token renewal and reconnect
   alerts within the refresh-token lifetime, including dormant installations;
   request-triggered refresh alone does not satisfy this pre-GA gate. Renewal
   must use the existing Shopify token authority and installation-generation fence.
   Preserve signed gateway and token-authority contracts. Any public onboarding
   change to the existing Weletic-first workspace connection needs its own design.
3. **Flow and eligible surfaces.** Validate the four existing immutable handles,
   new-registration extension ownership, numeric customer reference, payload
   size, HMAC lifecycle timestamps, and same-transaction enqueue. Reuse current
   outbox retry/dead-letter behavior. Run one log-only workflow per trigger plus
   enable/disable checks after approved deployment. Validate account surfaces on
   Basic; keep Plus-only checkout targets separately qualified. Future Flow
   actions such as award points or request review need their own authorization,
   idempotency, and financial contracts; they are not part of the four-trigger gate.
4. **Public submission readiness.** Prepare evidence-backed listing/support and
   privacy material, install/reinstall recordings, retention/erasure/export
   evidence, and protected-customer-data justifications. Decide free versus paid
   launch and the supported Shopify billing/entitlement design before writing
   billing code. Do not redirect public-app merchants to inherited Stripe billing
   by assumption. No pricing change or charge is authorized by this plan.
5. **Later integrations.** Forms enrollment consumes canonical customer
   metafields with separate marketing consent and one-time reward idempotency.
   Messaging remains a merchant-configured marketing path, not a generic
   transactional API. POS requires explicit staff/customer selection and failure
   recovery contracts. Rich reviews need a field schema and typed, non-PII
   projections before Search & Discovery filters. New persistence or public API
   contracts require a staged migration/compatibility plan when applicable.

## Decisions and external gates

- **Approved:** public-distribution direction and the priority order above;
  ordinary implementation PR workflow within approved contracts.
- **Next decision:** the concrete separate public-app development arrangement.
  Recommended: leave the existing custom app/store/database untouched and use an
  isolated development data plane. Confirm registration and environment setup
  before creating a new credential-bearing app. Do not infer a paid-store upgrade.
- **Later decisions:** first public feature/pricing tier, installation/onboarding
  model if changed, storefront/account placements, Forms reward semantics, POS
  customer-binding contract, richer review schema, and existing-store cutover.
- **External gates:** actual test recipient addresses and sends; app registration
  and access permissions; shared-schema changes; extension deployment; App Store
  submission/agreements; Shop partner application. Obtain the relevant explicit
  approval at each gate. No external change is executed by this documentation PR.

Shopify does not allow changing the selected distribution method in place.
Limited listing visibility is an option to decide later, not a shortcut around
review. [Distribution](https://shopify.dev/docs/apps/launch/distribution/select-distribution-method),
[listing visibility](https://shopify.dev/docs/apps/launch/distribution/visibility).

Public apps need the applicable protected-customer-data approval. Name/email use
needs field-specific justification; dev-store access is not publication approval.
New public paid plans should evaluate Shopify App Pricing; published apps must
use a Shopify-provided billing solution.
[Customer data](https://shopify.dev/docs/apps/launch/protected-customer-data),
[billing](https://shopify.dev/docs/apps/launch/billing).

## Verification and release policy

- For this documentation slice: source/path/link checks, Prettier, adversarial
  review, and existing CI gates. No database, network-delivery, or app-publication
  result is inferred from documentation checks.
- For runtime slices: formatting/lint, web and Shopify type-checks/builds,
  complete Vitest suite and relevant validators; Prisma validation for schema
  work. Exercise production services and isolated MySQL transactions for finance,
  app/session isolation, leases, outbox deduplication, and stale workers.
- For external slices: record exact app identity, named store, installed version,
  workflow/ledger/order evidence, and cleanup outcome without credentials or PII.
  Use only approved disposable fixtures, no real card charges or historical sends.
- Reconcile ledger totals independently; preserve append-only reversals and
  refund-after-repair behavior. Keep backfill commits and undefined valuation off.
- Do not uninstall Smile/Judge.me until the replacement journeys and one-writer
  cutover pass. Provider subscription cancellation is a separate action.

ESP/Klaviyo delivery, video, historical review import, production repair, and
unconfigured monetary valuation remain deferred. Shopify Inbox is not promised
as a direct connector. Bundles and subscription renewals are later order-model
compatibility work, not approval to manage another app's subscription contracts.

## Capability references

- [Flow plan/distribution eligibility](https://shopify.dev/docs/apps/build/flow).
- [Functions availability and API-specific exceptions](https://shopify.dev/docs/api/functions).
- [Checkout surface restrictions](https://help.shopify.com/en/manual/checkout-settings/customize-checkout-configurations/checkout-apps/).
- [Forms fields and metafields](https://help.shopify.com/en/manual/promoting-marketing/create-marketing/forms-app/settings/all-forms).
- [Messaging marketing automations](https://help.shopify.com/en/manual/promoting-marketing/create-marketing/shopify-messaging/marketing-automations).
- [POS extensions](https://shopify.dev/docs/apps/build/pos).
- [Search & Discovery supported filter types](https://help.shopify.com/en/manual/online-store/storefront-search/search-and-discovery-filters).
- [Standard rating metafields](https://shopify.dev/docs/apps/build/metafields/list-of-standard-definitions).
- [Shop review partner approval](https://shopify.dev/docs/apps/build/metaobjects/standard-review-metaobject).

These sources describe Shopify capabilities, not completed Weletic integrations.
