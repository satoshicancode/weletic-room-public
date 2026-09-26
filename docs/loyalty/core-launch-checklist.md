# Core loyalty and reviews launch — authoritative checklist

Approved September 26, 2026. [ADR 0045](../adr/0045-core-loyalty-reviews-launch.md).
This checklist supersedes conflicting launch requirements in the company-store
completion matrix and older roadmaps. Those records retain evidence and backlog
contracts; they are not additional launch blockers.

**Not launched. No hosted, billing, live-delivery or Shopify approval gate is closed
by this scope reset.** Baseline: public main c86f216e87. All changes below require
implementation and evidence before acceptance; checked-in configuration is not a
remote deployment.

## Launch contract

- One-time merchandise purchase points; fixed-value native discount redemption;
  wallet/history, account hub and storefront launcher; EN/JA/VI.
- Verified product reviews: text and optional photos, seven-day request delay,
  thirty-day validity, manual publication, no reminders; merchant replies and stars.
- One disclosed participation-points award per order, independent of rating and
  publication. No silent enrollment. No historical sends or imports.
- Flow: points earned, reward redeemed, review submitted, review published,
  and owner-granted bounded points adjustment. No duplicate built-in award.
- Shopify App Pricing: USD 500/month public plan, no trial/annual/usage tier;
  private free company plan. Paying outsiders receive these same features and
  basic support. Limited visibility does not prevent installation or waive review.

## P0 — release sequence and evidence

- [ ] P0.1 Scope: enforce core restrictions through UI, APIs, service mutations,
      event producers and worker execution; preserve cleanup/refund/privacy paths.
- [ ] P0.2 Runtime: approved exact resource proposal, persistent HTTPS, isolated
      SQL/Redis/queue/media, paired public identity, supervised workers, alerts,
      backup/restore, target schema inventory and public-owned extension mapping.
- [ ] P0.3 Billing: verified subscription snapshot scoped to app/shop/generation;
      hosted pricing return and entry refresh, five-minute reconciliation,
      paid/private-free provisioning, suspension and stale-check containment.
- [ ] P0.4 Loyalty: real purchase/earn/redeem/use/partial-and-full-refund journey,
      duplicates, crash/ambiguous issuance and independent ledger reconciliation.
- [ ] P0.5 Reviews: fulfillment/inbox/single-use form/photo/award/moderation/display;
      low-rating neutrality, privacy and exact private-object cleanup.
- [ ] P0.6 Flow: public-owned enabled capabilities, real workflow receipts,
      duplicate/revoked/stale generation behavior and bounded grants.
- [ ] P0.7 Release: protected-data evidence and approval, accurate paid listing,
      support/privacy links, reviewer journeys, approved production activation and
      72-hour monitoring of the first company store.

## Implementation boundaries

Use the existing Node/Cloudflare Containers/R2 topology with compatible managed
SQL, Redis and QStash. Remove video capacity from the first release. Produce a
complete acceptance and production quote before spending or provisioning; partial
historical estimates are not approval. Keep company and acceptance data separate.

Use Partner API activeSubscription as subscription authority; redirect parameters
are hints only. Current Shopify App Pricing does not send subscription-change
webhooks. Verification expires after five minutes: pause new benefits until it
refreshes. Privacy, refunds and existing obligations must remain recoverable.
No inherited Stripe checkout and no generic SaaS onboarding project.

Inventory exact target tables/columns/enums before deployment. Disabled modules
can still have required shared privacy/delivery readers. Apply reviewed compatible
DDL before deploying dependent readers. No automatic destructive schema rollback.

## Backlog order — not launch gates

1. P1: Forms → customer segments → Messaging with consent and idempotency;
   referrals; VIP/campaigns; additional earning and reward types; store reviews
   and reminders. Validate each independently before enabling it.
2. P2: subscription-order policies, advanced analytics/exports, appearance/nudges,
   open reviews and manual review translations.
3. P3: points/review imports, video, Q&A, Gift Cards/Store Credit, POS,
   Plus checkout and Shop syndication.
4. Indefinite: merchant acquisition features, pricing tiers, third-party ESP,
   AI translation and unrelated creator/affiliate expansion.

Preserve existing work and provider data. Do not launch deferred features through
legacy URLs or stale queued jobs. Existing financial/cleanup obligations must not
be silently discarded when new work is restricted.

## Verification and execution gates

Each code slice needs focused production-path tests, adversarial review, types,
lint/build and CI. Finance/auth/billing needs isolated SQL concurrency proof.
Named yamaxdev acceptance must record immutable shop identity, public app/version,
release SHA, installation generation, fixtures, expected/observed outcomes,
independent reconciliation and cleanup. Historical or synthetic evidence retains
its original scope.

Spending, shared/production DDL, live sends/orders, external publication and
production activation require the exact approval packets specified in the plan.
Keep the old apps installed until separate retirement approval. Shipping a code
slice does not satisfy any external acceptance checkbox.

## Implementation checkpoint — September 26

Core-v1 restrictions, a reduced extension staging bundle, Partner subscription
verification, paid/free native admission, fresh-billing new-benefit gates, status
UI and reconciliation jobs are implemented on `codex/core-loyalty-launch`.
Existing financial compensation/refunds/privacy remain independent of billing.
The original historical-import checkout and open work are preserved.

Local evidence: full existing unit run 673 files / 10,516 passed / 6 skipped;
subsequent focused billing/UI/compensation tests; isolated MySQL bootstrap,
mapped refresh, suspension/expiry, stale response and reinstall tests; metadata
schema inventory; web and Shopify type checks, repository lint and application
builds. Exact PR-head CI is recorded in the PR, not inferred here.

These are source and synthetic checks. None closes an installed-app acceptance
gate above. The [execution packets](core-launch-execution-packets.md) contain
resource selection/costs, additive SQL, runtime/pricing/schedule settings,
public extension publication and bounded live journeys. Pending approvals are
specific to those actions; the implementation plan itself remains approved.

### Free-first testing checkpoint

Paid provisioning is pending while the approved continuation uses local Docker,
synthetic SQL fixtures and a capture-only email inbox. Seven HTTP probes, nine
explicit core SQL checks and three localized email captures passed. The broad
legacy SQL run has one deferred referral failure; it is not recorded as green.
See [the evidence and limits](free-first-acceptance-2026-09-26.md). Installed-store,
durability and real-provider acceptance remain open.

The [yamaxdev preview preparation packet](yamaxdev-core-preview-packet-2026-09-26.md)
records verified public app/store identities, the unchanged `example.com` active
version, explicit core billing configuration for local tooling, and remaining
sign-in/resource prerequisites. It is not approval or evidence of a live preview.
