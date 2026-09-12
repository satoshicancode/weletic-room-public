# Reward-expiry communications — implementation in progress

## Public integration update — September 13, 2026

[PR #31](https://github.com/satoshicancode/weletic-room-public/pull/31) merged as
`979c8f9786b44eb889ae3ecab81ac1ba6a7a9620`. The draft/publication statements below
are historical checkpoints. Supported discount reminders and the bounded
authenticated scheduler are integrated code; deployed supervision, timezone
decisions, real delivery and named live acceptance remain open. This update
neither enables a policy nor authorizes deployment or email sends.

## Latest checkpoint — September 13, 2026

The local draft now includes a strict `reward_expiry_due` event for ordinary
discount redemptions and account-backed referral coupons, a current database
receipt loader, a fresh Shopify lookup path, and integration with the shared
sender and encrypted retained-delivery path. The detailed prerequisite entries
below are chronological; their earlier “no sender integration” status is
superseded by this draft. A bounded producer/scheduler is now connected to the
existing authenticated outbox cron route. There is still **no public PR**,
deployment, real email or completed launch gate for this work.

- The reminder binds store/program/account, original installation generation,
  original issuance and expiry, receipt evidence and a digest of the actual
  remote artifact/code. No raw code, remote ID or recipient is copied to the event.
  Deduplication excludes policy edits and retry timestamps.
- Current source validation rejects used, cancelled, expired, quarantined,
  compensated, replaced and foreign receipts. Referral coupons additionally
  recheck their original qualification/order and immutable snapshots.
- A new read-only remote check resolves exact-store credentials, fences the
  original generation before/after resolution and after lookup, and compares
  the exact code, remote ID/title, customer-selection digest, original expiry,
  discount value, purchase eligibility, limits, combinations and targeting.
  Unknown lookup status is no longer interpreted as `ACTIVE`. Missing or changed
  observations suppress delivery; transport/auth failures use the existing retry
  path. No discount is created, edited or deactivated by the reminder.
- Shopify documents that [the redeem-code usage counter](https://shopify.dev/docs/api/admin-graphql/latest/objects/DiscountRedeemCode)
  is updated asynchronously. A zero counter is not an atomic checkout guarantee.
  Fresh remote comparison complements local usage/refund checks and settlement
  locks; it does not eliminate remote checkout/edit races.
- The shared sender renders existing EN/JA/VI policies and reuses encrypted
  rendered content on retry. Current policy/consent/privacy and local source checks
  remain required. UTC date formatting matches the existing expiry sender; the
  merchant-timezone release gap remains open.
- Review identified a lock-wait/rendering expiry race. Production time is now
  refreshed inside retention and after rendering, with a final expiry check just
  before provider dispatch. Fake-clock regressions cover all three boundaries.
- The scheduler uses a generation-scoped per-program metadata cursor and gives
  up to five least-recently-scanned programs turns of at most ten receipts each.
  Invalid/already-queued rows do not stop progress; the cursor wraps after the
  keyspace ends. Queue insertion and cursor progress commit together. A failed
  transaction retains its retry cursor and separately records its scan turn.
  No schema, Redis namespace, provider or financial mutation was added.
- The existing `withCron` authentication remains unchanged. Unsigned GET/POST
  requests are rejected under enforced authentication before any sweep or worker
  executes. Cloudflare deployment still must configure enforced cron auth and
  supervision; local route tests are not deployed scheduling evidence.

Eleven focused suites passed (407 tests) before the final timing regressions;
the four integration-focused suites then passed (136 tests), including the three
new timing cases. Independent re-review confirmed the timing blocker resolved
and separately passed all 111 sender/retention tests. Final full web typecheck and
focused lint pass. The first full unit invocation stopped in an unrelated legacy
discount test because the shell lacked CI's synthetic Shopify app identity;
the failing suite passes all 37 tests with the existing quality workflow's fake
Shopify environment. A second full run found an outdated adversarial saga fixture
that lacked the persisted receipt/admission state now validated even with email
disabled. The fixture now models actual persistence; all 12 saga tests pass.
The full regression is rerunning with the CI-equivalent synthetic values,
without changing runtime secrets or CI configuration.
Its next pass exposed the same incomplete persistence model in the older
`loyalty-real-concurrency` harness: missing admission state, redemption lookup,
nullable defaults, ledger creation time and metadata CAS. Those mocks now model
the persisted receipt instead of bypassing its validation. The seven concurrency
tests and eight cron tests pass together. The next full run completed with
**7,993 passed, 6 skipped and one failed** cross-feature redemption case. That
last fixture also lacked persisted receipt/default/CAS state and cancelled a
hard-coded ID instead of the actual generated redemption. Corrected fixture
tests pass (5), with an additional assertion for pending durable remote cleanup.
No receipt validation or accounting assertion was bypassed. The fresh full run
passed **7,997 tests with 6 skipped across all 496 suites**. Both read-only isolated database-backed web builds passed, including
the latest merchant-editor changes, type validation and all 367 static pages.
Temporary grants were revoked and all 157 fixture tables independently empty
after each build. Shopify app typecheck/build, focused ESLint and Prisma schema
validation pass. Prisma validation used a synthetic URL and applied no schema.
No public CI result exists yet for this branch.

The isolated MySQL scheduler run passed **46 tests**, including seven-store
rotation, malformed/future checkpoints, progress past invalid receipts,
concurrent sweeps without duplicate jobs, and queue-failure rollback preserving
the retry cursor. Independent SQL found all 157 fixture tables empty afterward;
temporary fixture privileges were revoked. Independent read-only review found
no new blocker and reran all **22 producer/scheduler/cron tests** successfully.
The expanded SQL suite then passed **50 tests**, adding encrypted retained retry
and rejection after use, exact expiry, reinstall or suspension. Again all 157
fixture tables were independently empty and temporary privileges revoked. These
are local receipt/retention checks, not Shopify transport or provider execution.
The latest SQL revision passed **56 tests** and adds an account-backed advocate coupon with a
distinct referee shopper/account and the referee's qualifying paid order. It
tests encrypted retry and suppression after use, expiry, reinstall, suspension,
full order refund and referral cancellation. Independent review caught and
corrected an initial fixture that wrongly attributed the order to the advocate.
All 157 fixture tables were independently empty and temporary privileges revoked
after both the build and the expanded SQL run.
The fixture represents confirmed receipt consumption, not qualification/issuance
engine execution or a live Shopify coupon.

The EN/JA/VI merchant editor now exposes explicit reward-expiry readiness through
an additive integration-state value. Copy identifies 72-hour timing, UTC display,
consent/sender/worker requirements and stored-value/anonymous-coupon exclusions.
Older backend states still show reward-expiry delivery as disconnected. The
editor/contract suites pass all 46 tests. Independent review passed 51 tests across
the editor/contract and corrected cross-feature suites without finding a blocker.

### Local browser checkpoint — September 13, 2026

Playwright drove Chromium against the actual shared `CommunicationsScreen` and
Shopify-app `customers.css`, bundled into a loopback-only synthetic fixture.
EN/JA/VI editor copy and message-language controls were inspected at 375×812.
Document width remained 375px, and neither synthetic store ID nor installation
generation appeared in the DOM. A Japanese screenshot was visually inspected.
Vietnamese subject editing locked journey switching while dirty; Tab navigation
reached Save and Enter completed the mocked save with the localized no-email
status. English read-only reward-expiry controls were disabled; a never-resolving
transport showed loading with no editable form, and a rejected transport showed
an alert with reload available. These are bounded local layout/interaction checks,
not full accessibility certification, embedded Shopify authentication, backend
save or live delivery evidence. The fixture's initial missing favicon was a 404,
not a component exception. Browser and loopback server were stopped afterward.

Private local screenshots/snapshots remain outside the public repository in
`/tmp/weletic-reward-expiry-browser.m9eSIN`; only normalized observations are
retained here. No Shopify account, customer or external sender was accessed.

Next: finish full quality gates and public PR. Gift Card/Store Credit authoritative balance/expiry,
anonymous friend consent, and named live delivery remain explicitly unproven.

This continues approved L10, not a launch or delivery claim. The preserved Smile
benchmark specifies a reminder three days before reward expiry and no timing
editor. Existing `reward_expiry` templates support EN/JA/VI, reward name and date,
and now have a local reminder producer. Financial expiry/recovery is not a reminder.

The first local contract uses an elapsed 72-hour interval before the authoritative
expiry instant. A late-issued short-lived reward or delayed sweep can catch up
only after confirmed issuance and strictly before expiry. This is a Weletic
implementation choice, not observed Smile short-lived/catch-up behavior, and does
not choose a new merchant display timezone. Missing or invalid issuance/expiry
evidence fails closed. The contract alone cannot authorize an email.

## Remaining implementation and evidence

- Strict immutable reminder event: tenant/account/original installation, actual
  benefit receipt, original expiry and policy revision. No raw recipient or code.
- Bounded scheduler: re-read eligibility under store/program locks; snapshot the
  enabled reminder policy when due, and use a receipt/expiry/generation key that
  is independent of content edits and retry attempts. Prove pagination progress
  past already queued or rejected rows and fairness across stores.
- Ordinary redemptions and account-backed referral coupons both need authoritative
  receipt/source handling. Do not label ordinary-redemption-only coverage full
  reward-expiry completion. Missing legacy provenance is not backfilled.
- Anonymous friend delivery retains its separate consent/encrypted-retention
  decision; never invent an account or a second sender. Gift Card/Store Credit
  usable balance and authoritative expiry need capability/receipt proof, not an
  inference from an internal timestamp. Explicitly unavailable paths stay visible.
- Shared sender/retention: current privacy, consent, active program/store, unused
  reward, unchanged ownership/expiry and original generation at first preparation
  and retry; exact rendered content retained thereafter. Used, cancelled,
  expired, quarantined or unproven rewards are suppressed.
- Integrate only through the existing signed internal cron/outbox boundary; no
  new public writes, schema, provider, financial compensation or deployment.
- Test exact timing, replay, downtime, page fairness, policy edits, reinstall,
  tenant ownership, privacy/consent, mixed receipt kinds/capabilities, immutable
  retries and EN/JA/VI. Add isolated MySQL queue uniqueness/rollback/race evidence,
  full local verification and public CI, then separately authorized named live
  delivery. Full completion remains unproven until all applicable gates pass.

The branch now tracks public main `c5f2b8fa8fb06bfb3bad6e539c7ee9cf561d54dc`,
after [PR #30](https://github.com/satoshicancode/weletic-room-public/pull/30)
merged its account-backed referral receipt contracts. Timing tests pass (16),
as do focused lint and standalone strict typecheck; these do not constitute
full worktree verification or delivery integration.
The local draft now also extracts policy-independent ordinary redemption receipt
validation without changing the existing redemption-notice event shape. The
winning issuance producer CAS-retains `rewardCommunicationIssuedAt` after
economic/generation validation, including when the redemption email is disabled.
A later attempt cannot replace the original time. This is new receipt evidence
for future expiry eligibility, not a historical backfill or expiry producer.

Independent read-only review found no blocker in this prerequisite. Five focused
suites pass (193 tests), including current discount/financial saga paths. A
credential-boundary fixture now reflects the persisted redemption/debit because
disabled email no longer skips receipt validation. An initial test run could not
resolve unbuilt workspace dependencies; after the CI-equivalent dependency build
the focused suites passed. The initial full typecheck exhausted the default heap;
the rerun passed using CI's explicit 8 GiB limit.
Isolated MySQL checks pass (43 tests), including disabled-email timestamp capture,
non-winning replay preservation and transactional rollback. The fresh fixture
`weletic_loyalty_it_communications_rewardexpiry_20260913` on loopback port 3307
reconciled all 157 tables empty, and temporary privileges were revoked. No scheduler,
expiry sender integration, full feature verification or live activity has been
performed. PR #30's separate post-merge CI passed on public main.

The referral receipt validator is now also independent of notification policy.
Existing referral notices still require the original policy tenant and journey
checks and retain their event shape. The reusable evidence schema excludes policy
fields and still validates side-specific origin, qualification, receipt ownership,
snapshot digest, exact points and issuance time. Callers supply accepted coupon
statuses: expiry eligibility must exclude `used`, even though an existing benefit
notice can validate retained evidence after usage. Two focused suites pass (81
tests), including policy-free projection, stale-generation rejection and unused
coupon filtering. This is still a receipt prerequisite, not a reminder event,
scheduler, send authorization or completed expiry feature.

After the referral extraction, the combined seven focused suites pass (274 tests),
full web typecheck passes with the CI-equivalent 8 GiB heap, focused lint passes,
and `git diff --check` passes. Independent read-only review found no blocker and
separately passed all 63 referral contract tests. These changes remain local and
unpublished; no new PR, deployment, real redemption or email was performed.
