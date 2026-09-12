# Points-earned communications — implementation in progress

This work follows L10 and the full company-store loyalty plan. It is not a
delivery acceptance receipt. The journey remains unavailable until its producer,
worker, privacy lifecycle and release checks are complete. No email, installation,
public exposure or shared-schema application is authorized by this document.

## Initial evidence and selected approach (superseded by checkpoints below)

- `earn.ts` posts immediate purchase points as an `EARN_ORDER` ledger event with
  `COMMERCE_ORDER` reference. `holding-period.ts` posts the same entry type only
  when the remaining eligible pending points mature. Both already enqueue Flow
  events, but neither enqueues a loyalty email.
- Pending order grants are not posted available points. Purchase notices attach
  to the committed ledger event, not the order webhook or mutable balance.
- The draft schema adds `LOYALTY_COMMUNICATION` as a dedicated general
  loyalty-message type; do not overload expiry, review-email,
  Flow or grant-release job types. Do not change the existing expiry scheduling.
- Reuse the existing communications policy store, plain-text EN/JA/VI templates,
  sender setup and provider. No provider switching or SMTP fallback for ambiguous
  attempts. Do not enable a policy merely because implementation becomes ready.
- The first connected source will be purchase points, including holding-period
  maturity. Signup/action/manual, birthday, referral, VIP, redemption and reward
  expiry require their own event/source semantics; they are not certified by the
  purchase-source contract. Merchant UI must disclose source-level availability.

## Files and contracts

- `points-communication-contract.ts`: strict internal purchase event evidence,
  exact positive signed-64-bit decimal points, ledger/order identity, account,
  store/program, installation generation and immutable policy revision/content.
  No recipient, sender, destination URL, customer name or order label is accepted.
  The deterministic key excludes mutable policy revision and separates store,
  generation, account and ledger event. This is evidence validation, not merchant
  authorization or an authenticated public API.
- `communications-service.ts`: extend policy snapshot selection for the producer
  while preserving the existing expiry snapshot and revision semantics.
- `earn.ts` and `holding-period.ts`: enqueue in the same transaction as the new
  eligible ledger entry, once only. Historical recovery, backfill, webhook replay
  and nonpositive/reversed events must not become fresh notices. Verify persisted
  refunds before recording the eligible event evidence.
- `prisma/schema/weletic-loyalty.prisma` and `outbox.ts`: add the dedicated enum
  value and typed payload validation/generation binding. Schema and worker
  deployment order must be explicit; old workers must never receive the new job
  type. No existing database has been changed for this draft.
- Delivery retention/worker: reuse the reviewed encrypted provider-envelope
  pattern, binding job/account/store/generation/key and claim CAS before send;
  preserve completion fences after payload updates. Require current consent,
  participation, account privacy, current policy enablement, store approval and
  pause state even on retries. A changed recipient suppresses rather than
  redirects. Preserve the bounded retry window and reconciliation behavior.
- `outbox-worker.ts`: add dispatch, customer-settlement locking, pause candidate
  filtering, sanitized failures and dead-letter behavior for the new job type.
- `shopper-privacy.ts`: explicitly erase the new encrypted envelope and event
  context from terminal/nonterminal jobs, including completion/redaction races.
- Communications contract/screen: show purchase-source readiness only after the
  producer and worker are connected; do not label all nine journeys ready.

## Verification and definition of done

September 10 local checkpoint (public-main base `17500247`):

- Added a backward-compatible ledger creation receipt. New writes report
  `created: true` only after the balance CAS; ordinary replays and duplicate-key
  recovery report `false`. Existing callers still receive the original entry.
- Added a producer helper that checks scoped program/account/grant/order state,
  active installation approval and immutable enabled policy. It retains original
  `ledgerPoints` separately from eligible `points`, capped by the remaining
  settled grant after refund reconciliation. A fully reversed grant is skipped.
- Added draft enum/payload support and strict outer-store/payload-store binding.
  Changed/missing installation generations and a missing store delegate fail
  closed for this new job. Replay does not replace stored policy evidence.
- Added recursive removal of `communicationDeliverySnapshot` alongside the
  existing expiry envelope. This is not full worker/redaction race acceptance.
- **170 tests passed across nine focused regression files**, covering the new
  contract, receipt, helper and outbox path plus existing earning, holding-period,
  outbox/adversarial and privacy suites. These are isolated unit tests with
  mocked dependencies, not named MySQL transaction or live delivery evidence.
  The earlier 53-test and 21-test checkpoints overlap this run; do not add them.
- Focused ESLint passed. Prisma validation passed with relation-mode/index
  warnings; local Prisma client generation was performed. **No database schema
  was applied.** Full web typecheck passed with an 8 GB heap after replacing
  bigint literals with exact `BigInt(...)` constructors supported by the existing
  compiler target. The initial run exhausted Node's default heap; the first 8 GB
  run exposed those literal errors, which are fixed. The 170-test regression and
  focused lint were rerun successfully after the correction.
- Independent adversarial review identified the outer/payload-store mismatch;
  the fix and actual enqueue-path regression test are now included. No further
  source blockers were found for this unconnected foundation.

At the foundation checkpoint neither producer invoked the helper. The later
connected-producer checkpoint below supersedes that local status. At that point
there was no readiness change, commit, PR or deployment. This document does
not supersede yamaxdev gates.

### September 10 worker checkpoint

- Added `communication-delivery-snapshot.ts`: encrypted final provider request,
  deterministic job-bound provider key, full claim/payload/updated-at CAS,
  recipient/request agreement and a 23-hour retry bound. Retry reuses the exact
  request and never rerenders. Local claim payload changes only after commit.
- Added `points-earned-notifications.ts`: scoped ledger/grant/order evidence,
  current consent, active program/policy and refund-adjusted eligibility. If
  a later refund reduces eligible points below the queued amount, delivery is
  suppressed rather than rewriting an immutable event or retained attempt.
  Provider responses/exceptions become a fixed safe error; no alternate provider
  or SMTP fallback is called.
- Added worker dispatch requiring the exact worker claim, installation gating,
  customer-settlement locking, email-pause candidate exclusion and terminal
  handling for exhausted provider-deduplication windows.
- Added the escaped React email template `loyalty-points-earned.tsx` with
  EN/JA/VI preferences copy and the saved localized merchant template content.
  Links come from the validated store domain, not event input.
- Independent review found a merchant-change race between initial reads and
  admission. Fixed by rechecking program/policy enablement, kill switch, pause,
  consent, scoped account membership and recipient inside the store/program
  transaction for **both first attempts and retained retries**. Follow-up review
  found the blocker resolved. Ten mocked change-first cases cover these gates;
  they do not replace the required real MySQL races.
- Retention/sender suites: 49 tests passed. Worker-dispatch and rendered-email
  suites: eight tests passed. A broader regression exposed an outdated candidate
  filter expectation; it now explicitly includes the new paused email job type.
  Final rerun: **243 tests passed across 14 files**, including the prior
  foundation, existing expiry retention, outbox/accounting/privacy regressions
  and new worker/render suites. Full web typecheck (8 GB heap), focused web
  ESLint, email-template ESLint and diff whitespace checks passed. Counts above
  overlap this rerun and must not be added to it. All transports are mocked.

Remaining before activating producers: actual enqueue/ledger rollback and
admission/privacy/generation MySQL races; batch-level reconciliation/dead-letter
and pause-restoration tests for the new type; producer callsite tests excluding
all legacy/replay/pending branches; full suites/builds and release ordering.
No provider request was sent and no database schema or deployment changed.

### September 10 connected-producer and MySQL checkpoint

- Both `earn.ts` and `holding-period.ts` now invoke the producer helper in their
  existing financial transaction after a fresh receipt. Immediate earnings do so
  after persisted refund reconciliation; existing-grant replay, legacy adoption
  and pending earns do not enqueue a fresh notice.
- Independent review identified a delayed partial-refund gap in holding release.
  Extracted the existing merchandise-refund loop without changing its line-less
  legacy exception; holding release now loads persisted refunds and reconciles
  them after its ledger write but before communication enqueue, within the same
  transaction. Follow-up review found the reported blocker resolved.
- Created a **fresh schema-only** fixture on the previously approved loopback
  MySQL instance: `weletic_loyalty_it_communications_20260910a`. The draft outbox
  enum was added only there. Existing development, legacy, production and prior
  test schemas were not modified. This supersedes earlier no-schema-applied
  checkpoints for the new fixture only.
- **12 real MySQL tests passed**: competing claim retention and exact reuse;
  change-first program/policy/pause/generation/consent/worker-claim/account-closure
  rejection; retained-retry admission; same-event ledger/outbox deduplication;
  ledger/balance/outbox rollback; actual holding release with a persisted partial
  refund whose reversal had not run. The last case proves available 70, pending
  0, reversed 30 and one notification with `points: "70"`,
  `ledgerPoints: "100"`, with no second notification on replay.
- After tests, the temporary DML-only grant was revoked. Independent root SQL
  verified zero rows in all 15 fixture tables (parents, store/program/shopper/
  account/settings, queue, ledger/grant/line earns, orders/lines/refunds/lines).
  The empty isolated schema is retained for subsequent tests. No provider,
  Shopify, customer or production mutations occurred.
- Full web typecheck and focused lint passed after the producer connection.
  The current callsite suite has **15 passing tests**, including fresh receipt,
  pending suppression, existing-grant replay, real legacy `EARN_ORDER` adoption
  through its existing branch, and enqueue-error propagation. Its database
  boundary is mocked; the separate MySQL tests prove transactional effects.
  The first full connected-code run ended with 5 failures, 5,890 passes and 6
  skips: four old holding fixtures lacked the new dependency, and the historical
  enum test assumed the older expansion was still the final schema. Corrected
  the scoped test doubles and added the separate
  `20260910_loyalty_communication_outbox.sql` expansion, preserving historical
  SQL. All 33 tests in those three files passed on rerun. A fresh full-suite
  rerun is active; the previous full run is **not** counted as green.

At the connected-producer checkpoint, remaining release work included batch
transitions and source-level readiness. The next checkpoint records that work.
Local producer connection is not authorization to deploy it.

### September 10 merchant readiness and final-review checkpoint

- The signed response now identifies `purchase_and_expiry_policies`. The actual
  shared editor discloses in EN/JA/VI that only newly available purchase points
  (including matured holds) are connected. Signup, manual, birthday and other
  point sources remain disconnected. Delivery still requires current consent,
  an approved sender, a running worker and an active program. Saving does not
  send or implicitly enable a policy. Existing expiry readiness is preserved;
  the remaining journeys are not labeled connected.
- The two focused editor/outbox suites passed **68 tests**. New batch tests
  verify pause restoration without consuming an attempt, immediate dead-letter
  handling when reconciliation is required, and completion CAS using the
  sender-updated payload. Their sender is mocked: they establish transition
  arguments, not end-to-end provider execution or a real completion/redaction
  race. That MySQL race remains a separate acceptance task.
- The overlapping full-suite run ended with two failures, 5,905 passes and six
  skips: it loaded the old strict response enum while the new gateway was being
  edited. All four gateway tests passed on the stable source immediately after.
  That run is not a green receipt. The subsequent stable-tree full run passed:
  **384 files, 5,907 tests passed and six skipped** (5,913 total). These counts
  include the focused unit checkpoints and must not be added to them. The 12
  isolated MySQL tests run separately.
- Shopify typecheck, local Remix/Vite build and **27 unit tests passed**.
  Full web typecheck (8 GB), web lint, email-template lint, Prisma validation and
  production build passed. Existing relation-mode/index and browser/CSS warnings
  remain. The build used only SELECT access to the empty isolated fixture;
  that temporary grant was revoked and independent SQL confirmed all 15 fixture
  tables remained empty.
- Playwright CLI exercised the actual shared editor and Shopify stylesheet via
  a loopback-only Vite fixture with synthetic transport. EN/JA/VI rendered at
  375 × 812 without horizontal overflow or fixture store/generation IDs in the
  DOM. A successful content save retained `enabled: false`; stale and ambiguous
  acknowledgements preserved the draft and blocked writes until reload.
  Read-only controls were disabled; denied reads removed writable state;
  successful reload restored the editor. Keyboard Tab reached the journey
  selector. This is bounded keyboard/layout coverage, not a full accessibility
  audit or live App Bridge acceptance. The Japanese viewport screenshot was
  inspected; artifacts remain ignored under `output/playwright/communications`.
  No Shopify/provider calls occurred. The local browser and fixture were stopped.
- Independent final source review found no new blocker after the tenant,
  merchant-admission and holding-refund corrections. It requires the expanded
  Shopify client/parser to be released **before** the backend advertises the new
  enum: older clients reject that response. This compatibility requirement is
  additional to the schema/worker/producer ordering below.
- At this pre-publication checkpoint no email, Shopify mutation or public
  deployment has occurred. Public CI is the next gate; a commit/PR is not live
  acceptance. The import draft remains unchanged.

The unsupported-entry-type test is not proof against real legacy adoption,
which can also use `EARN_ORDER`. Callsite tests must prove that existing-grant
replay and legacy adoption never invoke the helper; mocked helper failures do
not prove ledger/outbox rollback in MySQL. Immediate earnings must call it after
persisted refund reconciliation. Worker eligibility must also recheck later
refunds without rewriting an already retained ambiguous provider request.

## Remaining integration and safe release order

### Worker completion/privacy SQL follow-up

Two additional MySQL cases exercise the real outbox batch claim/completion,
encrypted retention and account-outbox scrub phase in both orderings. The whole
notification handler (including source/refund checks) and Redis customer mutex
are stubbed in these two cases; they prove SQL transition behavior, not delivery,
distributed locking or complete privacy ingress.

- Redaction before completion cancels and scrubs the job; the worker rejects its
  stale claim, and a later poll does not restore the ciphertext.
- Completion before redaction retains the ciphertext in a completed row (asserted
  before scrub); the scrubber then erases it without changing the terminal status.
- The first attempt stopped at the unavailable Redis boundary, with both new
  cases failing and the prior 12 passing. After making that test boundary
  explicit, all 14 passed. Independent review added the completed-row assertion;
  the final rerun again passed **14 tests**. Temporary DML grants were revoked,
  and independent SQL verified zero rows in all 15 fixture tables. Focused lint,
  formatting and the full web typecheck passed. Repository-wide formatting also
  passed after a formatting-only correction to the editor test in PR #20.
- A full privacy-ingress/Redis-lock interleaving remains a release acceptance
  task. These bounded cases do not close D2/E6.

### Deployment sequence

1. Worker implementation (locally implemented): use a
   dedicated encrypted provider request bound to job/store/account/generation,
   recipient and provider key. Check the exact request recipient against the
   trusted recipient before retention. Never serialize parser/provider errors
   containing recipient or template content into job errors.
2. Add the new job to customer-settlement locking and email-pause filtering.
   Recheck current account/program/store eligibility, consent, policy enablement
   and remaining grant points on every attempt. If a later refund makes the
   queued amount excessive, suppress it; do not edit the immutable event or
   replace an ambiguous retained request with a fresh provider attempt.
3. Prove encrypted-body reuse, recipient changes, bounded retry/reconciliation,
   worker ownership CAS and terminal/nonterminal privacy cleanup in unit tests
   and approved isolated MySQL races. Require exact fixture cleanup evidence.
4. Only then wire immediate earn after persisted refund reconciliation and held
   earn after successful settlement, using the new receipt and the caller's
   transaction. Test all early-return/adoption/replay paths and atomic rollback.
5. For any future authorized deployment, apply the reviewed enum only in the
   intended isolated environment. Upgrade/drain old workers before enabling a
   producer that emits this job. Verify worker compatibility and supervision
   before the producer release. Do not allow mixed old workers to claim new
   jobs. A rollback stops producers first; it does not remove the enum or erase
   pending evidence. Deployment is not performed by this checkpoint.
6. Upgrade the shared Shopify client/parser before a backend release emits
   `purchase_and_expiry_policies`; older clients reject this strict enum. Then
   expose purchase-source readiness only after integration and local checks;
   retain named live-delivery and suppression gates independently. Other points
   sources and the remaining communication journeys remain separate work.

Required before a PR:

1. Purchase and holding-release producer tests: enabled/disabled/absent policy,
   immutable amount/revision, no pending notice, no recovery/replay notice,
   partial/full refunds, same-event deduplication and rollback with ledger writes.
2. Worker tests: exact retained request/key after policy/locale/brand changes,
   wrong tenant/generation/account/claim, late/ambiguous retries, revoked consent,
   changed recipient, paused store, privacy cleanup and no alternate-provider send.
3. Isolated MySQL races and exact fixture cleanup for enqueue/ledger rollback,
   retention/leases and generation/privacy changes. Apply schema only to an
   approved isolated test database; no shared development/production reconciliation.
4. Independent review, Prisma validation, types, lint, builds, focused/full unit
   suites and public CI. Browser checks must use actual shared components.
5. Separate named yamaxdev delivery and suppression evidence after explicit live
   execution gates. Neither mocked provider success nor a public merge proves
   inbox delivery or production readiness.
