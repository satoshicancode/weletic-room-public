# Referral communications — next implementation scope

## Public integration update — September 13, 2026

[PR #30](https://github.com/satoshicancode/weletic-room-public/pull/30) merged as
`c5f2b8fa8fb06bfb3bad6e539c7ee9cf561d54dc`. Earlier draft/publication statements
below are chronological checkpoints, not current PR status. The merged source
connects account-backed benefit producers and shared retained delivery; anonymous
friend policy delivery still requires its separate consent/retention decision.
Full qualification/coupon races, real inbox delivery and launch acceptance remain
open. Do not create a second producer because an older paragraph says draft.

## Historical implementation record

This is the next part of the approved L06/L10 loyalty stream, not evidence of
completion or authorization to send mail. Its worktree now starts from public
main `a1a7bb0d7736c2e534d9b9fed7a659a3b6e94645`, after the verified redemption
integration merged in [PR #29](https://github.com/satoshicancode/weletic-room-public/pull/29).
Dependencies were installed from the frozen lockfile/local cache and this
worktree's Prisma client was generated without applying a database schema.
The local draft now includes strict account-backed benefit origins, receipt-key
construction, an installation-generation fence, points/coupon benefit contracts,
current-source checks, a transaction-side producer and shared sender/retained
retry support. Account-backed qualification and advocate qualification after a
preissued friend order now capture the original side-specific evidence and invoke
the producer for winning points receipts. Coupon issuance invokes it only after
the winning issued transition. This is local integration, not live acceptance;
anonymous friend policy delivery and merchant readiness remain unchanged.

### Local foundation evidence — September 13

- 52 focused Vitest tests pass for origin parsing, exact integer points, coupon
  snapshot identity, receipt key separation, legacy suppression and generation
  fencing. Operational admission is mocked in these tests; they do not prove
  a database race or live Shopify behavior.
- Focused ESLint passes. An independent read-only adversarial review found no
  foundation blocker. Full integration verification remains outstanding.
- Initial full web typecheck failed because this new worktree had not built
  workspace dependency declarations (`@dub/ui`, `@dub/utils`). After the
  CI-equivalent dependency build, both the foundation and receipt/source versions
  passed full web typecheck. Producer/sender expansion exposed a missing typed
  policy-journey allowance and Prisma configured-omit client compatibility;
  both were corrected, and the fresh full web typecheck passed.
- Independent receipt review found a coupon identity gap; it is fixed by
  checking the unchanged canonical economic key, exact coupon code/canonical
  code, ownership fields and authoritative qualification snapshot. The extracted
  key helper preserves existing encoding and its original export. Receipt/source
  and existing coupon tests pass (119 tests); a follow-up review found no blocker.
- Producer/sender tests pass (110 tests at that checkpoint), including both sides
  and both benefit kinds in EN/JA/VI with mocked rendering/provider. Expanded
  retention tests pass (45 tests), checking requalification, reversal, privacy,
  consent and exact-byte reuse. These overlap suites, not additive totals.
- An initial retention assertion expected a different error string; the source
  correctly rejected the request. The test now verifies the typed ineligibility
  error. No live email or Shopify order/redemption was created.
- Combined verification of eight focused suites passes: **289 tests**. The
  producer and shared sender/retention changes also received independent review
  without a blocker. Full unit/build/CI and isolated SQL integration are not yet
  complete for this branch; nothing from this draft has been published.
- As with existing points notices, the program's points label and branding are
  read before first preparation, then frozen in the retained encrypted request.
  Policy wording and financial amount come from immutable event evidence; this
  is not a claim that the display label is frozen at qualification time.
- The generation fence requires the caller's store/program lock. A null origin
  means no notification authority, not permission to fill historical metadata.
  Typed origin errors must survive caller compensation and marker cleanup.
- Connected caller verification passed 99 tests across four suites, including
  legacy null-generation awards without new notices and real producer invocation
  from mocked receipt transactions. Full web typecheck and focused lint passed
  at that checkpoint. These are synthetic transport/database fixtures, not live
  Shopify or MySQL concurrency evidence.
- Independent review found a reinstall race between coupon issuance and the
  separate referral-completion transaction. Completion now revalidates original
  side provenance and the exact fulfilled reservation before mutation or Flow.
  The coupon suite passes 44 tests, including G1 issuance followed by G2 reinstall
  at a mocked transaction boundary, and missing reservation provenance. Both
  block completion without cancelling the already issued coupon. Actual coupon
  account/store ownership is also checked independently of copied provenance;
  the foreign-owner regression passes. Follow-up review found no blocker.
- Broader caller verification initially failed 19 of 281 tests. Review identified
  legacy lock/account fixtures and cascading queued mocks. After fixture-only
  repairs, all 281 tests pass without weakening runtime ownership checks. A fresh
  connected four-suite run passes 102 tests, and seven communication suites pass
  251 tests. Full web typecheck passes after removing duplicate fixture fields.
- Isolated MySQL communication checks pass **41 tests**, including three new
  referral ledger/producer cases: concurrent receipt replay produces one notice,
  rollback removes both ledger and notice, and fresh outer installation authority
  cannot reuse stale referral provenance. This does not prove full qualification,
  coupon remote-issuance races, distributed locking or live delivery. The fresh
  loopback-3307 fixture `weletic_loyalty_it_communications_referral_20260913`
  reconciled all 157 tables empty after execution; temporary grants were revoked.
- Source-frozen full unit execution initially reported 31 failures: missing
  synthetic Shopify app identity caused session-scope failures and cascading
  mocks; one timing assertion also exceeded its 50 ms budget under concurrent
  builds. The source-frozen CI-identity rerun with two workers passes all 490
  files: **7,914 passed, six skipped**. No runtime fallback or
  timing assertion was weakened. Shopify typecheck/build, focused lint, formatting
  and explicit `prisma validate --schema prisma/schema` pass. Full web build
  passes with SELECT-only privileges on the isolated empty fixture; all 367
  static pages were generated. Temporary privileges were revoked and independent
  SQL again confirmed all 157 tables empty. Build warnings include existing CSS,
  browser-data and unconfigured optional provider warnings. This is not a
  deployed runtime or production database. Public CI remains pending publication.

### Next integration checkpoints

1. In the existing qualification transaction, persist side-specific origins
   only after winning the qualification claim. Bind each coupon origin to the
   already constructed reward snapshot, and each points origin to the exact
   awarded integer amount. Never replace origins on replay.
2. Validate points receipts against the actual winning ledger row: store,
   account, referral/order metadata, EARN_REFERRAL type, qualification path and
   exact positive delta. Copy no other party's account identifier into the
   communication event. Snapshot the policy and enqueue in the same transaction.
3. Fence coupon origins before remote preparation, dispatch and adoption, and
   again in finalization/cleanup. Emit only for the winning provisioning-to-issued
   transition, with the owned redemption and original reward snapshot digest.
   A zero-row transition or whole-referral completion is not an issuance receipt.
4. Verify delivery and retained retries against current privacy/admission and
   original receipt ownership. Suppress clawed-back points and cancelled or
   expired coupons; test requalification on a different order independently.
5. Keep anonymous friend delivery separate until its consent and encrypted
   recipient-retention decision is resolved. Do not introduce a second sender,
   invented account or new provider idempotency key on ambiguous retry.

Checkpoints 1–4 are implemented locally with focused contract tests, full unit
regression/build and bounded MySQL producer evidence. Full qualification/coupon
race coverage, public CI and named acceptance remain open; merchant readiness
does not change. Checkpoint 5 remains a separate
unresolved consent/retention decision. Named live
store and inbox evidence remains a separate acceptance gate.

## Outcomes and boundaries

Connect both existing `referral_friend` and `referral_advocate` policy journeys
to actual awarded benefits, covering points and coupons across account-backed
and preissued-friend-claim paths. Do not label points-only wiring as complete
referral parity. An invitation to an unclaimed friend is a separate, unresolved
product decision; this work must not add unsolicited invitations or a tenth
journey implicitly.

## Current source evidence

- `referrals.ts` qualifies an account-backed referral with an atomic status claim,
  writes side-specific EARN_REFERRAL ledger entries and/or immutable coupon jobs,
  and produces Flow events. The new same-transaction benefit producer snapshots
  the communications policy for genuinely new points receipts.
- `referral-friend-claim.ts` issues and emails a prequalification friend coupon
  through its own lease path. First-order qualification separately rewards the
  advocate with points or a coupon. These are different occurrence times and
  must not be collapsed into one qualification email.
- `referral-coupon.ts:completeReferralWhenCouponsAreFulfilled` checks required
  coupon sides, transitions qualified to rewarded and produces a completion
  Flow event. Account-side benefit delivery may precede whole-referral completion.
- `communications-contract.ts` already allows friend reward name/value and
  advocate reward name/points/points label. Recipient, coupon code and CTA are
  intentionally not merchant-controlled template variables.
- The generic communication sender/retention path assumes an account-backed
  recipient. An anonymous friend claim cannot simply be given an invented
  account or passed through that assumption.

### Reference-to-code gaps confirmed September 13

The preserved Smile R4 reference distinguishes advocate completion after friend
qualification, friend reward confirmation, and a separate member-initiated
invitation. It does not authorize treating all three as one email.

| Path                                  | Current authoritative receipt                                                          | Remaining integration                                                                                           |
| ------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Account-backed points, either side    | Winning EARN_REFERRAL ledger entry in `referrals.ts`                                   | Local policy/source/retention integration implemented; SQL races, full regression and live delivery outstanding |
| Account-backed coupon, either side    | Owned issued redemption in `referral-coupon.ts`                                        | Local confirmed-issuance producer implemented; SQL races, full regression and live delivery outstanding         |
| Anonymous friend's preissued coupon   | `friendRewardProvisionedAt` plus verified owned discount in `referral-friend-claim.ts` | Integrate existing claim email with policy snapshot, immutable retry content and locale without a second sender |
| Advocate after preissued friend order | Winning EARN_REFERRAL ledger or advocate coupon in `referral-friend-claim.ts`          | Local advocate producer connected; same outstanding verification gates, no duplicate friend email               |

The existing friend sender uses an English subject, an English/UTC expiry label,
current merchant appearance and a stable referral-level provider key. Its lease
tracks attempts and sanitized errors; it does not retain immutable rendered
policy content. These are concrete EN/JA/VI and retry gaps, not proof that policy
integration is already connected. Claim-time receipt generation, privacy
evidence and exact provider payload must be reviewed together before edits.

## Contract and implementation approach

1. Record immutable generation and policy provenance at each genuinely new
   reward origin. Preserve legacy behavior without manufacturing historical
   notification events or adopting today's policy on replay.
2. For points, use the winning ledger award and immutable side/referral/order
   identity. For coupons, use confirmed owned coupon issuance, not merely the
   queued provision job. Preserve independent side idempotency and recorded
   occurrence time; do not key notifications by mutable policy revision.
3. Snapshot reward display terms and the appropriate policy in the same fenced
   transaction as the authoritative benefit receipt. Queue failure must roll
   back the local receipt; ambiguous remote coupon issuance must retain its
   existing reconciliation semantics and never duplicate financial value.
4. Recheck current source ownership, active generation/program, award/coupon
   status and clawback before initial and retained delivery. Retained retries
   reuse the encrypted request and provider idempotency key.
5. Reconcile the preissued friend email with the existing claim consent, privacy
   snapshot, lease and trusted coupon destination. Do not introduce a second
   competing sender. First document whether existing claim authorization is
   sufficient for the exact requested fulfillment message; any expansion to
   invitations/marketing or recipient storage requires an explicit decision.
6. Update signed merchant readiness and EN/JA/VI descriptions truthfully for
   each connected path. Keep absent recipient/capability states visibly gated.

### Review requirements before coding

- Qualification identity includes order, installation generation and side;
  referral ID alone is not a notification key. Genuine requalification must
  neither reuse an old receipt nor be suppressed by a prior award's key.
- Points use their winning ledger entry; coupons use each side's actual
  issuance transition. Whole-referral `rewardedAt` is not either side's receipt.
- Capture coupon installation origin before remote dispatch, not from recovery
  credentials. Preserve stale-origin errors through cleanup and compensation.
  Capture communication content at the authoritative benefit receipt, and never
  manufacture a historical event when a policy is enabled later.
- The anonymous email lease currently lacks an independent installation,
  program/admission and privacy fence. Initial and retried delivery need those
  checks, owner-token compare-and-swap and privacy-safe cleanup.
- Retain the exact encrypted recipient, code, trusted CTA and rendered payload
  before dispatch. Provider retry-window exhaustion requires reconciliation,
  not a replacement key or alternate sender that might deliver twice.
- Bind anonymous fulfillment to the exact claimed recipient digest and owned
  voucher. Erasure must scrub retained ciphertext. Never copy the other party's
  identifiers into a communication event or shopper DOM.

Independent review found the account-backed plan compatible with the current
architecture. Anonymous consent classification and expanded recipient retention
remain explicit gates; existing claim fulfillment is not invitation authority.

## Affected subsystems and tests

Referral qualification, friend-claim fulfillment, coupon finalization/recovery,
communication policy/event union, sender and retained request, privacy cleanup,
merchant readiness and targeted tests. Prefer existing JSON provenance/outbox
contracts; no new public write API or provider. A new persistent schema or
authorization model is not covered by this plan.

Tests must cover both sides, each supported reward kind, preissued versus
postqualification events, winning/replayed/concurrent qualification, half-complete
coupons, ambiguous issuance, rollback, reinstalls, pending/suspended stores,
null/foreign accounts, refunded/clawed-back benefits, erasure/tombstone races,
policy edits/disabling, consent/pause, retained provider retry and EN/JA/VI output.
Add actual isolated SQL transaction/lease evidence and exact fixture cleanup;
label mocked provider/Shopify tests and require named authorized yamaxdev/inbox
acceptance before checking live completion.

## Dependencies and open decisions

Provider/sender and real-delivery authority; app-delivered invitations versus
native sharing; service-message/marketing consent classification and any change
to anonymous recipient retention; quiet hours/frequency. Do not resolve these
by quietly choosing whatever passes existing tests. Local implementation can
proceed on already-approved reward-confirmation contracts, but unavailable
paths must remain explicitly outstanding until their required decisions pass.
