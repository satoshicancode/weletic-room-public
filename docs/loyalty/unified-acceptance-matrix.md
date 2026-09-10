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
| [#5](https://github.com/satoshicancode/weletic-room-public/pull/5)                                                                     | Audited company-store approval                           | Backend foundation; isolated-only merge/staging approved September 9; install/status UI open   |
| [#12](https://github.com/satoshicancode/weletic-room-public/pull/12)                                                                   | Manifest/runtime fallback scope alignment                | Merged code; installed public scope acceptance remains open                                    |
| [#13](https://github.com/satoshicancode/weletic-room-public/pull/13)                                                                   | Historical opening-balance imports                       | Draft, unmerged; frozen tonight with separate uncommitted optimization preserved               |

Historical import work is now draft public PR #13, not merely the earlier local
19-test checkpoint. Its source/commit/rollback/orchestration have isolated proof,
including a 500-row worker lifecycle; full-scale execution, authenticated browser,
shared-schema compatibility and live acceptance remain open. The September 9
reference-first stream does not modify or publish its preserved optimization.
See L12 in the [dated backlog](smile-parity-backlog-2026-09-09.md) for qualified
prior performance/failure evidence and exact remaining tasks. Isolated schema
approval never authorizes shared/production application.

Recheck current source, PR state and CI before execution; these snapshots do not
identify an installed app version. The [referral Flow checkpoint](referral-completed-flow-implementation.md)
records its qualified evidence. Existing [local services](development-environment/local-services.md),
[runtime](development-environment/runtime.md), [session coordination](development-environment/session-coordination.md)
and [renewal](development-environment/session-renewal.md) documents remain local
proof only.

## A — Reference, repository and public identity

- [x] A1: Review the [Smile benchmark](benchmark-smile-2026-09-08.md) for the
      remaining paid subscription conditions, appearance/nudges, notification
      variables/defaults, analytics filters and export columns. Retain normalized
      written observations; no configuration changes, sends, transactions,
      subscription changes or customer exports. No unredacted screenshots in public.
      Evidence: REF-20260909 / MAP-20260909 in the
      [September 9 backlog](smile-parity-backlog-2026-09-09.md#tonights-verification-record),
      R1–R6 and S01–S36. This closes reference disposition only; inaccessible
      controls and locked reports remain explicitly unknown, not accepted behavior.
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

September 10 local [appearance editor checkpoint](merchant-appearance-editor-2026-09-10.md)
adds the existing nine branding fields through a signed revision-fenced gateway.
Its synthetic browser and contract evidence does not close B1/B4 or live shopper
surface gates; advanced appearance controls and nudges remain outstanding.

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
      Partial local evidence: [expiry communications integration](expiry-communications-integration-2026-09-10.md)
      connects warning/last-chance policies with immutable encrypted delivery
      requests, claim fencing and bounded retries. Four isolated MySQL cases pass;
      remaining journeys, complete privacy-worker races and live delivery remain
      unaccepted. This does not complete D1 or D2.
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

## September 9 — Requirement-to-task reconciliation

The [implementation-ready backlog](smile-parity-backlog-2026-09-09.md) contains
scope, reference, approach, subsystem, dependencies/decisions, tests and definition
of done for each task. The table below dispositions **all 48 existing requirements**;
it does not replace their detailed wording or close a live gate. R1–R6 and S01–S36
refer to the dated benchmark addendum. Q records tonight's actual verification.
Public PR state was read on September 9; merged code is not installed evidence.

| Requirement | Evidence / present boundary                                                          | Outstanding task                                   |
| ----------- | ------------------------------------------------------------------------------------ | -------------------------------------------------- |
| A1          | September 8 benchmark + September 9 R1–R6; explicit unknowns/locked reports          | L00 reference completeness/review                  |
| A2          | Tonight's separate branch starts from public main `6a277373`; import unchanged       | L00 repository-wide provenance/stale references    |
| A3          | Public registration identified; no reviewed deployed configuration proof             | L14                                                |
| A4          | Existing extensions are not proof of public ownership/new UIDs                       | L14                                                |
| A5          | Local environment notes are not public runtime isolation proof                       | L14, L16                                           |
| B1          | Shared control-plane code and PR #2 navigation exist                                 | L07, L09, Q signed/browser acceptance              |
| B2          | PR #2 merged; R5 preserves VIP semantic conflicts                                    | L04                                                |
| B3          | PR #2 merged; R5 scheduling observed, targeting is Weletic requirement               | L05                                                |
| B4          | VIP/campaign/communications/analytics gateways exist; import is draft                | L04, L05, L10, L11, L12, Q authorization/races     |
| B5          | PR #4/#9 immutable contracts merged                                                  | L03                                                |
| B6          | Policy revision/snapshot implementation exists; live interpretation open             | L03, L06                                           |
| B7          | No real distinct renewal evidence tonight                                            | L03                                                |
| C1          | Existing lifecycle implementation; R1 points timing                                  | L01, Q                                             |
| C2          | Immutable allocation code; no new named order/refund evidence                        | L01, L05, Q                                        |
| C3          | Tier lifecycle code and R5 reference, not live progression proof                     | L04                                                |
| C4          | Existing referral paths; R1/R2 previews are not claim proof                          | L06                                                |
| C5          | Reward implementations exist; core fixture is a bounded subset                       | L02, Q                                             |
| C6          | Capability guards require real store reasons/readback                                | L02, L17                                           |
| C7          | Native Basic discount strategy retained; Plus target remains disabled                | L02, L17                                           |
| C8          | Stored-value financial/earning activation decisions unresolved                       | L02, L17                                           |
| C9          | Existing signed shopper APIs retained, no new public writes tonight                  | L06, L09, Q privacy/ownership checks               |
| D1          | PR #6/#8 nine-policy editors; R4 records ten Smile entries                           | L10, L09                                           |
| D2          | New policy integration is explicitly `not_connected`                                 | L10                                                |
| D3          | No timezone replacement or real delivery authorized                                  | L01, L05, L10                                      |
| D4          | PR #7 exact aggregates/exports; R6 report catalog; funnel/cohorts incomplete         | L11                                                |
| D5          | Exact analytics contracts/local tests, not independent live reconciliation           | L11, Q                                             |
| D6          | PR #13 draft; generic import rather than Smile migration                             | L12                                                |
| D7          | Draft opening-balance/provenance implementation, no fabricated history               | L12                                                |
| D8          | Draft durable orchestration has local proof; scale/supervision open                  | L12, L16                                           |
| D9          | Draft append-only rollback/containment; preserved optimization not full-scale proof  | L12                                                |
| E1          | Theme/account surfaces exist; R2 inventory and preview only                          | L02, L06, L08, L09                                 |
| E2          | Previous local component evidence is partial; tonight's result recorded in Q         | L07, L08, L09, Q                                   |
| E3          | Workers exist; no supervised public runtime/alert rehearsal                          | L16                                                |
| E4          | PR #5 backend foundation and isolated approval; unknown-install/status UI incomplete | L13                                                |
| E5          | No fresh public install/reinstall acceptance                                         | L13, L14, L16                                      |
| E6          | Existing privacy guards; new-record UPDATE races/scan costs remain open              | L06, L10, L12, L16                                 |
| F1          | Existing trigger definitions; PR #10 referral producer merged, unpublished           | L15                                                |
| F2          | Authorization semantics undecided; callback is not an online staff session           | L15 decision before coding                         |
| F3          | No new real public workflow evidence                                                 | L15                                                |
| F4          | PR #12 fallback scope fix merged, public grants/least privilege still open           | L14, L17                                           |
| F5          | Protected-data/network access request and live access are external gates             | L17                                                |
| F6          | Internal-company limited-visibility strategy approved; release checklist open        | L13, L14, L17                                      |
| F7          | No submission/production rollout/custom-app uninstall tonight                        | L17                                                |
| G1          | Q will record focused checks/review/CI; no completion inferred from drafts           | Q                                                  |
| G2          | Existing isolated suites only at their stated scope; imports frozen                  | L01–L06, L10, L12, L16, Q                          |
| G3          | All named yamaxdev lifecycle/workflow/SQL evidence remains open                      | L01–L06, L10–L17, Q                                |
| G4          | One-writer activation/containment requires approved environment rehearsal            | L14, L16, L17, Q                                   |
| G5          | Overall loyalty acceptance remains incomplete                                        | Q closure only after all applicable named evidence |

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
separate execution gates. Approval for the three isolated import tables did not
authorize shared/production schema changes, an import outbox enum expansion,
store-approval schema rollout or nullable no-tier rollback history.

The points-adjustment Flow action awaits Hiro's choice between an audited,
revocable bounded automation authorization and approval of every adjustment.
Do not interpret continued goal execution as a choice. Public HTTPS endpoints,
extension ownership, timezone and stored-value activation decisions must likewise
be resolved from explicit evidence/approval, not inferred from this checklist.
