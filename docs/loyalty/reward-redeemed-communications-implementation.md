# Reward-redeemed communications — local implementation

Approved loyalty communications stream, September 12, 2026. Base is public main
`a3d8c28422281ea550bda6913dd72fb38d07edb9`. No deployment, activation, schema
application, provider change or real send is authorized by this implementation.

## Current disposition

Local implementation and adversarial review are complete. The final Next build,
web typecheck, focused lint/formatting, 19 financial-saga tests and 38 isolated
MySQL communication tests passed. Database checks use synthetic issuance, not
real Shopify fulfillment; browser checks use the actual shared component with
an in-memory transport. All temporary database grants from completed checks
were revoked and all 157 fixture tables independently verified empty.

The frozen-source full regression run passed: **485 files, 7,743 tests passed and
six skipped**, with no failures. The modified/new source digest was unchanged
before and after execution. This change is ready for publication, but is not yet
merged, deployed or live accepted. The chronological checkpoints below retain
failures and their corrections; they do not override this status.

## Contract and integration plan

- Announce confirmed issuance, not the earlier reserved debit. Follow the
  existing reward-redeemed Flow transition semantics for ordinary discount,
  recovery/healing and financial issuance paths. Existing issued/terminal replay
  must not manufacture a new event or adopt a newly enabled policy.
- In the winning provisioning-to-issued transaction, capture one policy revision
  and immutable event: store/program/account/generation, redemption/debit identity,
  exact points spent, verified provisioning digest and reward display terms.
  Persist occurrence time in that event; never reconstruct it from mutable
  redemption `updatedAt`. Outbox failure rolls back the transition.
- No recipient, code, URL, remote artifact ID or customer selection digest in
  the event. Direct referral awards are a different journey and are excluded.
- Use the existing leased communication worker, consent, pause, current policy,
  privacy and generation fences, and encrypted retained provider request. Retry
  must not rerender or choose a different template/recipient.
- Recheck immutable debit/provisioning ownership at first send and retained retry.
  A later legitimate active/used status is not a new issuance and must not cause
  a duplicate event. Cancelled, failed, expired or quarantined rewards and
  compensation require explicit suppression. The constructor's issued-only
  requirement is for event creation, not a substitute for delivery source checks.
- Render all six supported reward types from captured terms: exact monetary
  amount with currency, percentage with percent sign, and localized shipping/
  product labels without invented monetary value. Use EN/JA/VI templates and
  trusted account/wallet destinations, not codes or links in merchant variables.

Affected subsystems: redemption contract/producer, `saga.ts`,
`financial-reward-saga.ts`, communication outbox union, notification sender,
retained-request/source verification, merchant readiness and tests. No new
database table, external provider, public write API or authorization model.
Upgrade strict readers before enabling new event producers in any later rollout.

## September 13 local checkpoint — integrated draft, unpublished

The producer is now called from winning ordinary, financial and recovery
issuance transitions. The shared job union, delivery source checks, retained
retry checks and EN/JA/VI merchant readiness copy include the new source.
This is local code, not a deployed or live-accepted communication journey.

Fresh reservations capture an immutable generation-bound origin in existing
metadata. Legacy reservations do not receive a backfilled origin or notification.
Origin checks precede preparation markers and remote dispatch. Review found
that rejection could otherwise enter ordinary compensation or financial marker
cleanup; typed read-only deferral now bypasses both paths. Ordinary regression
uses the actual saga with mocked database/transport; financial regressions
inject rejection at the second origin fence. Neither is a real database race.

The contract/source/origin and ordinary saga suites passed 137 synthetic tests.
Another 25 tests passed for exact USD/JPY/KWD and greater-than-safe-integer
amounts, percentages, invalid values and localized nonmonetary labels.
An 8 GiB web typecheck passed after regenerating this checkout's own Prisma
client and fixing the reservation mock. A broader rerun covering the latest
financial deferral changes is pending. No production memory or database limit
changed; the separate running import checkout remains untouched.

The subsequent eight-suite rerun passed 262 tests, including both financial
pre-dispatch rejection cases. Web typecheck with an 8 GiB heap and focused
ESLint for the reward communication modules, saga changes and related tests
also passed. No full build, CI, database concurrency or real delivery result
is claimed here.

## Additional September 13 verification

- Enabled-policy producer coverage uses the real policy snapshot and strict job
  reader with mocked scoped database delegates and queue. All six reward types,
  replay, disabled/missing policy, foreign ownership, stale generation, privacy,
  corrupt evidence and queue failure are covered.
- Sender coverage prepares captured EN/JA/VI redemption subjects and suppresses
  cancelled/failed/expired/refunded sources. Rendering and provider transport are
  mocked; this does not prove actual email HTML or inbox delivery.
- Retained-request coverage encrypts and reuses the original request after used
  progression, and rejects cancellation, refund, disabled policy or withdrawn
  consent at both initial admission and retry. Database fences remain mocked.
- A financial saga test proves a communication enqueue failure after Store Credit
  dispatch preserves the earlier preparation marker and does not dispatch Store
  Credit again on replay. It models local rollback with persisted marker input;
  actual transactional rollback still needs isolated MySQL evidence.

The combined nine-suite run passed 297 synthetic tests. Web typecheck and focused
lint passed for the test additions. Independent review found no blocking issue
in these tests and confirmed their mocked-database/rendering limitations.

## Required before merge or completion

### Isolated MySQL result — September 13

The expanded communication database suite passed **38 tests** in
`127.0.0.1:3307/weletic_loyalty_it_communications_redemption_20260913`.
The guarded runner verified the approved instance UUID, created only this fresh
schema from the current Prisma model, and granted temporary DML privileges.
Independent SQL reconciled **all 157 tables to zero** after the test, and the
temporary grant was revoked. The 3308 import instance was not used.

This proves the tested real producer/SQL transaction boundaries: one notification
under competing issuance transitions, rollback of issuance plus notification with
the exact original ledger preserved, and read-only rejection after generation,
suspension or redaction changes. Issuance is synthetic; these are not live Shopify
saga, email transport, Redis lock or end-to-end installation acceptance results.
The separate SELECT-only Next production build passed. Its temporary grant was
revoked and independent SQL again verified all 157 tables empty. This build
predates the final financial cleanup fix below; a fresh build is running.

### Broader verification in progress

- Shopify app typecheck and Remix client/server build passed. The build emitted
  non-fatal source-map/deprecation warnings. This is a local Node build, not
  proof of the still-undecided Cloudflare runtime topology.
- A full web unit run and Next production build were started. The production
  build uses a cleared environment, synthetic placeholders and loopback port 1
  service endpoints; it cannot establish deployed-service compatibility.
- That web build passed bundle compilation and proceeded through lint/type
  validation, then failed collecting page data because existing program-page
  `generateStaticParams` queries require Prisma database access. The terminal
  failure names `/partners.dub.co/[programSlug]/apply/success` and unreachable
  `127.0.0.1:1`; it is not a successful full build. Do not remove static-data
  queries or borrow the busy import fixture to bypass this requirement.
- The redundant standalone typecheck was deliberately terminated after the
  machine reached approximately 28 GiB swap use and the build entered its own
  type-validation stage. Its cancelled result is not a pass. Do not run these
  two memory-heavy checks concurrently on the next verification attempt.
- The first full unit attempt stopped with 895 passed and one failed test:
  `archived-disabled-discount-codes.test.ts` reached the app-identity guard with
  no `SHOPIFY_API_KEY`. Rechecking that suite with CI's synthetic Shopify
  identity passed all 37 tests without source changes. A fresh full run using
  those placeholders is pending; the failed attempt is not a full-suite pass.
- The corrected full run stopped after 3,610 passing tests on the in-memory
  `loyalty-real-concurrency.test.ts` harness: its program delegate only handled
  ID lookup, not the producer's unique store-ID lookup, and omitted nullable
  metadata. The harness now models both fields; production guards are unchanged.
  The focused rerun passed all seven tests and lint; a fresh full-suite run
  without fail-fast is now pending. Despite its legacy
  filename, this suite is a simulation and does not prove MySQL concurrency.
- Added isolated-MySQL tests for concurrent winner-only issuance and
  atomic rollback of issuance plus outbox while preserving the debit. They use
  the existing communication DB gate and exact scoped reward cleanup. These were
  initially counted only as draft tests; the 38-test result above now
  supplies execution and cleanup evidence.
- Added ordered database interleavings for generation replacement, suspension
  and redaction winning before issuance. Assertions compare the whole persisted
  redemption and original ledger rows and require zero notification jobs. These
  cases passed in the 38-test run, but are not simultaneous race or live Shopify
  evidence.
- The 50,000-row import process remains separate. No new test is pointed at its
  database and no import source or dependency files are changed.

Further September 13 checks passed: 80 tests across the ordinary/financial saga
suites, including communication failure after ordinary issuance, generic healing
and Gift Card adoption/retry. They assert no compensation or duplicate remote
creation; their transaction callbacks are mocks, not SQL rollback evidence.
Another 27 tests passed across merchant communications and real email-component
HTML rendering. The EN/JA/VI tests check redemption readiness while referrals
remain disconnected, saved policy behavior, private-ID exclusion, HTML escaping
and account/preferences links. Merchant rendering uses jsdom; email rendering
uses React static markup, not a mail client or provider delivery.
Web typecheck, focused lint and Prisma validation passed for this checkpoint.
Independent review found no blocking mocking bypass in the new saga, HTML or
editor tests. Prisma reported existing relation-mode index warnings; validation
did not apply schema changes or connect to a runtime database.

### Final-review correction and current verification

Integrated review found a financial cleanup ordering hole: currency or outer
admission validation could reject before the origin check and allow retry-marker
cleanup under a newer installation. Cleanup now independently validates the
persisted reservation origin under its existing lock before mutation. Dispatch
validates origin before currency. Four new Gift Card/Store Credit regressions
use real origin parsing and operational fencing with synthetic database state;
they cover combined installation/currency changes and rejection before dispatch
admission. All 15 financial tests pass. These remain simulations, not SQL races.

The complete web run finished with 7,734 passed, six skipped and one failed test.
The older cross-feature fixture omitted the owned program row now read by the
issuance producer. Its mock now returns that row with no communication policy;
runtime guards were not weakened. The affected cross-feature and financial
suites passed all 20 tests. A fresh full unit run and production build are in
progress; no green final-suite or final-build result is claimed yet.
The subsequent build compiled but failed type validation because a redemption's
account ID is nullable. Cleanup now requires the caller's exact account ID in
both its persisted-row check and update filter before origin validation or
mutation. The failed build revoked its SELECT grant and reconciled all 157
tables to zero. Focused tests and type validation are being rerun.
The financial suite subsequently passed 19 tests, including four additional
null-owner/different-owner cleanup cases. Those cases preserve the original
admission error and retry marker with no cleanup write, remote call or notice.
Independent review confirmed the ownership filter and original-generation
check; final full-suite/type/build evidence is still required.
The earlier long-running unit process finished with 7,739 passes, six skips and
four owner-mismatch failures. It overlapped source/test edits and is not a
final-source pass. A fresh isolated run with the same synthetic CI environment
passed all 19 financial tests. The next full run freezes source/test files and
records their digest so changing files cannot invalidate its evidence. Web
typecheck passed after the ownership correction; the final build is in progress.
The final Next production build subsequently passed, including compilation,
lint/type validation, page generation and build traces. Its temporary SELECT
privileges were revoked and independent SQL again verified all 157 fixture tables
empty. The frozen-source full unit run remains pending. No PR has been published.
That frozen-source run subsequently passed all 485 test files: 7,743 tests passed,
six skipped, no failures. Its source digest remained unchanged. This closes the
local full-regression gate; public CI and named live gates remain separate.

Browser checks use the actual shared `CommunicationsScreen` and Shopify CSS,
bundled into a loopback-only fixture with an in-memory transport, not Shopify.
At 375px, EN and VI DOM measurements found no horizontal overflow or exposed
fixture identifiers; the Japanese editor also measured 375px without overflow.
JA/VI message templates were selected and their mobile screenshots inspected.
An English subject edit followed by four Tab presses and Enter saved the draft,
reported that no email was sent and left notification enablement unchecked.
This is bounded keyboard/component evidence, not complete accessibility,
embedded authorization, shopper-flow or real email-delivery acceptance.
Permission-denied redemption controls were disabled in the browser accessibility
snapshot. Loading exposed a status and disabled reload; failed initial loading
displayed a sanitized alert with no editor. A synthetic ambiguous redemption save
kept the draft, showed no success message, disabled further saves pending reload
and did not expose the transport's private error detail. Browser console output
contained only the fixture's missing favicon error, not an application exception.
Screenshots remain local and are not part of the public change.

1. Complete real-browser/mobile/accessibility acceptance and mail-client/provider
   acceptance under the corresponding live execution gates.
2. Keep post-issuance failure behavior covered while adding actual transactional
   evidence; mocked recovery replay does not establish database rollback.
3. Prove real isolated transaction atomicity/replay and privacy/lease races with
   exact fixture cleanup. Do not interfere with the separately running 50,000-row
   import fixture. Synthetic provider tests are not real inbox acceptance.
4. Adversarial integrated review, relevant/full tests, types/lint/format/Prisma,
   builds and green public CI. Only then publish/merge verified code.
5. Named `yamaxdev` redemption/delivery evidence under separate live authority
   remains required before marking this journey accepted.
