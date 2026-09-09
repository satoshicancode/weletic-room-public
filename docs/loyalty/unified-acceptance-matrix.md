# Weletic company-store loyalty — acceptance matrix

Updated 2026-09-09 (Asia/Tokyo). This is the execution checklist for Hiro's
approved **Loyalty Completion Plan for Weletic Stores**. It supersedes the older
mixed loyalty/reviews checklist for this stream; it does not activate excluded
review features or waive any external execution gate.

**Overall acceptance: incomplete. No live gate below is certified complete.**
Code, local tests, CI, and competitor observations are evidence at their stated
level, not substitutes for named journeys on yamaxdev.

## Scope and authoritative sources

- Authoritative development repository: [weletic-room-public](https://github.com/satoshicancode/weletic-room-public).
  Start loyalty branches from its current main. Keep legacy-private read-only
  and park unrelated reviews/video branches.
- yamaxdev is the sole implementation and live-acceptance store. Verify immutable
  Shopify shop ID and canonical domain; the retained montdev alias is not proof.
- n0pvef-cs is a read-only paid Smile reference, with no customer migration.
  Trial expiry is not a production launch deadline.
- weletic.com production rollout is a later, separate environment gate.
- Build company-store loyalty, not SaaS: no billing tiers, marketing funnel or
  self-service merchant onboarding. The approved public distribution target is
  a free, limited-visibility listing, installable through its direct URL.
- Reviews, review incentives, media, Q&A, POS, external ESP/Klaviyo integrations,
  AI, automatic translation and external merchant support are excluded from
  this focused stream. Preserve compatible existing review contracts.
- This matrix replaces private-PR execution references with public evidence.
  The prior matrix, including its private commit mapping, was preserved outside
  the public repository. This is not removal from Git history, nor a repository-
  wide claim that all historical private references have been eliminated.

## Public implementation checkpoints — not live acceptance

Snapshot verified from public GitHub PR state on 2026-09-09:

| Public PR                                                                                                                              | Implementation checkpoint                                | Evidence boundary                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [#2](https://github.com/satoshicancode/weletic-room-public/pull/2)                                                                     | Shared VIP tiers and bonus campaigns                     | Merged code; live editor/lifecycle gates open                                                  |
| [#3](https://github.com/satoshicancode/weletic-room-public/pull/3)                                                                     | Smile paid-control benchmark                             | Written reference observations, not executed parity                                            |
| [#4](https://github.com/satoshicancode/weletic-room-public/pull/4), [#9](https://github.com/satoshicancode/weletic-room-public/pull/9) | Subscription purchase policies and one-time editor reset | Merged contracts/editors; real renewal classification open                                     |
| [#6](https://github.com/satoshicancode/weletic-room-public/pull/6), [#8](https://github.com/satoshicancode/weletic-room-public/pull/8) | Expiry localization and communications editors           | Merged code; real delivery/consent acceptance open                                             |
| [#7](https://github.com/satoshicancode/weletic-room-public/pull/7)                                                                     | Signed analytics and exact exports                       | Merged code; independent live SQL reconciliation open                                          |
| [#10](https://github.com/satoshicancode/weletic-room-public/pull/10)                                                                   | Privacy-fenced referral-completed Flow                   | Merged as 7ab142733e52a9a1f450f7b3d962ab781cf2a27e; public UID/publication/live workflows open |
| [#5](https://github.com/satoshicancode/weletic-room-public/pull/5)                                                                     | Audited company-store approval                           | Open, not merged; schema merge/application approval outstanding                                |

Historical import work remains local and unmerged. Three import tables were
approved and created only in isolated MySQL weletic_loyalty_dev. Latest source
and ledger suite runs cover 19 passing tests, including final-insert failure
atomicity and exact fixture cleanup. This is not source-upload, complete
rollback-orchestration, durable-supervision or live acceptance.

Recheck current source, PR state and CI before execution; these snapshots do not
identify an installed app version. The [referral Flow checkpoint](referral-completed-flow-implementation.md)
records its qualified evidence. Existing [local services](development-environment/local-services.md),
[runtime](development-environment/runtime.md), [session coordination](development-environment/session-coordination.md)
and [renewal](development-environment/session-renewal.md) documents remain local
proof only.

## A — Reference, repository and public identity

- [ ] A1: Review the [Smile benchmark](benchmark-smile-2026-09-08.md) for the
      remaining paid subscription conditions, appearance/nudges, notification
      variables/defaults, analytics filters and export columns. Retain normalized
      written observations; no configuration changes, sends, transactions,
      subscription changes or customer exports. No unredacted screenshots in public.
- [ ] A2: Verify origin/public-main branch provenance, read-only legacy-private,
      parked reviews branch, and replacement of stale execution references.
- [ ] A3: Preserve the custom-app TOML. Add a separate reviewed configuration
      for Weletic Loyalty Reviews Dev, without credentials. Verify public HTTPS
      app/callback/webhook/proxy alignment and canonical shop identity.
- [ ] A4: Reconcile every extension's ownership and generate public-app-specific
      UIDs. Never deploy custom-app identities into the public registration. CLI
      validation can insert a local UID; schema validity is not ownership proof.
- [ ] A5: Prove isolated database, Redis, media, sessions, queues and secret
      namespaces, including effective process environment. Never share sessions or
      installation generations with the custom app.

## B — Merchant control plane and immutable contracts

- [ ] B1: One Shopify-first navigation and shared settings, earning, reward and
      referral contracts/components; thin signed adapters, compatible redirects.
- [ ] B2: Revision-fenced VIP tiers, thresholds, multipliers, entry rewards,
      perks, grace periods and tier history. Imported placement is not achievement.
- [ ] B3: Revision-fenced campaign schedules, multipliers, VIP eligibility,
      SKU/collection targeting and immutable rules once a campaign is running.
- [ ] B4: Signed VIP, campaign, communication, analytics and import gateways.
      Every write carries expectedInstallationGeneration and expectedRevision.
      Reauthorize staff in the transaction; foreign identifiers fail closed.
- [ ] B5: Immutable purchaseType = one_time | subscription | both and
      subscriptionCadence = first_payment | first_n_payments | every_payment.
      subscriptionPaymentLimit is required only for first_n_payments.
- [ ] B6: Apply these policies to earning, rewards and referrals; persist policy
      revisions and redemption/referral/order evidence so edits cannot reinterpret
      history. Signup and referral acquisition remain one-time.
- [ ] B7: Interpret subscription orders already produced by Shopify. Do not
      implement subscription selling or contract management. Prove first payment,
      first-N payments and distinct renewals, not repeated processing of one order.

## C — Shopper loyalty and financial lifecycle

- [ ] C1: Purchase, signup, birthday and authorized manual points; pending
      maturity, expiry, warning/last-chance timing and replay-safe awards.
- [ ] C2: Immutable line-level BigInt allocations, specificity/tie-breaking,
      nonmatching base earning, SKU/collection match-any campaign targeting and VIP
      intersection. Partial/full refunds reverse only allocated remaining awards.
- [ ] C3: VIP progression, entry rewards, grace periods and downgrade; keep
      exact qualifying counters/history and no duplicate entry rewards.
- [ ] C4: Branded referral sharing/landing/claiming, anonymous friends,
      qualification, advocate/friend fulfillment, abuse review and refund clawback.
      Preserve existing referral/affiliate acquisition precedence without duplicate
      reward or commission; do not expand affiliate product scope.
- [ ] C5: Fixed, incremental, percentage, shipping and product rewards, plus
      Gift Card and Store Credit where permitted. Prove issuance, retry, usage,
      cancellation/expiry and supported refund behavior separately.
- [ ] C6: Capability-gate unsupported Gift Card/Store Credit operations with
      visible unavailable reasons. Admin issuance/readback is not checkout-settlement
      proof. Do not use draft/manual orders to bypass platform restrictions.
- [ ] C7: Preserve native Shopify Basic discounts. Keep Plus-only checkout
      reductions disabled; public distribution alone does not enable the Function.
- [ ] C8: Resolve gift-card-product earning versus merchandise paid with stored
      value; prevent duplicate conversion costs/earning. Verify currency, subscription,
      remaining-value and refund rules before stored-value activation. No real card
      charge or alternate settlement environment is authorized by this checklist.
- [ ] C9: Preserve existing App Proxy and customer-account APIs. No
      unauthenticated public write API, raw reward codes or private access links in
      public projections. Social actions are explicitly honor-system when applicable;
      display-only VIP perks must not imply automated fulfillment.

## D — Communications, analytics and imports

- [ ] D1: Shared merchant editors and EN/JA/VI content for points earned,
      redemption, referral friend/advocate, birthday, VIP achievement, reward expiry,
      points warning and last-chance journeys; exact variables/defaults and previews.
- [ ] D2: Consent, requested-service eligibility, suppression, unsubscribe,
      quiet hours, frequency limits, bounce/complaint handling and communication
      history. Check Shopify/native/Flow duplicate notices. Ambiguous transport
      acceptance must not cause an automatic alternate-provider resend.
- [ ] D3: Confirm the intended timezone before birthday/campaign/expiry/email
      activation. Do not silently replace a retained store timezone with Tokyo.
      Prove boundary timing and approved real inbox delivery.
- [ ] D4: Exact financial liability, reward utilization, referral funnel and VIP
      distribution, analytics filters, and CSV/JSON exports. Count revenue once;
      distinguish liability, issued stored value, utilization and unrecoverable costs.
- [ ] D5: Preserve rational valuation, aggregate rounding, exact integer strings,
      accounting rather than presentment totals, explicit currency mismatch and
      zero-cost ROI handling. Independently reconcile SQL totals and exports.
- [ ] D6: Generic Shopify-customer opening-balance/birthday/optional-tier import:
      complete-file preview, validation, immutable source provenance, commit,
      reconciliation and contained rollback. No Smile migration is required.
- [ ] D7: Imports append opening-balance ledger entries, not fabricated historic
      earns, referrals, coupons, invites or tier-entry rewards. Preserve existing
      coupons and prevent overlap with historical backfill.
- [ ] D8: Durable execution, recovery, bounded retries/dead letters, generation/
      revision fences, partial-batch evidence and source/row integrity. Do not expose
      commit/rollback as complete while scheduling/orchestration remains disconnected.
- [ ] D9: Append-only rollback preserves subsequent balances/birthday/tier
      changes through explicit containment, not blind restoration. Preserve ledger
      history; prove expiry/birthday-job/tier-history consequences and privacy erasure.

## E — Surfaces, workers and installation access

- [ ] E1: Complete launcher/drawer, loyalty landing page, product points,
      customer-account hub/profile, wallet/history, referral sharing/claiming and
      eligible thank-you surfaces in English, Japanese and Vietnamese.
- [ ] E2: Merchant editors and shopper surfaces at 375px, keyboard/accessibility,
      loading/error/permission states and performance; no cleartext shopper
      identifiers in DOM. Identify mocked versus authenticated/live browser evidence.
- [ ] E3: Supervise outbox, expiry, birthday, tier-review, voucher, token-renewal
      and privacy workers. Prove retry/dead-letter/stuck-job alerts, lease recovery,
      shutdown behavior and kill-switch/containment runbooks.
- [ ] E4: New public installs default to storeAccessState = pending_approval.
      Only required authentication/privacy handling is allowed; no customer sync or
      loyalty writer activation. An audited operator promotes approved company stores.
      Also enforce active/suspended behavior across all entry points and workers.
- [ ] E5: Fresh public install/reinstall rejects stale workers, credentials,
      permissions and installation-generation evidence; test cross-store isolation.
- [ ] E6: Export, erase, retain and suppress every new record/projection.
      Anonymous referral HMAC snapshots need scoped use, erasure, physical expiry,
      key-retirement evidence and fail-closed legacy handling. Read-only SQL
      predicates do not establish UPDATE race or representative scan performance.

## F — Native integration and public release

- [ ] F1: Publish points-earned, VIP-changed, reward-redeemed, points-expiring
      and referral-completed Flow triggers under the public identity. Use durable
      same-transaction events, correct reference/custom fields and bounded payloads.
- [ ] F2: Add an idempotent, staff-authorized points-adjustment action. Choose
      explicit authorization semantics before implementation: the signed Flow
      callback is not an online staff session. Prevent duplicate/recursive awards
      and bind authorization and run identity to the store/installation.
- [ ] F3: Prove one real workflow per trigger/action, including enable/disable,
      retries, dead letters and disabled-workflow suppression. Refresh-time rechecks
      are not a cross-customer lock spanning external I/O.
- [ ] F4: Reconcile manifest/runtime scopes, including write_app_proxy; enforce
      least privilege, protected-customer-data grants and GraphQL-only Admin API
      compliance. Do not request unsupported Gift Card/Store Credit behavior.
- [ ] F5: Obtain the required protected customer data and network access for
      customer-account surfaces, then prove live authorized data access.
- [ ] F6: Complete install/reinstall, support/contact, privacy and listing
      requirements for the free limited-visibility public app. No SaaS billing or
      self-service merchant onboarding. Unknown installations remain approval-gated.
- [ ] F7: Submit only after install/reinstall, core merchant UI, privacy and
      shopper journeys pass. Retain the custom app until all public identity gates
      pass; its uninstall requires separate explicit approval.

Shopify supports direct-URL installation of limited-visibility listings without
indexing them: [listing visibility](https://shopify.dev/docs/apps/launch/distribution/visibility).
Revalidate [App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements)
and [customer-account capabilities](https://shopify.dev/docs/api/customer-account-ui-extensions/latest)
before requesting access or submitting. These links are requirements, not evidence
of approval.

## G — Verification and completion record

- [ ] G1: Per PR, focused contracts, adversarial self-review, Prisma validation,
      Prettier, lint, web build/types, Shopify typecheck/build, relevant Vitest and
      public Fast Quality Gate. Verify merge guards, sync main, clean merged branches
      and inspect post-merge CI. Document justified non-applicable checks.
- [ ] G2: Isolated real MySQL races for ledger/refunds, campaign allocation,
      referral qualification, subscription renewals, imports, worker leases and
      installation-generation changes. Include negative balances, large integers,
      zero/three-decimal currencies, transaction failure and exact fixture cleanup.
- [ ] G3: Named yamaxdev evidence for one-time and subscription orders, every
      eligible reward type, multi-line earning, targeting, partial/full refund,
      maturity/expiry, VIP, referral claim/qualification/clawback, communications,
      Flow, worker supervision and independent SQL reconciliation.
- [ ] G4: Rehearse one-writer activation, pause/resume and containment rollback.
      No production weletic.com cutover, historical repair, bulk sends, schema
      application or old-app removal is implied by a code merge.
- [ ] G5: Mark loyalty complete only when every applicable gate has named
      evidence. Platform-ineligible features need explicit observed reasons and
      visibly unavailable UI, not simulated success or silently omitted coverage.

For each accepted item record: requirement ID, evidence class, canonical shop
ID/domain, app ID/installed version, installation generation, API version/scopes,
currency/timezone/policy revision, controlled fixture references, observed
result, independent reconciliation where applicable, exact cleanup and remaining
exclusions. Keep secrets/PII out of public artifacts.

Evidence classes are source inspected, local service/DB proof, browser proof,
live proof and platform-gated. Each has only its stated scope. An empty database,
passing simulation, historical competitor result or green CI cannot close a
live gate. Do not infer a completion percentage from checked code paths.

## Explicit execution and architectural decisions still open

External Shopify deployment, schema application, App Store submission,
protected-data/network requests, real email delivery and old-app uninstall remain
separate execution gates. In addition to the three isolated import tables,
[ADR 0023](../adr/0023-durable-import-jobs-and-no-tier-rollback.md) records approval
for import outbox enum values and nullable no-tier history, applied only to local
weletic_loyalty_dev. This does not authorize shared/production schema changes or
store-approval schema rollout, and does not prove working import dispatch/rollback.

The points-adjustment Flow action awaits Hiro's choice between an audited,
revocable bounded automation authorization and approval of every adjustment.
Do not interpret continued goal execution as a choice. Public HTTPS endpoints,
extension ownership, timezone and stored-value activation decisions must likewise
be resolved from explicit evidence/approval, not inferred from this checklist.
