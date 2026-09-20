# Delayed review-points recovery — implementation in progress

## Baseline and scope

PR #87 merged at `1a0cc2c002f8ca84be31097de335dbc50f452708` after all six
Fast Quality Gate checks passed. Its prospective policy/delivery work remains
locally verified, not live accepted. This branch starts at that public-main
commit. The full company-store completion matrix remains authoritative.

Post-merge Fast Quality Gate run `35465597576` also passed on the merge commit.

Complete R05 delayed-enrollment recovery using the existing immutable promise
and financial writer. Do not create accounts from reviews, substitute coupon
awards, use current policy values, require publication or punish ordinary refunds.
No shared database, Shopify installation, real reward, email or production
deployment is authorized by these local implementation changes.

## September 20 draft implementation

- Strict recovery payload contains only claim, shopper and installation identity;
  points, policy overrides and enrollment flags are rejected.
- Recovery executes under the existing store/program mutation fence, checks owned
  claim identity and invokes `fulfillReviewPointsClaimInTransaction`. Pending
  outcomes commit the shopper-facing waiting reason before requesting deferral.
- Added a dedicated outbox type, strict enqueue-generation comparison, worker
  dispatch and winning-lease restoration with five-minute waiting deferral.
  Legitimate waiting does not consume retry attempts or erase real failure history.
- Scheduling checks reserved product-points claim ownership and generation and
  verifies existing queue identity. It never resets completed, processing,
  cancelled or dead-letter jobs.
- The financial writer now schedules pending promises in the same transaction as
  its waiting marker. This draft still needs historical reconciliation and an
  enrollment wake-up; it is not a complete recovery implementation.
- Prepared additive enum DDL. It has **not been applied or rehearsed**. Reader
  rollout must precede producer activation; shared application remains gated.

## Evidence so far

- 30 new mocked boundary/scheduling tests pass across two suites. They establish
  wrapper/contract behavior, not real SQL races or actual enrollment recovery.
- 186 tests across ten outbox/recovery suites passed after initial worker wiring,
  before the final pending-producer call was added. Do not treat that run as
  coverage of the newly connected producer.
- Web type-check passed after initial worker wiring and again after scheduling
  and producer changes.
- Changed TypeScript lint passed with zero warnings. Prettier and diff whitespace
  checks passed.

## Initial checkpoint — work required before shipping

1. Add a bounded historical/missed-wakeup reconciliation producer with appropriate
   index and durable ownership. Existing dead letters and generation conflicts
   must not be silently regenerated. Avoid starvation behind paused or malformed
   claims; keep public telemetry to counts, not private identifiers.
2. Add the same-transaction enrollment wake-up without changing enrollment rules
   or lock order; cover pause/resume and existing-account ingestion paths.
3. Verify queue polling fairness and terminal privacy/invalidation cleanup,
   stale-generation rejection, retry exhaustion and operator-visible conflicts.
4. Rehearse exact additive DDL on disposable isolated SQL, then test the complete
   production-service lifecycle: review before enrollment, exactly-one award,
   concurrent/replayed workers, pause/resume, crash retry, old claims, privacy,
   invalidation, hidden/negative review and ordinary refunds. Coupon claims must
   not enter the points path. Reconcile balances and remove exact fixtures.
5. Repeat full focused tests, typechecks, lint/builds, adversarial independent
   review and committed-revision CI before PR/merge. Record failures honestly.
6. Obtain scoped live execution approval and capture named yamaxdev evidence;
   keep production and whole-module acceptance open until their gates pass.

## September 20 — recovery integration and adversarial findings

Historical discovery now selects eligible unqueued claims and excludes every
existing queue identity, including dead letters. Same-transaction shopper
enrollment accelerates at most 100 owned, pending, unleased jobs without resetting
failed jobs or changing enrollment rules. Polling excludes disabled modules and
recovery jobs have lower priority than ordinary financial work. Privacy redaction
and confirmed invalidation cancel their exact pending recovery jobs.

Independent review identified two blockers in the intermediate version:

- The legacy operational guard returned success/no-op for blocked stores, which
  would have completed an unfulfilled promise. Recovery now dispatches before
  that guard; temporary admission/compliance blocks defer and retired/missing
  installations require explicit reconciliation through a dead-letter outcome.
- A full blocked discovery page could starve later stores. A separate nullable
  `recoveryDiscoveryCheckedAt` bookkeeping field now rotates checked claims
  oldest-first. Its conditional update is restricted to exact owned reserved
  product claims, original generation and prior timestamp; it changes no
  financial, promise or provenance field. This adds a column/index to the draft
  migration, which still has not been applied.

The initial broad rerun failed an exact polling-query assertion after adding the
paused-module filter. Updating the assertion explicitly (not weakening it) yielded
896 passing tests across 65 suites in 70.77s. After the independent-review fixes,
112 focused recovery/outbox tests passed across four suites in 5.07s. These are
mocked/unit results; the final broader rerun remains required.

Independent re-review confirmed both fixes and found no additional concrete
blocker in those paths. Web type-check, changed-source zero-warning lint and
Prisma schema validation passed afterward (existing relation-mode index warnings
remain). A lint invocation initially failed because shell globs were resolved
from the wrong directory; the corrected apps/web invocation passed.

Three real-SQL tests are authored but **not run**: actual submission followed by
real shopper enrollment/concurrent recovery/acknowledgment replay; historical
discovery without dead-letter revival; and suspended-store deferral followed by
stale-installation containment. SQL fairness, privacy/invalidation, interruption,
exact migration rehearsal and complete suite reconciliation remain next.

The isolated Lima `release` VM was inspected and is stopped. No service was
started, migration applied, database fixture created or live Shopify action
performed during this implementation checkpoint. This branch remains uncommitted
and unpublished; no live or release gate is closed.

## September 20 — current local verification

The earlier draft checkpoints above are historical, not the current test status.
Historical discovery, enrollment wake-up, privacy/invalidation cancellation and
bounded fair discovery are now implemented. Independent re-review found no
remaining concrete blocker, including in the final SQL scenarios.

- Final broad focused run: **905 tests in 65 suites passed** (70.84s).
- Disposable MySQL final run: **153 tests passed** (45.57s), using actual
  submission, enrollment, recovery worker and financial services. This includes
  concurrent/replayed workers, delayed enrollment, historical discovery,
  maintenance-blocked page rotation, module pause/resume, stale generation,
  retry exhaustion, confirmed invalidity and privacy/recovery races.
- The privacy race permits either valid serialization (zero or one original
  award), reconciles cached balance against the ledger and asserts no invented
  fraud decision or reversal. It does not prove every possible interleaving.
- The first SQL run passed 145/147: two pre-existing rollback assertions assumed
  no recovery job. They now compare the full original outbox rows unchanged;
  the subsequent 149/149 and final 153/153 runs passed. Financial assertions
  were not weakened.
- Exact additive migration rehearsed from the old enum/column shape in the
  disposable database `weletic_loyalty_it_shopper_77160a20798d`. Each of the
  three run databases and scoped database accounts was removed. The retained
  development ledger remained at 16 rows before/after all runs.
- Changed-source lint passed with zero warnings; web and Shopify typechecks and
  Prisma validation passed. Next.js compile-mode build passed (existing CSS,
  Browserslist and route warnings); this is not generate-mode or deployed-runtime
  acceptance. Committed-revision CI remains pending at this checkpoint.

SQL evidence still mocks Redis locks and coupon transport; invitation setup and
acknowledgment-loss replay are synthetic. No real Shopify authentication,
delivery, coupon provider or live acceptance is implied.

The isolated MySQL container and Lima VM were stopped after testing; port 3307
has no listener. Docker Desktop and application/Shopify services were not started.

### Rollout and remaining gates

Apply the reviewed additive schema before compatible workers, and deploy all
compatible workers before activating producers/traffic. Do not roll old workers
back over newly produced recovery jobs. Containment disables affected writers
and recovery scheduling; preserve ledger history, claims and source provenance.
Shared schema application remains separately gated.

This covers delayed **product-review points** recovery locally, not all of R05.
Store/product claim competition, complete coupon lifecycles, actual delivery,
authenticated yamaxdev journeys and production rollout remain open. No live or
whole-module completion gate is closed by this slice.

## PR #88 — full CI correction

The first full public CI run `35467416036` failed one migration-contract test;
8,307 tests passed and six were skipped. Its expected append-only enum suffix
omitted REVIEW_POINTS_RECOVERY. Formatting/lint, web types and Shopify checks
passed. The affected-path run also failed; neither run authorizes merging.

The correction updates the explicit suffix and verifies the complete enum in
the exact recovery SQL migration against Prisma. Historical migration assertions
remain intact. This is an additional regression check, not a runtime or migration
change. A fresh committed-revision CI run remains required before merge.

## September 20 — integration with public main after PR #93

Merged public main `01a9ab591b245f43d88fd7e40de9d127d723b421` into the
existing PR #88 branch without rewriting its history. Resolved queue conflicts by
composing the review Flow and recovery candidate predicates, preserving both
early dispatch paths, distinct retry-free deferrals, strict payload validation
and installation-generation checks. Retained both recovery and process-crash
evidence in the completion matrix. Independent review found no production
regression in these resolutions.

The combined ten-file unit selection passed **220/220**. A fresh-worktree attempt
first failed because shared package build outputs were absent; building workspace
dependencies resolved collection. The next run exposed one incoming assertion
that expected the Flow predicate alone. It now verifies that predicate within
the conjunction; the outbox suite still asserts the entire combined predicate.

Added a real worker/MySQL regression: older paused review Flow and recovery jobs
must not occupy a one-row batch ahead of an eligible recovery. The test verifies
the active job completes with one ledger entry while both paused jobs retain
zero attempts and no lease, and the paused store has no ledger write. The first
run passed 153 existing cases but failed the new fixture because its synthetic
outbox ID was missing; independent review also identified that fixture error.
After adding the explicit unique ID, **154/154** SQL tests passed in disposable
database `weletic_loyalty_it_shopper_fd706ce622d1`. Exact activation and recovery
DDL were rehearsed there. Both this fixture and the earlier failed fixture
`weletic_loyalty_it_shopper_54971a377974` and their restricted accounts were
removed; retained development ledger counts stayed **16 → 16** on both runs.

An initial harness invocation occurred before MySQL was ready and failed before
creating any database. The subsequent run started only after container health
was verified. Redis locking and provider transport remain mocked: these results
do not prove real Flow delivery, authentication or deployed supervision.

Web type-check passed after the fixture correction; Shopify type-check/build,
Prisma validation, formatting and focused lint passed. The first type-check
captured the same missing fixture ID before its correction. MySQL, its loopback
forward and Lima were stopped after fixture cleanup. Full web build and fresh
committed-head CI are still pending at this checkpoint. A local build wrapper
first failed to locate pnpm under the sanitized temporary HOME; the restarted
build invokes the installed Next binary directly with the same non-secret,
loopback-only provider placeholders. No runtime authentication was bypassed.

The full Next production build subsequently passed, including all 353 static
pages, at local integration commit `234e10dfa0`. Existing CSS, route-revalidation
and unset build-only provider warnings were nonfatal. This is local build
evidence, not a deployed provider or authenticated acceptance result.

After PR #96 merged, integrated public main `ec11263d9d` without conflicts at
`923cbf3a9c`. The expanded recovery/Flow/privacy/migration selection passed
**365/365 tests in 16 files**, and web type-check passed with the combined Prisma
client. Recovery SQL logic is unchanged from the 154-case isolated run above;
that run predates this separate Flow schema addition and is not represented as
a combined-schema SQL rehearsal. Fresh full build and CI remain required.
Deployments must satisfy both recovery and Flow schema-first gates, even if the
Flow action stays disabled; see [Flow acceptance](flow-points-action-acceptance.md).
