# Smile reference preservation and loyalty backlog — 2026-09-09

Deadline: September 9, 21:00 JST. **Loyalty is not live-accepted or production-ready.**
Tonight removes dependence on the paid reference and verifies a bounded existing
shopper flow. Tomorrow means work can start, not that all remaining work will finish.

## Evidence and execution boundary

- Source baseline: public `main` at `6a27737377418d40c1662da870198b354a821b18`.
  Tonight's branch is `codex/smile-reference-core-20260909`, in a separate checkout.
- [September 8 benchmark plus September 9 addendum](benchmark-smile-2026-09-08.md)
  is the normalized reference. R1–R6 identify new observations; S01–S36 identify
  the report catalog. UI-described, documentation-described and unknown are not
  executed behavior. Reference store `n0pvef-cs` is inspection-only; no migration.
- `yamaxdev` is the sole implementation/live-acceptance store. No new real order,
  redemption, email, deployment or shared schema application is authorized here.
  `weletic.com` production is a later independent environment gate.
- Merged means code exists, not accepted live. All applicable live requirements
  remain open in the [acceptance matrix](unified-acceptance-matrix.md).
- Freeze [draft import PR #13](https://github.com/satoshicancode/weletic-room-public/pull/13)
  at `b13eb922976f420cb67d58d2d4a8de38609ea0e8` and its separate uncommitted
  optimization changes. Do not move, discard, publish or optimize them tonight.
- No SaaS billing/onboarding, reviews/media/Q&A/incentives, POS, external ESP,
  Shopify subscription selling/contract management or copied Smile assets.

## Priority and current disposition

| ID  | Workstream                | Current state                                                                        | Tonight / next execution                                          |
| --- | ------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| L00 | Reference and repository  | Six reference areas and 34 included + 2 locked reports documented; unknowns explicit | Capture complete; retain normalized specification                 |
| L01 | Core points lifecycle     | Existing implementation; named lifecycle acceptance open                             | Existing isolated tests tonight; remaining live coverage later    |
| L02 | Rewards and wallet        | Existing implementation; complete reward-state acceptance open                       | Fixed-amount drawer/wallet tonight; other types later             |
| L03 | Subscription policies     | PR #4/#9 merged; real classifications unproven                                       | Preserve reference; reconcile/test later                          |
| L04 | VIP                       | PR #2 merged; lifecycle and semantic decisions open                                  | Preserve reference; lifecycle later                               |
| L05 | Campaigns                 | PR #2 merged; targeting/boundary/refund acceptance open                              | Specify now; test later                                           |
| L06 | Referrals                 | Existing core and PR #10 Flow producer; full claim/funnel acceptance open            | Preserve terms/states; finish later                               |
| L07 | Merchant appearance       | Basic branding exists; embedded and advanced controls incomplete                     | Field-level specification now                                     |
| L08 | Nudges                    | Full editor/runtime set not found                                                    | Specify all three plus campaign-prompt disposition                |
| L09 | Other storefront surfaces | Implementations exist; complete language/accessibility/live coverage open            | Core drawer only tonight; surface matrix later                    |
| L10 | Communications            | PR #6/#8 merged; new policy delivery `not_connected`                                 | Preserve ten-entry reference; delivery integration later          |
| L11 | Analytics                 | PR #7 merged; aggregate UI/export foundation                                         | Preserve catalog/definitions; funnel/cohorts/reconciliation later |
| L12 | Imports                   | Draft PR #13 plus uncommitted optimization; not merged                               | Frozen tonight; schema/load decisions later                       |
| L13 | Store approval            | PR #5 backend foundation; unknown-install provisioning/status UI incomplete          | Follow-on isolated merge/staging approved; live gates remain open |
| L14 | Public-app identity       | Isolation/configuration/ownership/live install unproven                              | External gates, later                                             |
| L15 | Flow                      | Trigger definitions/producers exist; publication/workflows/action incomplete         | Payload/auth specification now; execution later                   |
| L16 | Operations/privacy        | Workers and guards exist; full supervised/race acceptance open                       | Exact rehearsals documented; later                                |
| L17 | Platform/release          | Permissions, listing and production gates open                                       | Not promised tonight                                              |
| Q   | Verification/closure      | No new live acceptance                                                               | Record actual local/browser/CI result separately                  |

Every task below requires current-source inspection before coding. Reuse shared
contracts and thin signed Shopify adapters. Writes retain generation/revision
fences and transaction-time staff authorization; foreign-store IDs fail closed.
No task below silently authorizes an external gate or a new product policy.

## Implementation-ready tasks

### L00 — Preserve reference and public provenance

- **Scope/reference:** R1–R6 and all S01–S36; every A–G requirement gets an evidence
  or task disposition. Reuse September 8 observations and qualify gaps/conflicts.
- **Approach/subsystems:** maintain benchmark, this backlog and acceptance matrix;
  verify public origin/base, read-only legacy remote, parked review/import work.
  Preserve private mappings outside public Git. No screenshots/assets/customer
  data/signed URLs in public artifacts.
- **Dependencies/decisions:** safe authenticated Smile access; no autosave or
  uncertain-persistence preview. Unknowns use named first-party follow-up sources
  or a product decision, not guessed behavior.
- **Tests/DoD:** complete ID coverage, working relative links, secret/PII scan,
  source/observation-time/evidence labels, independent review; final report states
  any inaccessible detail and core verification result. Reference disposition is
  not a live gate pass. No further paid Smile access should be required to start.

### L01 — Complete points lifecycle acceptance

- **Scope/reference:** purchase/signup/birthday/staff adjustment, holding/maturity,
  expiry, replay, partial/full refunds; R1 points timing and R5 intentional refund
  divergence. Social actions remain explicitly honor-system where applicable.
- **Approach/subsystems:** exercise `earn.ts`, `ledger.ts`, `holding-period.ts`,
  expiry scheduler/notifications, earning-rule revisions and line reversal
  allocation under `apps/web/lib/weletic/loyalty`. Fix only demonstrated defects;
  retain integer/BigInt arithmetic and original immutable per-line allocations.
- **Dependencies/decisions:** approved store timezone before timed activation;
  isolated database guard before race fixtures; separate real-order/manual-points
  authorization before live writes. Do not adopt Smile's current-rule refund math.
- **Tests:** duplicate/concurrent order delivery; pending versus available;
  boundary maturity/expiry; signup and birthday once-only; 29/30-day birthday
  eligibility where the approved Weletic policy requires it; rule edited/disabled
  after earning; sequential partial then full refund; spent awards/negative
  balances; zero/three-decimal currencies and large integers.
- **DoD:** named yamaxdev order/ledger/policy/generation evidence, independent SQL
  before/after and exact cleanup for each lifecycle; local simulations labeled.

### L02 — Rewards, redemption and wallet

- **Scope/reference:** fixed, incremental, percentage, shipping, product, eligible
  Gift Card/Store Credit; eligibility, issue/retry/use/cancel/expire/refund. R1
  distinguishes friend combinations from ordinary redemption; R2 wallet unknowns.
- **Approach/subsystems:** existing reward catalog/snapshots, `rewards.ts`, native
  discount/financial sagas, settlement/ownership, coupon workers, theme drawer
  and wallet. Keep native Shopify Basic discounts and Plus reductions disabled.
- **Dependencies/decisions:** real redemption/settlement approval; capability and
  stored-value currency/refund rules under L17. Never use manual/draft orders to
  bypass an unavailable platform capability. Staff cancellation must preserve
  used-value costs, not promise all coupons can be revoked/refunded.
- **Tests:** guest/member, available/pending, affordable/insufficient, duplicate
  submit, success then wallet/history, lost response/reconciliation, stale auth,
  unavailable reward, disabled/deleted rule after issuance, expired/used coupon,
  concurrent issue/refund and foreign ownership. Test each reward type separately.
- **DoD:** local fixed-amount evidence tonight if feasible; complete named live
  issuance, usage and financial reconciliation later. A code issued by Admin API
  alone is not checkout-settlement proof.
- **Tonight's boundary:** the signed redemption route currently collapses ordinary
  service failures, including unavailable capability, into HTTP 400
  `redemption_failed`. The drawer safely handles that generic contract without
  displaying raw operational details or claiming issuance. A capability-specific
  disabled catalog/reason and real platform proof remain outstanding; no new API
  error contract was introduced tonight. Same-key retry is preserved within the
  current mounted page, not across reloads or another device.

### L03 — Subscription earning, reward and referral policies

- **Scope/reference:** R1; PR #4/#9 merged immutable one-time/subscription/both and
  first/first-N/every-payment contracts. Hidden Smile form bounds remain unknown.
- **Approach/subsystems:** reconcile `purchase-policy.ts`, order classification,
  earning rules, reward issuance and referral snapshots. Keep signup/acquisition
  one-time. Distinguish discount recurring-use limits from earning-order ordinals;
  do not create/manage subscription contracts.
- **Dependencies/decisions:** native subscription fixture/provider and real order
  approval; unsupported existing-contract discount behavior visibly unavailable.
  Reapplication/contract-binding terms must follow approved native policy, not a
  guessed counter. No schema/policy changes tonight.
- **Tests:** one-time line, subscription initial payment, distinct renewals 2/3/4,
  N=3 boundary, mixed orders, two contracts, same-order replay, out-of-order events,
  missing/ambiguous ordinal, removal/reapplication, policy edit after acquisition.
- **DoD:** named order evidence proves real classifications and native discount
  behavior; ambiguous classification fails closed; immutable historical outcomes.

### L04 — VIP lifecycle and explicit semantic reconciliation

- **Scope/reference:** R5 thresholds/periods/entry rewards/perks; PR #2 editors.
  Current code supports rolling-12-month/calendar/lifetime and grace-period policy.
- **Approach/subsystems:** shared VIP editor/contracts, `tiers.ts`,
  `tier-lifecycle.ts`, qualifying counters/history, entry-reward outbox. Preserve
  imported placement versus earned achievement. Display perks as merchant-fulfilled.
- **Dependencies/decisions:** keep approved existing behavior until Hiro resolves
  reference conflicts: once-ever versus re-promotion rewards; skipped-tier reward
  treatment; retention/downgrade notifications; calendar next-year retention versus
  current grace/step-down policy. Document each difference, not silent parity.
- **Tests:** threshold ±1, multi-tier jump, calendar year boundary, lifetime,
  rolling window, grace expiry/requalification, partial/full refund, repeated
  reviews, imported/no-tier placement, concurrent promotion and policy revision.
- **DoD:** explicit policy decision where needed plus named progression/history/
  entry/downgrade evidence with no unintended duplicate financial reward.

### L05 — Campaign lifecycle, targeting and refunds

- **Scope/reference:** R5; scheduling/multipliers, immutable running rules,
  SKU/collection match-any targeting, VIP intersection. Targeting is an approved
  Weletic requirement even where absent from Smile's draft.
- **Approach/subsystems:** shared campaign editor, `bonus-campaign-policy.ts`,
  line-level earning policy snapshots and refund allocation; preserve normal base
  earning on nonmatching lines and deterministic specificity/tie-breaking.
- **Dependencies/decisions:** confirmed timezone; keep current approved overlap,
  maximum duration and multiplier limits unless separately changed. Decide whether
  the documentation-only automatic campaign prompt is required (L08); do not
  assume it is one of the three configurable nudges or send promotion email.
- **Tests:** before/start/end/after boundaries, scheduled cancellation, running
  edit rejection, overlapping candidates, multi-line/multi-collection matches,
  VIP eligibility changes, partial/full refund after campaign completion/edit.
- **DoD:** named immutable allocation and timing evidence, exact reconciliation;
  no loss/double-award on retries and no multiplication of signup/social awards.

### L06 — Referral sharing, claiming and fulfillment

- **Scope/reference:** friend/advocate terms in R1/R2/R4; complete landing, anonymous
  claim, qualification, abuse handling, fulfillment and clawback. Preview sharing
  is not live claim proof. Keep existing referral/affiliate acquisition precedence.
- **Approach/subsystems:** referral configuration/revisions, friend claim,
  qualification/fulfillment workers, anonymous HMAC snapshot/privacy, referral
  drawer/landing and durable completion event. Do not add an unauthenticated write
  API or expose identities in public projections.
- **Dependencies/decisions:** separate live claim/order/email authority;
  app-delivered invitations require L10 decision. Existing signed claim contracts,
  consent and abuse policy remain authoritative; no new attribution model tonight.
- **Tests:** guest/new/existing customer, own referral, invalid/expired/already
  claimed token, same friend competing advocates, minimum purchase, first order,
  subscription exclusions, duplicate qualification, used versus unused reward,
  refund/clawback, privacy erasure and acquisition precedence.
- **DoD:** named claim→order→friend/advocate fulfillment→refund evidence; no duplicate
  reward/commission; independently reconciled funnel and privacy-safe cleanup.

### L07 — Merchant appearance controls

- **Scope/reference:** R2 plus September 8 Appearance; field-level missing surface:
  desktop/mobile copy/layout/position/spacing/visibility; homepage/URL exclusions;
  shape/icon; panel visitor/member copy, section order/default view; color roles,
  banners/icons and contrast. Existing `branding.ts` is only a basic subset.
- **Approach/subsystems:** expose existing loyalty-branding fields through shared
  merchant contracts/editor first. Then version and validate additional fields;
  update theme widget/landing projections and CSS from one shared contract.
  Embedded `/appearance` currently only exposes brand name/logo/accent.
- **Dependencies/decisions:** approve new contract/defaults, URL matching and
  numeric bounds before extending them; decide which artwork/custom stack-order
  options are genuinely required. Reuse Weletic artwork, not Smile icons/wallpapers.
- **Tests:** generation/revision conflict, foreign tenant, invalid color/URL/image,
  both device layouts, exclusions, inactive-program visibility, missing image,
  text expansion EN/JA/VI, contrast and keyboard focus at 375px.
- **DoD:** every field has editor/runtime/default/validation tests and browser
  evidence; unsupported optional appearance fields are explicitly dispositioned.

### L08 — Three nudges and campaign-prompt disposition

- **Scope/reference:** R3 and R5: signup, points spending, reward usage; separately
  documentation-described automatic campaign prompt. Full implementation not found.
- **Approach/subsystems:** shared revision-fenced editor and sanitized localized
  content; theme runtime eligibility evaluator using existing safe program/wallet
  projections. Reuse appearance; do not expose customer IDs in browser storage.
- **Dependencies/decisions:** before coding choose impression/dismissal TTL and
  storage, cross-tab/device scope, available-reward definition, cart-drawer support,
  and campaign-prompt inclusion/disablement. Smile's exact dismissal TTL is unknown.
- **Tests:** first/repeat visitor, guest/member cart, balance boundary, reward
  usage precedence, applied discount suppression, used/expired/unavailable reward,
  Gift Card/Store Credit/incremental exclusions, disabled state, navigation,
  storage unavailable, EN/JA/VI/375px/keyboard dismiss and focus restoration.
- **DoD:** approved behavior table, deterministic eligibility and no duplicate
  impressions per chosen policy; actual browser proof, not toggles alone.

### L09 — Complete shopper and merchant surface acceptance

- **Scope/reference:** R2 and September 8 surface inventory: launcher/drawer,
  landing, product points, account hub/profile, wallet/history, referral sharing/
  claim and eligible thank-you surfaces; all merchant editors also need E2 coverage.
- **Approach/subsystems:** test actual shared components and shipped theme assets,
  App Proxy/customer-account adapters and localized copy; preserve current APIs.
  Separate mocks, authenticated browser and live Shopify evidence.
- **Dependencies/decisions:** customer-account protected-data/network access (L17),
  public identity (L14), no Plus-only checkout reduction activation.
- **Tests:** EN/JA/VI at 375px and desktop, keyboard/focus/escape, screen-reader
  names, loading/empty/error/permission, stale authentication, long amounts/copy,
  responsive overflow, no shopper identifiers in DOM or issued reward codes in
  public program/Liquid projections. Codes belong only to the authorized member
  wallet or friend-claim result, not an unauthenticated program response.
- **DoD:** per-surface/state/locale evidence with named gaps; tonight's drawer
  fixture cannot certify all surfaces or public-app authentication.
- **Tonight's implementation:** fixed-amount home/redeem/confirmation/wallet/
  history and core loading/error/guest copy use EN/JA/VI. Merchant-configured
  names, titles and subtitles are not machine-translated. Full earning, VIP,
  referral and non-fixed reward descriptions, other surfaces and a merchant
  locale-content editor remain separate follow-ups under this task.

### L10 — Connect communications safely

- **Scope/reference:** R4 ten-entry inventory versus nine existing policies.
  PR #6/#8 merged; policy-to-delivery integration remains `not_connected`.
- **Approach/subsystems:** connect existing producers/outbox to immutable event
  and policy-revision evidence, trusted recipient/code/CTA/sender context, locale
  fallback, consent/suppression, pause controls, leased delivery, history, retry/
  dead letters and privacy cleanup. Existing expiry scheduler remains the sole
  points-expiry timing source; reward expiry needs its own validated timing policy.
- **Dependencies/decisions:** provider/sender and real-delivery approval; timezone;
  decide whether app-delivered friend invitations are required versus native share
  links. They are not implicitly authorized by adding a tenth template. Decide
  quiet hours/frequency/service-message categories and unresolved VIP notice rules.
- **Tests:** all journey variables/locales, markup/header rejection, immutable
  rendering after edits, missing recipient context, suppressed/unsubscribed/bounced
  recipients, late retry after erasure/reinstall, competing leases, provider timeout,
  native/Flow duplicate notice, zero duplicate expiry schedules.
- **DoD:** visible producer availability, durable idempotent sends, approved inbox
  evidence and suppression/reconciliation. Ambiguous provider acceptance never
  automatically resends through an alternate provider.

### L11 — Exact analytics, cohorts and report disposition

- **Scope/reference:** R6/S01–S36; PR #7 provides signed aggregates and exact CSV/
  JSON. Current status cohorts are not a sequential referral funnel; existing
  cohort analytics are not exposed in this screen.
- **Approach/subsystems:** extend `analytics.ts`, merchant analytics contracts/
  service/screen/export from immutable ledger/order/referral/tier events; expose
  validated cohorts and sequential steps with explicit denominators/time windows.
  Build a report-coverage map, not 36 presumed identical cloned reports.
- **Dependencies/decisions:** S01–S15 customer-level export equivalents need an
  explicit authorized privacy/field policy, separate from aggregate analytics.
  S20 proprietary peer benchmarks have no company-store data source: do not invent
  peers; choose company historical targets or explicitly omit that comparison.
  S35/S36 locked formulas remain unknown; Weletic's approved accounting definitions
  govern liability and issued-value reporting. No formula inferred from a title.
- **Tests:** independently recomputed SQL/exact exports, large integers, rational
  aggregate rounding, null versus zero, zero-cost ROI, currency mismatch, refunds,
  outstanding versus issued/used/unrecoverable value, unique revenue attribution,
  inclusive boundaries, repeated referral clicks and first/repeat cohorts,
  CSV injection, owner-only exports, foreign tenant/stale generation, EN/JA/VI.
- **DoD:** each S ID maps to implemented report + evidence, intentional product
  exclusion or named unknown/decision. No PII added to aggregate DOM; exact totals
  reconcile on named yamaxdev fixtures, not just mocked export downloads.

### L12 — Historical imports (frozen tonight)

- **Scope/reference:** generic opening balance/birthday/optional tier, no Smile
  migration. PR #13 draft provides immutable source/row provenance, preview,
  commit, durable orchestration, append-only rollback and containment.
- **Approach/subsystems:** after resumption, inspect preserved import source,
  rollback batch/row, outbox/privacy integration, merchant gateway and parser.
  Preserve 10MiB/50,000-row validation, immutable source bytes/normalized hashes,
  opening-balance-only ledger entries, existing coupons and backfill exclusion.
- **Failure evidence:** prior isolated 500-row commit/rollback completed in
  54,759/121,748ms respectively, with exact cleanup. Prior execution reported a
  50,000-row attempt timing out at approximately 30,046ms in initial source-proof
  queueing, before grouped rollback throughput was measured. The grouped change
  is not a proved 50,000-row optimization; do not extrapolate from 500 rows.
  Read-only EXPLAIN recorded source JSON discovery as a primary-index scan.
  These prior-run records are not reruns on tonight's public-main branch.
- **Dependencies/decisions:** shared-schema compatibility is unresolved; privacy
  paths query new tables even when imports are unused. Explicit merge/application
  authorization and safe schema rollout/compatibility strategy are required.
  Preserve the uncommitted bounded-rollback work and ADR; performance/index
  architecture must be approved before broadening it.
- **Tests:** authenticated full-file preview/commit/history/reconciliation/
  rollback in EN/JA/VI; 50k end-to-end on isolated guarded DB; populated-ledger
  query plans, competing stores, lease/reinstall/privacy races, interrupted
  recovery, subsequent balance/birthday/tier edits and exact cleanup.
- **DoD:** compatible schema rollout, full-scale real execution with independent
  SQL and bounded transaction/lease costs, then named live acceptance. No fabricated
  historic earns/referrals/coupons/entry rewards and no destructive rollback.

### L13 — Company-store approval

- **Scope/reference:** PR #5 supplies backend pending/active/suspended
  fences and the audited operator command; unknown-install
  provisioning and signed EN/JA/VI approval-status UI remain incomplete.
- **Approach/subsystems:** installation provisioning, store-access contract,
  signed status projection, operator audit, customer sync and all writer/worker
  entry points. Pending installs may do required auth/privacy only, not loyalty.
- **Dependencies/decisions:** September 9 follow-on approval covers PR #5 merge
  after revalidation and isolated port-3307 staging/test databases only. Shared/
  production application, operator activation and company-store mapping remain
  separate gates; never autoapprove an unknown install. See the
  [approval evidence](store-approval-implementation.md).
- **Tests:** unmapped new install, pending/suspended every writer and worker,
  approved promotion, revoked operator, concurrent suspension/reinstall, safe
  privacy handling and no customer sync before activation.
- **DoD:** approved schema rollout and named public install/approval/suspension
  evidence; passing isolated branch tests alone do not complete onboarding.

### L14 — Separate public registration and runtime

- **Scope/reference:** existing public registration Weletic Loyalty Reviews Dev;
  preserve old custom-app TOML and installation. No Smile counterpart required.
- **Approach/subsystems:** separate reviewed Shopify CLI config, canonical HTTPS
  app/callback/webhook/proxy endpoints, per-extension ownership/new public UIDs,
  isolated database/Redis/media/session/queue/secret namespaces and process env.
- **Dependencies/decisions:** explicit endpoint/identity/deployment approval;
  runtime namespace and installed canonical shop identity verified. Never copy
  custom-app UIDs, tokens, sessions or installation generations into public runtime.
- **Tests:** config/runtime scope alignment, ownership readback, isolated resource
  identity, fresh install/reinstall, token renewal, stale credentials/workers,
  cross-store access and privacy callbacks.
- **DoD:** named installed public app/version/generation and independent isolation
  evidence. CLI build success is neither deployment nor ownership proof.

### L15 — Shopify Flow triggers and authorized action

- **Scope/reference:** points-earned, VIP-changed, reward-redeemed, points-expiring,
  referral-completed trigger definitions; #10 referral producer merged. Public
  UID/publication/workflows and points-adjustment action remain unfinished.
- **Approach/subsystems:** same-transaction immutable outbox events, existing
  `flow-triggers.ts`/worker and extensions; typed bounded payloads with native
  customer/order references and exact event amounts/revisions where applicable.
  Capture event/run identity, store/install generation and privacy eligibility;
  sanitize optional fields and never send private auth/coupon tokens.
- **Dependencies/decisions:** L14/public publication and workflow execution gates.
  Hiro must choose audited revocable bounded automation authorization versus
  per-adjustment approval. A signed Flow callback is not an online staff session.
- **Tests:** one real workflow per trigger/action, enable/disable, duplicate run,
  recursive adjustment suppression, expired grant, wrong tenant/generation,
  immutable payload after policy edits, timeout/retry/dead letter, privacy races.
- **DoD:** public trigger readback and named workflow runs; idempotent authorized
  adjustment with audit and no uncontrolled recursive award. No action coding
  until authorization semantics are decided.

### L16 — Supervision, recovery and privacy

- **Scope/reference:** outbox, expiry, birthday, tier review, voucher, token renewal,
  privacy workers; no competitor implementation inferred from UI.
- **Approach/subsystems:** deploy approved isolated supervisors and bounded retry/
  dead-letter/stuck-job alerts, lease recovery/shutdown and kill-switch runbooks.
  Inventory export/erase/retain/suppress behavior for every new record/projection,
  including anonymous referral HMAC snapshot expiry and key retirement.
- **Dependencies/decisions:** approved runtime/deployment and operational alert
  destination; no real send to external services without authority. Preserve
  one-writer ownership, installation generation and current transaction locks.
- **Tests:** process crash before/after external acceptance, lease steal/stale
  worker, backoff exhaustion, suspend/reinstall, privacy UPDATE races and scans,
  anonymous retention/key retirement, shutdown, pause/resume and exact cleanup.
- **DoD:** named supervised runs, delivered approved alerts and rehearsed recovery/
  containment. Read-only SQL predicates do not prove UPDATE races or load costs.

### L17 — Capability and release gates

- **Scope/reference:** free limited-visibility public app for company stores;
  protected data/network, GraphQL-only least privilege, eligible stored value,
  listing/install/privacy/support requirements and later production rollout.
- **Approach/subsystems:** runtime/manifest scope audit (PR #12 fixes fallback
  `write_app_proxy`), native capability projection, customer-account access,
  install/reinstall/support/privacy evidence and release checklist. Keep unsupported
  Gift Card/Store Credit visibly unavailable; Basic discounts stay native.
- **Dependencies/decisions:** protected-data/network requests, public deployment,
  stored-value activation, listing submission and production cutover each require
  explicit approval. Resolve gift-card-product earning versus purchases paid with
  stored value, currency/subscription/remaining-value/refund rules. Old custom-app
  uninstall is a separate explicit approval after public gates pass.
- **Tests:** scope denial, unavailable capability and truthful UI, public auth/
  reinstall/privacy, permitted native discount checkout, stored-value settlement
  only where eligible; no bypass using draft/manual orders or real card charges.
- **DoD:** every applicable platform/live gate has named evidence; listing remains
  unsubmitted until core merchant/shopper/privacy/install journeys pass. No SaaS
  billing or public self-service onboarding is introduced.

### Q — Verification and completion evidence

- **Scope/reference:** G1–G5 and tonight's bounded target. No new API, schema,
  policy, delivery provider or authorization model tonight.
- **Approach/subsystems:** actual launcher/drawer/wallet with explicitly mocked
  transports; existing isolated earning/accounting suites. Fix only defects in
  existing contracts, add regression tests, review diff and publish verified work.
- **Dependencies/decisions:** reference disposition first; external live gates
  stay closed. Any newly required architecture change becomes a named follow-up.
- **Tests:** fixed reward selection/confirmation→wallet/history; guest/member,
  pending/available, insufficient points, duplicate submission, unavailable
  capability, expired auth, ambiguous response; EN/JA/VI at 375px, keyboard/private
  DOM. Focused tests, Prisma, formatting/lint, web/Shopify types/builds, CI and
  adversarial review; isolated MySQL only with exact environment/cleanup guards.
- **DoD:** append exact command/result/evidence class and mocked/live limits;
  report failed, skipped and pending checks. Green CI is not live acceptance.
  If CI is pending/red at 21:00, report an open PR, not shipped completion.

## Tonight's verification record

### Reference and scope evidence

- **REF-20260909:** benchmark R1–R6, 17:40–18:04 JST inspection, plus dated
  first-party documentation follow-ups. All six requested areas have a
  disposition; S01–S34 are included reports and S35–S36 are locked Finance
  reports, not observed formulas. The explicit unknown register is part of the
  specification, not permission to infer missing behavior. No Smile value was
  changed, saved, activated, sent or exported.
- **MAP-20260909:** 48 distinct A–G requirement IDs map to evidence or L00–L17/Q;
  all 17 loyalty workstreams have scope/reference, approach/subsystem,
  dependencies/decisions, tests and definition of done. Independent review
  corrected the stale import status and added the missing E1/E2 nudge mapping.

### Core implementation and local evidence

- **CORE-20260909:** actual theme assets, not a replacement UI. Corrected the
  first-load branding callback closing the drawer, modal naming/focus/Escape,
  private first-name greeting, missing confirmation, expired-auth state clearing,
  stale summary ordering and failed/uncertain redemption recovery. No gateway,
  schema, reward policy, backend accounting or provider changes.
- **BROWSER-CORE-20260909:** Chromium, 375×812, EN/JA/VI, actual tracked shared
  helper/widget/styles served by a loopback-only fixture. Guest and member,
  available 2,500 / pending 300, 1,000-point fixed JPY 500 confirmation/cancel,
  success to 1,500 and wallet/history; insufficient 999; pending submit;
  initial and redemption auth failure; generic unavailable rejection; lost
  response and same-key retry after explicit balance refresh; issuance with
  failed summary refresh. Guest runs make zero customer requests. No private
  fixture identity appears in the drawer DOM; document width remains 375px.
  Screenshots were inspected locally and are excluded from public Git.
  Keyboard-only Enter selection/confirmation, Tab/Shift+Tab wrapping,
  Escape cancellation/closure and focus restoration passed in all three locales.
  This is scoped keyboard/accessible-name evidence, not a full WCAG audit.
- **Transport limits:** browser fetches and issued codes are synthetic; the
  financial amount is fixture data. No real order, ledger mutation, Shopify
  authentication, discount creation, checkout usage or delivery occurred.
  Wallet/history render server-projected fixture entries, not live settlement.
- **UNIT-CORE-20260909:** 20 focused tests in `loyalty-widget-core.test.ts` pass
  at 18:49 JST; final three-suite rerun passed 56 tests at 18:53 JST. Includes both auth statuses, duplicate confirmation, preserved
  retry key, repeated refresh failure, latest-read failure and delayed older
  activity responses. Existing theme tests also cover exact incremental points
  above `MAX_SAFE_INTEGER`; they now confirm explicitly before submission.
- **Accounting boundary:** existing deterministic earning/reward/refund/purchase
  policy tests execute with mocked dependencies. No isolated MySQL race suite
  was run tonight: read-only discovery using the available local connection
  returned no accessible `weletic_loyalty_it_*` database. Existing application
  schemas/grants were not modified to bypass the guard. Provision/access and
  exact race/cleanup evidence remain L01–L06/L12/L16 and matrix G2 tasks.

### Release checks

- Prisma validation passed; existing relation-mode index warnings remain.
- Root lint passed (10 tasks); Shopify typecheck and local CLI app/extension
  build passed. No deploy or extension ownership claim follows from the build.
- Web typecheck passed with the standard 8 GiB heap after regenerating the
  public-main Prisma client and running separately from Next's generated-type
  writes. Initial attempts exposed the default heap limit, an import-generated
  client mismatch and concurrent build-file churn; none were suppressed.
- Web production build passed, including all 367 generated pages. Static
  generation read the existing guarded isolated local development database;
  external transport credentials were disabled. The first build's CI fixture
  database credential was correctly rejected by the secured local server;
  no account was unlocked or grant changed. No build error was suppressed.
- Independent review found and resolved the auth and summary-ordering races;
  the final narrow fence review has no remaining blocker. Main-agent diff/PII
  review and 48/48 requirement mapping checks passed.
- The final deterministic suite passed at 19:02 JST: all 7 tasks successful,
  including 367 web test files with 5,648 passing tests and 6 existing skips;
  Shopify app and Function suites also passed. Final repository formatting
  passed. Public Fast Quality Gate and merge status must be recorded in the
  associated public PR before merge; this local record is not CI evidence.
- Full loyalty completion remains open. No new named yamaxdev live acceptance,
  deployment, real email/order/redemption or shared schema application exists.
