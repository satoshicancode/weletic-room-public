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
