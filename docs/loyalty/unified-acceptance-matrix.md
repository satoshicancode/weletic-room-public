# Unified loyalty and reviews — acceptance matrix

Reviewed 2026-09-07 (Asia/Tokyo). This is the execution checklist for the
[approved 12-package baseline and payment addendum](https://www.notion.so/3d2e26097bfd81c0a667ce21978d4fdc).
Later chat approvals resumed implementation; historical pause statements and
the earlier six-package scope do not narrow the approved outcome. External
action and shared-infrastructure approval gates still apply.

**Overall acceptance: incomplete. No package is certified complete by this matrix.**
Code presence, passing tests, and historical competitor-store evidence are not
substitutes for the agreed merchant/customer journeys on `yamaxdev`.

## Execution priority — 2026-09-08

Hiro requested completion of the participation integration and PR #78 audited
moderation, followed by loyalty implementation. All other reviews features are
deferred, not removed from the product scope. Preserve the paid Smile reference
on `n0pvef-cs`; capture available controls without configuration or subscription
changes. Trial urgency does not waive financial, schema or live-release gates.

After those two PRs, prioritize complete merchant rewards/VIP/referral/campaign
configuration and subscription contracts, customer earning/redemption/referral
journeys, acquisition precedence, loyalty communications, imports/backfill and
exact analytics, then Flow and live `yamaxdev` acceptance. Shared settings,
identity and privacy work remains in scope where required for loyalty. Do not
start new review collection, media, Q&A, translation or activation work.

Main at the start of this priority change is `95fd5e105b` (PR #82). The older
snapshot below is retained historical evidence, not the current merge status.

Priority checkpoint: audited moderation [#78](https://github.com/satoshicancode/weletic-room/pull/78)
merged as `6b4e17d3df`; participation [#83](https://github.com/satoshicancode/weletic-room/pull/83)
merged as `b7c7929ff8`. Both post-merge quality runs passed. These are code merges,
not review activation or live shopper acceptance. Further reviews remain paused.
The loyalty-only [shared reward catalog](reward-catalog-implementation.md) records
local implementation evidence and outstanding release/live gates. The
[dated Smile capture](benchmark-smile-2026-09-08.md) preserves additional paid UI
observations, not blanket feature parity or a verified billing deadline.

The [shared referral configuration](referral-configuration-implementation.md)
adds one exact-input editor and fenced write service for both merchant surfaces.
It does not close referral operations, prospective policy snapshots, subscriptions
or live acceptance gates.

## Scope, ownership and evidence

- `yamaxdev` is the implementation/acceptance environment. Its free Smile and
  Judge.me installations are not full paid-feature references.
- `n0pvef-cs` is the paid-trial competitor reference. Preserve its apps,
  subscriptions, configuration and data; do not use it for Weletic cutover or
  payment acceptance without separate approval.
- Resolve the immutable shop ID and canonical domain before using the retained
  `montdev` mapping. An admin alias is not proof of backend identity.
- Retain one store-scoped shopper, wallet/reward fulfillment, referral program,
  communications foundation and order-revenue foundation. Affiliate identity and
  optional affiliate management remain separate. Do not combine overlapping
  attributed revenue or reuse Partner enrollment/group semantics for shoppers.
- POS, Plus-only checkout, AI generation, Klaviyo/external marketing-ESP integrations, external
  syndication, automatic translation, external-merchant launch, pricing and
  billing remain excluded. Manual translations, video, imports, Q&A, store
  reviews, subscriptions and the additional Flow integrations are **in scope**.

Evidence classes used below:

| Class                  | What it can prove                                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Source inspected       | A named contract or implementation exists; no execution claim.                                                       |
| Local service/DB proof | The recorded production service and transaction boundary passed with controlled dependencies.                        |
| Browser proof          | The named rendered surface/journey passed in the stated runtime; mocked HTTP is identified separately.               |
| Live proof             | Named store, app/version, actual provider operation, observed outcome and cleanup are recorded.                      |
| Platform-gated         | An explicitly excluded operation remains outside acceptance on this store, not a failed or completed implementation. |

Snapshot: local `main` is `3a78127faa` (merged points PR #70). Its automatic and
all-area quality gates and full release gate passed, including 148 browser/API
tests. PR #68's schema foundation merged after explicit confirmation; its
post-merge run `34052430831` passed. These are code merges only: shopper-reward
schema rollout and activation remain disabled.
Shared merchant settings
merged in PR #66 (`09355611fd`) after explicit schema-merge approval; shopper
segments merged in PR #67 after approval to use all-area Shopify CI coverage for
the automatic path-filter skip. The combined code passed all-area run
`34044056163` (4,349 web tests, six existing skips, 10 Shopify Function tests) and
full release run `34044057866` (148 browser/API tests). Post-merge Fast Quality
Gate `34045046623` passed. Settings schema remains staged only in isolated local
MySQL; no shared migration or app deployment was performed. These replace the
earlier pending-merge statuses, not live acceptance. Recheck GitHub/current trees
before relying on this snapshot. None identifies an installed `yamaxdev` version.

## Package 1 — baseline and isolated environment

**Partial local proof; live acceptance outstanding.**

Existing evidence: [local services](development-environment/local-services.md),
[scrubbed runtime](development-environment/runtime.md),
[session coordination](development-environment/session-coordination.md), and
[renewal/incident proof](development-environment/session-renewal.md). The latter
records 23 isolated MySQL tests, controlled provider responses, actual local
merchant alert rendering, and a disabled-by-default worker. The onboarding test
repair proves per-attempt users and billing ownership, not Shopify installation.

- [ ] Complete the dated competitor comparison with observed behavior/source
      dates; carry forward only the specific historical observations in the
      [older capability inventory](capability-matrix.md). The
      [2026-09-06 benchmark checkpoint](benchmark-observations-2026-09-06.md)
      records selected points/referral/VIP, scheduling/coupon, moderation/form,
      Q&A/grouping, language and message-template controls, not the full inventory
      or executed competitor behavior.
- [ ] Verify canonical shop identity, reviewed app-specific extension ownership,
      granted scopes/protected fields, and public endpoint alignment.
- [ ] Prove authenticated install/reinstall, credential renewal/recovery,
      webhook and worker round trips with no cross-environment writes.
- [ ] Validate renewal timing/capacity and execution-failure visibility before
      scheduler activation, including non-expiring credential migration and
      definitive provider-rejection cases. Preserve the benchmark environment.

## Package 2 — shared settings and customer infrastructure

**Existing partial foundation; unified contract not accepted.**

Source anchors: [shopper/program schema](../../apps/web/prisma/schema/weletic-loyalty.prisma),
[loyalty branding](../../apps/web/lib/weletic/loyalty/branding.ts),
[Shopify segment adapter](../../apps/web/lib/weletic/shopify/customer-segments.ts),
[shopper privacy](../../apps/web/lib/weletic/loyalty/shopper-privacy.ts), and
[review privacy](../../apps/web/lib/weletic/reviews/privacy.ts). A shopper locale,
marketing boolean or cached Shopify segment list is not the full shared product.

The [shared shopper profile checkpoint](./shopper-profile-foundation.md) adds a
private, store-scoped directory and existing-history projection with a Weletic
merchant consumer. Local MySQL, component and controlled authenticated-browser
proofs are documented separately from live `yamaxdev` acceptance. Full consent,
communications and direct review coupons remain incomplete. The merged
[module lifecycle foundation](./module-lifecycle-foundation.md) separates shared
shopper ingestion from explicit loyalty enrollment. The merged
[shared merchant settings foundation](./shared-merchant-settings-foundation.md)
adds branding, locale, a stored-only timezone, an email pause and independent
module controls; its schema merge was approved, but shared rollout and live
acceptance remain outstanding. [Shopper segments](./shopper-segments.md) also
merged; they are dynamic fact filters, not saved audiences or campaign enrollment.

- [ ] Shared merchant branding, locale, communication preferences and independent
      loyalty/review module switches that preserve balances and published content.
- [ ] One profile spanning purchases, points, tier, referrals, reviews, coupons
      and communication history; commerce/loyalty-based shopper segments.
- [ ] Export, erasure, retention and suppression for every new record/projection.

## Package 3 — incentives and acquisition decisions

**Prospective submission integration locally proven; activation and live proof open.**

The inspected [native review service](../../apps/web/lib/weletic/reviews/service.ts)
retains `applyPublishedReviewReward` on publication and `reverseReviewPoints` when
an awarded legacy review becomes hidden/rejected. Its legacy award identity is per review.
This is the historical contract, **not** the newly approved participation-based,
one-incentive-per-order contract. A one-star publication test does not close this
gap. Do not activate this legacy behavior as the unified review incentive policy.

The [shopper reward ownership working checkpoint](./shopper-reward-ownership.md)
contains the account-independent fulfillment expansion, immutable policy drafts,
and a gated order-wide claim service. Thirty-six isolated MySQL tests cover real
claim/coupon/job transactions, concurrent worker fencing, outbox dispatch and
ambiguous-create recovery, with controlled Shopify responses. Trusted
participation validation in that foundational checkpoint was fixture-seeded; no real remote benefit was
issued. Direct coupons initially had internal reservation/provisioning support, but no
submission caller or public policy activation writer. Privacy, fraud, settlement
and full operational recovery remain open. This foundation merged in PR #68 but
is not enabled and does not close the incentive or acquisition gates below.

The merged [incentive privacy continuation](./review-incentive-privacy.md) adds
owned-claim/promise exports, participation scrubbing, bounded purge prerequisites,
and shopper-only voucher enumeration/cleanup through the shared dispatcher.
Sixty-one isolated MySQL cases cover these local services, including the real
credential resolver, prepare/cleanup and stale-lease interleavings, generation
fences, accountless erasure and late used-benefit preservation. Provider coupon
responses remain controlled fixtures. Complete privacy lifecycle acceptance
remains open. PR #69 merged as `c5e45a34b0` after exact-head fast/all-area checks
and full release CI, including 148 Playwright tests. Incentives remain disabled.

The gated [points fulfillment increment](./review-incentive-points.md) adds one
exact shared-ledger award for an existing active loyalty account, or retains the
immutable claim pending enrollment. Claim, review marker, balance and downstream
events commit atomically. Seventy-one isolated MySQL cases include competing
claims, retry, photo bonuses, large integers, rollback and damaged-evidence
rejection. Trusted validation in that increment was fixture-seeded; no public caller, enrollment
or activation was introduced. PR #70 merged as `3a78127faa` after exact-head
fast/all-area and full release CI, including 148 Playwright tests. Live acceptance
remains open.

The merged [confirmed-invalidation correction](./review-incentive-reversal.md)
appends one exact reversal for a fulfilled points claim and removes its invalid
contribution from lifetime-earned/VIP qualification. Eighty isolated MySQL cases
cover the cumulative services, including actual tier evaluation, negative-balance
correction, audit/cache agreement and original-cycle matching. Decision evidence
is fixture-supplied; no adjudication route or automatic trigger is activated.
Unpaid-claim invalidation, coupon recovery and live acceptance remain open.
PR #71 merged as `1cbe501544` after exact-head fast/all-area and full release
CI, including 148 Playwright tests. Its post-merge fast gate also passed.

The merged [shopper coupon-use increment](./shopper-coupon-use.md) wires
order-specific, immutable usage facts into paid-order settlement and owned
exports. It preserves exact costs or explicit unavailable reasons without
points enrollment/debt. Local tests exercise production transactions with
controlled Shopify responses. Bounded coupon-use retention follows the saved
shop-erasure deadline and verified provider cleanup, with durable audit progress
and blocked-fact isolation. PR #72 merged as `4f14c229ee` after approved schema
merge and successful exact-head fast/all-area and full release CI, including
148 Playwright tests. Shared-schema rollout and live acceptance remain open.

The local [confirmed-invalidity recovery increment](./review-incentive-recovery.md)
adds durable decisions for unpaid points, exact existing points reversals and
shared-worker coupon recovery. Observed used-coupon cost remains exact or
explicitly unavailable; privacy exports and content purge preserve financial
evidence. It has passed 120 isolated MySQL tests, not live acceptance. Final
verification, schema merge/rollout, adjudication activation and broader recovery
and financial-retention completion remain open.

The [participation submission integration](./review-participation-submission.md)
connects policy-tagged invitation submission to server-derived validation and the
order-wide points/coupon transaction. All 143 isolated MySQL cases passed,
including actual low-rating submissions, competing reviews, token replay,
pre-commit rollback, owned photo fixtures, privacy suppression (including legacy
invitation preview/submission/upload preflight) and delayed
enrollment/refund. Merchant points retry no longer requires publication for
validated participation promises. This is local service evidence, not inbox,
upload or Shopify acceptance. Final release checks, automatic enrollment recovery,
merchant policy configuration/activation and broader abuse controls remain open.
Existing unversioned invitations retain their historical policy.

- [ ] Direct shopper-bound coupons through shared fulfillment, with zero points
      spent and no manufactured points credit/debit pair.
- [ ] Immutable policy revision and durable `(storeId, orderId)` review claim
      shared by product/store reviews; points **or** coupon, including configured
      photo/video bonuses in the single snapshotted award.
- [ ] The first qualifying review receives the single promised award after
      purchase/abuse validation, regardless of rating/publication;
      hiding genuine criticism must not reverse its incentive.
- [ ] Confirmed fraud/invalidity: exact append-only points reversal or unused
      coupon deactivation; record used-coupon cost without invented shopper debt.
- [ ] Persist the shopper-referral versus affiliate winner at paid settlement;
      retain losing attribution but suppress its commission. Race/refund tests
      must invoke real transactions. Preserve historical financial rows.

## Package 4 — loyalty, referrals and subscriptions

**Substantial existing core; full behavior and target-store proof outstanding.**

Source anchors: [earning](../../apps/web/lib/weletic/loyalty/earn.ts),
[campaign targeting](../../apps/web/lib/weletic/loyalty/bonus-campaign-policy.ts),
[referrals](../../apps/web/lib/weletic/loyalty/referrals.ts),
[tiers](../../apps/web/lib/weletic/loyalty/tier-lifecycle.ts), and
[discount provisioning](../../apps/web/lib/weletic/loyalty/shopify-discounts.ts).
Existing recurring-discount fields alone do not implement all purchase-type and
subscription lifecycle settings.

- [ ] Merchant configuration and live purchase/pending/refund/expiry, birthday,
      signup, manual-adjustment, VIP qualification/entry-reward journeys.
- [ ] Immutable exact line allocations, SKU/collection match-any bonuses,
      nonmatching base earnings and proportional refund clawback.
- [ ] Branded referral landing/link/share surfaces, friend claims, qualification,
      advocate rewards, fraud review and refund handling.
- [ ] One-time/subscription/both policy in UI, snapshots and provisioning;
      first-payment/fixed-count/recurring applicability, distinct renewal orders,
      and no repeated new-customer/referral rewards or contract management.
- [ ] Explicit honor-system social actions and display-only VIP perks.

## Package 5 — collection, moderation and Q&A

**Verified-purchase product-review baseline only; expanded acceptance outstanding.**

Inspect [review schema](../../apps/web/prisma/schema/weletic-reviews.prisma),
[contracts](../../apps/web/lib/weletic/reviews/contracts.ts), and
[historical local evidence](native-reviews-local-evidence.md). Token-bound product
submissions and merchant replies do not prove open/store reviews or Q&A.

- [ ] Separate product/store subjects and rating aggregates; purchase invitations
      and email-verified open submissions with truthful purchase badges.
- [ ] Versioned product-question definitions, reviewer edits, merchant replies,
      reports and audited moderation reasons.
- [ ] Deterministic spam/rate limits, PII masking and profanity policy without
      rating-based rejection/delay; moderated Q&A, answers and notifications with
      no automatic review incentive.
- [ ] Preserve genuine feedback after refunds; revoke ineligible unused invites.

## Package 6 — media, translations and presentation

**Private-photo/display baseline; broader media and presentation incomplete.**

Source anchors: [media](../../apps/web/lib/weletic/reviews/media.ts),
[public projection](../../apps/web/lib/weletic/reviews/public.ts), and
[rating sync](../../apps/web/lib/weletic/reviews/summary-sync.ts).

- [ ] Five supported-format photos plus one quarantined video, at most 100 MB/
      60 seconds; bounded actual-media validation, metadata stripping, safe
      transcoding and processing-resource limits outside application requests.
- [ ] Shared list/grid/carousel/media-gallery layouts, distributions, helpful
      votes, filters and stable pagination.
- [ ] Explicit product groups with source labels and direct/grouped counts;
      attributed manual translations preserving originals.
- [ ] Approved-only content/media, invalidation after edit/moderation/erasure,
      standard Shopify rating metafields and no duplicate Product structured data.

## Package 7 — shopper communications and automation

**Transport/request foundation; unified journeys and consent contract incomplete.**

The [request email service](../../apps/web/lib/weletic/reviews/email.tsx) has
purchase checks and winning leases. It is not a shared shopper editor, consent
ledger, reminder/frequency engine or provider-event reconciliation system.

- [ ] Adapt Dub editor/preview/variables/reporting to typed shopper audiences;
      cover requests/reminders, requested referral coupons, reward issuance,
      VIP changes, expiry and Q&A answers with shared branding/transport.
- [ ] Domestic/international timing, fulfillment/delivery with explicit fallback,
      product overrides, consolidated orders and repeat-purchase controls.
- [ ] New defaults: fulfillment +7 days, at most one reminder +7 days, at most
      three product links/email and one solicitation/shopper/seven days. Preserve
      saved policies; stop on submission, unsubscribe, cancellation, expiry or
      purchase invalidation.
- [ ] Suppression, bounce/complaint reconciliation, consent-source timestamps,
      quiet hours and history; affirmative marketing consent and a separate
      requested-service allowlist. Inventory Shopify-generated duplicate notices.
- [ ] Approved real delivery through `email.weletic.com`; no automatic transport
      switch after ambiguous SMTP acceptance. Native rules plus Flow, not a
      second general workflow builder.

## Package 8 — merchant and shopper interfaces

**Existing separate surfaces; unified Shopify-first acceptance incomplete.**

Source anchors: [review administration](../../apps/web/ui/weletic/reviews/reviews-admin.tsx)
and [Shopify extensions](../../packages/shopify-app/extensions).

The reusable [shopper browser](../../apps/web/ui/weletic/shoppers/shopper-browser.tsx)
has a thin Weletic workspace adapter, three-language copy and local mobile proof.
The [Shopify Customers increment](./shopify-customers-implementation.md) now adds
an embedded adapter locally: fresh `customers.read` authorization and projection
reads share a transaction; all seven profile sections use strict browser response
validation, scoped pagination and fresh-navigation cache isolation. Local evidence
includes 21 isolated MySQL tests, 4,694 passing unit tests, and synthetic-HTTP
Chromium checks for three locales, mobile layout and denied-navigation privacy.
PR #79 merged at `625d33f0a8` with green release and post-merge checks; live
acceptance remains pending. The customer-account adapter is not
implemented by this increment, and no whole-package interface gate is closed.

The [Settings/Appearance increment](./shopify-settings-implementation.md) adds
local embedded adapters around the shared three-language editor and existing
settings/module writers. Explicit staff permissions, minimal appearance-only
responses, revision/generation checks and reauthorization-safe write controls
have focused test and isolated MySQL evidence. Local synthetic-HTTP Chromium
appearance checks cover saving, Japanese rendering and a 375px Vietnamese
layout. Full feature release checks and live acceptance remain pending;
specialized widget layouts are not completed by this branding increment.

The [Loyalty configuration increment](./shopify-loyalty-configuration-implementation.md)
adds a shared three-language editor for points, expiry, VIP qualification,
valuation and lifecycle controls. Signed Shopify and workspace gateways share
strict exact-value contracts, the existing transaction-local writer, and a
configuration fingerprint. Workspace duplicate settings/VIP policy forms are
removed; backfill previews/audits and disabled commits remain. Focused tests and
34 isolated MySQL tests cover authorization, revisions, overlap and rollback.
Whole-branch release verification and live acceptance remain pending; this is
not completion of earning-rule, rewards, referrals or campaign administration.

The [staff-access investigation](./shopify-staff-access-design.md) identifies
missing actor authorization in existing embedded routes and reproduces loss of
effective user scopes in the installed SDK's session-property round trip.
Online-token enablement alone is insufficient. Store-owner bootstrap authority
was accepted in [ADR 0018](../adr/0018-shopify-owner-and-store-scoped-staff-access.md);
no staff grants or authentication configuration were changed by the investigation
or decision capture.

The [online-session persistence increment](./shopify-online-session-evidence.md)
preserves effective user scopes and rejects unsafe identity properties before SDK
hydration, with real signed session/MySQL regression evidence. It does not enable
online tokens, staff grants or the embedded owner-administration model.

The [installation-fencing increment](./shopify-online-installation-fencing.md)
binds online exchange/load/write/delete paths to original installation evidence,
lease ownership, expiry and session versions. Local evidence includes the real
SDK with synthetic JWTs and a separate signed-client MySQL race. This does not
establish live owner/staff authorization or activate online tokens.

- [ ] Full embedded Overview, Customers, Loyalty, Reviews/Q&A, Campaigns,
      Appearance, Analytics and Settings; shared business contracts/components
      with thin Shopify/Weletic navigation and authentication adapters.
- [ ] Explicit authenticated staff permissions, not installation-as-owner access;
      duplicate route/editor consolidation with compatibility redirects.
- [ ] One account hub/wallet/activity, referral status and review tasks; optional
      launcher, landing page, product points/stars/reviews and eligible
      post-purchase prompts, without a competing review popup.
- [ ] English/Japanese/Vietnamese, mobile, keyboard/accessibility, loading/error
      states and storefront performance on both merchant/customer surfaces.

## Package 9 — imports and historical gates

**Backfill/repair code exists; import and financial release gates incomplete.**

Inspect [backfill](../../apps/web/lib/weletic/loyalty/backfill.ts),
[append-only repair](../../apps/web/lib/weletic/loyalty/backfill-repair.ts), and
[the rejecting commit API](<../../apps/web/app/(ee)/api/shopify/loyalty/admin/backfill/route.ts>).
An empty isolated audit does not establish zero unresolved historical jobs.

- [ ] Smile balance/birthday/tier and Judge.me product/store review/media/Q&A
      previews; immutable batches/source IDs/hashes/errors and resumable replay.
- [ ] Preserve import provenance; no automatic verification, review incentives,
      historical invitations or tier-entry awards. Import opening balances, not
      fabricated order earns; exclude overlapping backfill periods.
- [ ] Real MySQL overlap, mutation rejection, partial/full refunds, zero/three
      decimal currencies, multi-line allocation, repair replay and refund-after-
      repair evidence; zero unresolved audit findings before commit enablement.
- [ ] Keep existing coupons without recreation and one active writer at cutover.

## Package 10 — trustworthy analytics

**Exact financial foundation; combined incentive/acquisition analytics incomplete.**

Inspect [financial arithmetic](../../apps/web/lib/weletic/loyalty/analytics-financial.ts),
[analytics](../../apps/web/lib/weletic/loyalty/analytics.ts),
[ledger classification](../../apps/web/lib/weletic/loyalty/ledger-entry-policy.ts),
and [owner exports](<../../apps/web/app/(ee)/api/shopify/loyalty/admin/analytics/export/route.ts>).

- [ ] Balances/liability, referral funnel/CAC, review conversion/moderation/media
      and coupon utilization, using authoritative commerce/incentive records.
- [ ] Count order revenue once; disclose review-assisted attribution without
      causal-lift claims. Include direct review coupons, referral benefits,
      suppressed commissions and unrecoverable incentive costs.
- [ ] Exact rational valuation (including JPY `1/100`), large BigInts,
      accounting-currency mismatch handling, explicit entry classification,
      zero-cost ROI reasons, decimal-string/numeric compatibility and safe CSV.
      Preserve `liabilityValuationCurrency`, `liabilityMinorUnitsNumerator` and
      `liabilityPointsDenominator`; round up once at the aggregate boundary and
      use `accountingNet/accountingTotal`, not presentment-currency totals.
- [ ] Reconcile independent SQL totals; distinguish point liability, issued
      stored value and utilization without double-counting conversions/revenue.

## Package 11 — native Shopify integration

**Four-trigger source baseline; publication and expanded Flow contract incomplete.**

Inspect [trigger contracts](../../apps/web/lib/weletic/loyalty/flow-triggers.ts),
[outbox](../../apps/web/lib/weletic/loyalty/flow-trigger-outbox.ts),
[lifecycle](../../apps/web/lib/weletic/loyalty/flow-lifecycle.ts), and
[qualified integration evidence](shopify-flow-integration-evidence.md).

- [ ] Preserve and publish `weletic-points-earned`, `weletic-vip-tier-changed`,
      `weletic-reward-redeemed`, `weletic-points-expiring-soon`; add review-submitted,
      review-published and referral-completed triggers.
- [ ] Configured-earning-rule and eligible-order-review-request actions through
      shared eligibility, consent, limits and idempotency; prevent duplicate
      native/Flow rewards/contacts and recursive reward loops.
- [ ] Same-transaction durable events, authenticated ordered lifecycle state,
      required reference/custom fields, numeric customer IDs, payloads below
      50 KB, retries, dead letters and disabled-workflow suppression.
- [ ] One real workflow per trigger/action and enable/disable/retry proof after
      approved publication. Keep Basic native discounts; do not infer Functions,
      Plus surfaces or Flow eligibility from public distribution alone.

## Package 12 — acceptance, cutover and cleanup

**Outstanding; local/CI evidence does not close live acceptance.**

- [ ] Controlled `yamaxdev` referral claim → eligible test checkout → one
      acquisition reward → refund, including duplicate/fraud cases.
- [ ] Fulfillment → approved actual inbox → review/media → validation → single
      incentive → publication; open review, Q&A notification, unsubscribe,
      privacy/media cleanup and a supported subscription lifecycle.
- [ ] All Flow journeys; MySQL financial/concurrency/security/privacy races;
      independent SQL reconciliation; UI parity/locales/accessibility/performance.
- [ ] MySQL races for review rewards, referral/affiliate settlement, token
      consumption, email leases, outbox deduplication, stale workers and
      overlapping imports/backfills. Cover cross-store access, staff permissions,
      token replay, upload ownership, erasure and delayed jobs after reinstall.
- [ ] Partial/full refunds, negative balances, large BigInts, USD/JPY/VND/BHD,
      zero-cost ROI, currency mismatches and subscription renewals. Exercise
      SKU-only, collection-only, combined match-any, VIP intersection,
      partial-line bonuses and refund clawback.
- [ ] Low-rating eligibility, open versus purchase verification, product/store
      separation, import provenance, media rejection, edits/republication and
      fraud reversal; reminders, frequency caps, consent changes, complaints,
      retries and native/Flow duplicate prevention.
- [ ] Rehearse one-writer activation, pause/resume and containment rollback before
      cutover. Remove obsolete paths/screens/validators only after compatibility
      checks; retain financial history/import evidence. Table drops and provider
      subscription cancellation are separate actions.
- [ ] Formatting, lint, web/Shopify types/builds, Prisma, full Vitest/Playwright,
      applicable validators, adversarial review, successful CI/merges, synchronized
      clean `main`, merged-branch cleanup and post-merge verification.

## Payment addendum and release record

Keep Gift Card/Store Credit configuration, wallet and permitted API-management
work in scope. Under the approved addendum, formal-development-store stored-value
checkout settlement and its post-settlement refund paths remain platform-gated.
Do not promote an admin switch, issuance/readback or another store's transaction
to settlement proof, or bypass the gate with draft/manual orders.

The following preserves the approved addendum's prerequisites as a checklist to
revalidate against current Shopify contracts before activation, not a claim of
new platform or checkout proof:

- **Store Credit:** new customer accounts or Shop Pay, not legacy accounts;
  balance currency matching checkout; initial subscription purchase, not
  recurring bills; no direct payment of draft/edited orders. Refund to original
  payment does not automatically reverse issued credit: explicitly reconcile
  duplicate-refund risks, expiry, applicable fees and merchant policy.
- **Gift Cards:** independently verify store-currency conversion versus
  local-currency matching/cross-currency enablement; do not borrow Store Credit's
  currency rule. Check initial-versus-recurring subscription eligibility and
  the prohibition on buying another gift card; reconcile actual Shopify amounts
  and currencies. Mask full codes/private access links in logs, exports and
  public projections. Wallet association is not recipient-binding proof.
- **Earning and costs:** explicitly resolve gift-card-product purchases versus
  merchandise paid with stored value, including promotional/purchased/refunded
  value. Reverse only the intended award, prevent double earning, and do not
  count points conversion twice or classify stored-value issuance as revenue.
- **Access:** verify installed grants, access to orders older than 60 days
  (`read_all_orders` plus relevant order permissions), protected customer data
  approvals and endpoint eligibility separately. Record actual permitted API
  issuance/readback, remaining balance, retry, audit and reversal behavior.
- **Subscriptions and discounts:** identify the subscription app, selling plan,
  compatible test gateway and controlled renewal. An ordinary test checkout is
  not renewal proof. Coupon first/fixed/recurring applicability is distinct from
  payment-instrument support. Test review/referral/loyalty coupon combinations;
  one incentive per order does not define coupon stacking.
- **Timing and notifications:** confirm the intended store timezone before
  birthday, campaign, expiry, quiet-hour or email activation. The addendum
  observed Eastern Time with JPY: do not silently change it to Tokyo. Test
  boundary behavior and persist the policy timezone. Inventory Shopify and
  Weletic notices; sender-domain verification is not inbox-delivery proof.

Later stored-value settlement needs a separately approved eligible environment,
controlled transaction and cleanup plan; no real card charge is authorized here.

Every accepted item needs: requirement ID/package, canonical shop ID/domain,
app ID and installed version, installation generation, API version/scopes,
currency/timezone/policy revision, evidence class, controlled fixture references,
observed result, cleanup result and unresolved exclusions. Keep secrets and PII
out of public artifacts. Named live evidence from `n0pvef-cs` remains attributed
to that store. No blanket Smile/Judge.me parity or completion percentage is valid.

Expand → backfill → validate → switch → later contract migrations; retain additive
API/numeric compatibility for one transition release. Shared-schema merges need
staged validation and explicit confirmation. Historical repair remains audit/
dry-run by default; no bulk sends, automatic production repair, external
publication, activation or commercial launch follows from this matrix.
