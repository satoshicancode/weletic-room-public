# Expiry communications integration — September 10, 2026

## Status

Locally validated implementation; public CI is pending. This is not a delivery acceptance receipt.
No live email, application worker, installation or deployment was run. Schema was
staged only in a newly created isolated test database; no shared development or
production schema was changed. The historical-import worktree and PR #13 remain
untouched.

## Implemented draft

- The existing expiry scheduler selects a store/program-bound revision of the
  merchant `points_warning` or `points_last_chance` policy into the existing
  outbox JSON payload. The points-expiration job itself stays unchanged.
- Delivery uses that queued template revision, with existing EN/JA/VI locale
  resolution and escaped text rendering. Legacy jobs without a snapshot retain
  the legacy template.
- Current merchant disablement and queued disablement suppress delivery.
  Existing consent, participation, expiry policy, generation and pause checks
  remain mandatory.
- The merchant UI distinguishes these two journeys from the other seven
  disconnected journeys. Publication still requires the remaining release checks.

## Review findings and verification still required

Independent review of the initial draft found that the template was immutable but
recipient, locale, balance, brand, sender and content were reconstructed per attempt.
That initial draft could identify different request bodies with the same provider
key. The local implementation now addresses this with encrypted provider-ready
requests. This is implemented code, not yet full race or delivery acceptance.

Implemented within the existing worker architecture:

1. Prepare the exact provider envelope once, including rendered HTML and all
   provider normalization (sender, preview behavior and unsubscribe headers).
   Persist encrypted customer-bearing material using the existing encryption
   facility; never log or expose it through merchant or shopper responses.
2. Bind the envelope to store, account, job, installation generation and existing
   job-specific provider idempotency key. Persist it before any provider call under the current worker
   claim and customer-settlement locks. A losing compare-and-swap must not send.
3. Preserve the worker completion fence: `getOutboxClaimWhere` currently compares
   the full candidate payload. An authorized payload update must update the
   in-memory claim consistently, without weakening payload/owner/attempt fencing.
4. Reuse the exact envelope on retry. Recheck consent, current disablement,
   account privacy state and generation independently. A changed recipient must
   suppress/reconcile the old attempt, not redirect it under the same key.
5. Explicitly erase the encrypted envelope in customer-redaction cleanup for
   both terminal and nonterminal jobs. The current recursive scrubber only
   removes named customer-context keys; encryption alone does not provide erasure.

Additional review fixes:

- New snapshot-backed messages use `loyalty-expiry-job-<jobId>`; separate policy
  jobs cannot reuse a key just because account/stage/expiry happen to match.
  Legacy sends retain their existing keys.
- Template rendering and sender normalization are lazy: a retained retry does
  not rebuild its request from changed or newly invalid customer variables.
- Snapshot-backed messages use the existing Resend transport and fail closed
  if it is unavailable. They do not silently fall back to generic SMTP, whose
  current adapter does not enforce this idempotency contract. Legacy SMTP
  behavior is unchanged. No new provider was introduced or configured.
- [Resend documents a 24-hour key-retention window](https://resend.com/docs/dashboard/emails/idempotency-keys).
  The new path stops retries after 23 hours from wall-clock preparation, leaving
  a one-hour margin. Such jobs enter dead-letter reconciliation; never clear the
  saved envelope or invent a new key to bypass this gate. Business fixture clocks
  do not set provider retry age.

Local evidence so far (mocked database/provider, no live deliveries):

- The connected expiry matrix covers immutable retries, changed-recipient
  suppression, missing claim, two policy jobs on one date, and invalid newly
  changed template variables.
- The envelope suite covers encrypted retention, tenant/account/job/generation
  binding, losing CAS, sanitized failure and unsafe retry ages.
- Actual `processOutboxJobsBatch` tests retain encrypted evidence and then finish
  both completion and failed/retry transitions against a payload-checking fake
  database. These are worker orchestration tests, not MySQL race evidence.
- Existing account-redaction tests now include an expiry job racing from
  processing to completed, plus recursive encrypted-evidence erasure.
- The latest three-suite run passed 78 tests. Earlier broader runs passed 102
  and 144 tests respectively, but predate the final worker/retry-window additions.
  Builds and release checks remain outstanding.
- Independent re-review found no further source blockers after the job-key,
  lazy-render and bounded-retry fixes. Root lint and Prisma schema validation
  passed. Three test-fixture typing errors were corrected by supplying complete
  outbox fixtures and a definite mock subject. A fresh web typecheck and all 53
  tests in the two affected suites passed.
- The full unit regression completed: **5,706 passed, 6 skipped, 370 files**, in
  525.31 seconds. Production source was unchanged during this run. The fixture
  declaration corrections were independently re-tested afterward; the new
  `.integration.test.ts` file is excluded from this unit configuration.
- The isolated MySQL suite covers competing retention, generation change, claim
  takeover and privacy closure. It requires a fresh
  `weletic_loyalty_it_expiry_*` database on `127.0.0.1:3307`, verifies the database
  and principal, blocks fetch, and cleans only its exact fixture IDs.

## Isolated database execution

Target: `127.0.0.1:3307/weletic_loyalty_it_expiry_1789023388566`, on the
identity-verified `weletic-loyalty-dev` Compose MySQL instance. The current branch
schema was applied only to this fresh database. No existing schema was reconciled
or altered. Temporary access for `loyalty_dev` was revoked after verification;
its pre-existing grants were preserved. The empty database is retained.

First execution passed all four assertions but failed cleanup in Prisma's legacy
Program relation-mode cascade, reporting a missing `ProgramEnrollment.partnerId`.
Independent `SHOW COLUMNS` confirmed that the column exists. The test cleanup was
changed to parameter-bound deletes of its exact Program/Project UUIDs after
loyalty children were removed and absence of fixture enrollments was verified.
This is test housekeeping, not a fix or acceptance of the legacy cascade path.
The eight remaining synthetic parent rows from that attempt were independently
identified and removed. No company records were involved.

The corrected suite passed **4/4 tests**, including cleanup. An independent raw
SQL check found zero rows in each of Project, Program, WeleticShopifyStore,
WeleticLoyaltyProgram, WeleticShopper, WeleticLoyaltyAccount and
WeleticLoyaltyOutboxJob. Independent review accepted the target/cleanup guards.
Web typechecking and focused fixture lint passed after the cleanup correction.
The Shopify package typecheck, production build and all 27 unit tests passed.
Changed-file Prettier and diff whitespace checks passed. The first web production
build compiled and reached page-data collection, then failed because the isolated
checkout had no `DATABASE_URL` for the existing partner-login static parameters.
This failure is not waived. The corrected build passed with exit code zero,
including all 367 static pages, against the retained empty test database with a
temporary SELECT-only grant and no provider credentials. The wrapper revoked that
grant on exit. No public CI or live-runtime result is claimed by this build.

Evidence limits: the overlap cases prove change-first rejection with concurrently
invoked retention; they do not measure MySQL lock-wait timing. The privacy case
models account closure plus the real JSON scrubber, not the complete privacy
worker or distributed customer-settlement lock lifecycle. These tests perform no
provider delivery and do not satisfy live communications acceptance.

Full delivery/release acceptance checklist (local cases above cover parts of this
list; do not infer end-to-end completion):

- Two attempts after changing template, balance, locale, branding and sender
  produce identical provider bodies and keys, or are explicitly suppressed.
- Stale claim, lost claim, changed installation generation, competing snapshot
  writes and privacy redaction cannot cause dispatch or overwrite newer state.
- Consent withdrawal, disablement and pause remain effective with a saved
  envelope; decrypt/ownership failures fail closed without sensitive errors.
- Redaction erases encrypted evidence from completed, failed, processing and
  dead-letter jobs, including races with snapshot persistence.
- Producer tests cover enabled, disabled and absent policies for both stages;
  actual expiry jobs contain no communication snapshot.
- Independent review, isolated MySQL race coverage, types, lint, relevant builds
  and public CI pass. Real delivery remains a separate execution gate.

No new schema, delivery provider, public API, merchant authorization model or
journey timing is part of this work. Other communication journeys remain deferred.

## Next communication producer work (not implemented here)

Source inspection identifies these existing event boundaries. Flow publication is
not email delivery evidence; email jobs must not depend on successful Shopify Flow
dispatch. Persist each communication event atomically with its originating state
transition and use the immutable source identity for deduplication.

- **Points earned:** `earn.ts` emits a ledger-bound Flow event for immediately
  available purchase points; `holding-period.ts` emits at maturity.
  `non-purchase-earn.ts` covers signup and other bonus sources. Connect positive
  available earns without also announcing pending grants as spendable points.
  Test replay, partial refund before maturity, zero release and source-specific
  suppression. Do not enable paused review incentives through this work.
- **Reward redeemed:** `saga.ts` emits after issuance, not merely reservation;
  `financial-reward-saga.ts` has the stored-value path. Bind notices to confirmed
  redemption identity and the historical reward snapshot. Test failed issuance,
  ambiguous recovery, compensation and capability-ineligible rewards.
- **VIP achieved:** `tier-lifecycle.ts` records tier history and then a Flow
  event. Select actual achievements rather than treating every tier-change event
  as an upgrade. Test skipped tiers, requalification, grace and downgrade; entry
  rewards and achievement messages require separate deduplication identities.
- **Birthday:** connect the annual award result in `non-purchase-earn.ts`, not
  the scheduler's intent to award. Test annual replay, timezone/date boundaries,
  edited birthday and zero/disabled awards. Specify whether the dedicated journey
  suppresses a second generic points-earned message before enabling producers.
- **Referral friend and advocate:** `referral-friend-claim.ts`, `referrals.ts`
  and `referral-coupon.ts` expose distinct claiming, qualification and fulfillment
  boundaries. Preserve those distinctions; a claimed link is not an advocate
  reward. The existing friend email helper still renders a hard-coded English
  template outside the new merchant policy path and returns/logs raw provider
  errors. Sanitize that error boundary and add adversarial recipient-leak tests
  as a separate follow-up; this expiry patch does not fix or accept it. Then
  connect immutable notices with locale, retry, suppression and clawback tests.
- **Reward expiry:** the redemption saga schedules expiry recovery when an
  issued reward has an expiry. Establish the notification's intended timing and
  eligibility separately from discount cancellation; no warning lead time is
  implied by a recovery job. Test redeemed, canceled, renewed and already-expired
  vouchers and exact schedule boundaries.

Shared completion gates for these seven journeys: reviewed producer/queue
contracts, policy revision snapshots, generation/account/claim fences, encrypted
provider-ready retries, consent and merchant disablement, complete privacy-worker
race coverage, EN/JA/VI rendering, supervised delivery and named live acceptance.
Any required outbox enum migration must be reviewed separately; this draft adds
none. The existing expiry-specific retention helper must not simply accept other
job types without new payload/ownership validation and tests.
