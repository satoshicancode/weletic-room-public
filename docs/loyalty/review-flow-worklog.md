# Review Flow integration worklog

## September 20 — contract and implementation boundary

Branch `codex/review-flow-events` starts at public main
`887b174a087a83d28ef39b54fc755674a9ca73bd`. The collection/reminder draft remains
separate and unchanged by this slice.

The current loyalty Flow worker resolves an active loyalty account before
dispatch. Reviews must not adopt that requirement: a Reviews-only shopper may
have no loyalty membership and must never be enrolled by event publication.

The first draft adds strict review-owned event contracts and 23 passing contract
tests. Events contain internal review identity, event-time rating/verification,
version, timestamp and non-null installation generation. They reject review text,
email, customer GIDs, invitation tokens and loyalty account IDs. Customer reference
resolution belongs to a current-authority worker, not an unvalidated queue field.
These files are not connected to runtime producers or published extensions yet.

## September 20 — producer and consumer draft connected

The subsequent draft connects both handles to the existing `FLOW_TRIGGER` union,
normalizer and worker. Review submission queues its event inside the review
transaction; auto-publication queues both, and moderation queues publication only
when transitioning from a non-published state. The queue rejects a review event
whose generation differs from the currently locked store generation rather than
rebinding it. Legacy null-generation producers do not create new review events.

The review worker bypasses loyalty-account lookup, resolves owned request/shopper
identity and checks module enablement, linked and identity-based privacy
tombstones, revision, rating and generation. It holds the existing customer
settlement lock and rechecks after credential lookup. Publication events are
suppressed for currently hidden reviews; submitted criticism is not suppressed
merely because it is hidden. No review content or recipient email enters the Flow
payload; remote delivery remains at-least-once.

Current focused verification passed **166 tests in 11 suites** plus ESLint and
formatting. This includes mocked producer transaction propagation, worker guards,
normalization and existing loyalty Flow/outbox regression checks. It does not
prove SQL rollback/concurrency or real Shopify execution. The first typecheck
failed because this new worktree lacked package dependency links; those have
been restored and its rerun passed. Independent review is still pending.
The existing handle-inventory assertion initially failed and was updated to
explicitly expect the two new handles; no existing handle was renamed.

Extension definitions/public identity staging, full SQL tests, builds, review and
PR/CI remain outstanding. This branch is uncommitted and not deployable evidence.
PR #89's separate post-merge run 35473436303 passed; it does not validate these
new changes.

A follow-up adds explicit current product/order tenant checks and order shopper
ownership, with foreign-product/order tests. The worker suite now passes 18 cases.
These checks do not turn refunds or hidden criticism into fraud decisions.
The final combined selection passed **168 tests in 11 suites** (12.43s). The final
typecheck covering the ownership-query additions also passed.

## September 20 — independent queue review corrections

Independent review found and prompted fixes for temporary store blocks being
treated as completed no-ops, customer-lock contention consuming transport retries,
maintenance errors losing their deferral identity, and legitimate g2 publication
events being compared to a retained g1 invitation. Review events now take a
dedicated path before the legacy operational no-op guard. Typed pre-transport
deferral restores the exact winning queue claim and prior attempt count. Only
explicit temporary store states defer; missing, retired and unknown authority
fail terminally for reconciliation. Module disable defers without dispatch.

Publication uses the new authorized event generation while submission still
requires matching invitation provenance. Neither path rebinds an old queued
event or changes historical invitation identity. Tests cover producer-helper to
worker publication, current-generation checks, maintenance identity and queue
claim restoration during suspension. Initial corrected selection passed 180
tests in 11 suites. A typecheck caught the new early dispatch returning `void`
where the queue expects `undefined`; this was corrected with await plus return.

Follow-up review identified a paused full-page starvation risk. Candidate
selection now excludes exact review handles with disabled/missing review settings
before its limit, with a structural query test. This is not yet real SQL
full-page fairness evidence. Unknown/corrupt blocked states no longer defer
indefinitely. Final tests/typecheck and re-review remain pending at this checkpoint.

The corrected early-return typecheck passed. The broader selection then exposed
an exact query-shape expectation and leaked one-shot mock responses between tests;
the expectation now includes the new predicate and the fixture resets mock
implementations. Both affected suites passed **62 tests** after correction.

Re-review confirmed the authority/deferral/generation fixes but identified one
remaining query issue: negating a JSON-path comparison can exclude malformed
payloads with a missing `handle` under MySQL SQL-NULL semantics. Before any PR,
add null-safe candidate selection and prove it on isolated MySQL with missing,
JSON-null/scalar/non-string handles, ordinary loyalty events, both review handles,
and a full older paused page followed by active events. Also cover temporary store
blocks in the fairness fixture, not only disabled Reviews settings. The current
structural query test does not establish these SQL semantics; this known issue
remains open in the draft. No publication/deployment or real Flow occurred.

## September 20 — real MySQL queue semantics and publication checks

The null-safe candidate helper now has real MySQL coverage: missing handles,
JSON null, scalar payloads, null/numeric/object/array handles, ordinary loyalty
events and both exact review handles. Six authority states cover enabled,
disabled, missing settings, suspended, frozen and redacted stores. Three further
fixtures put 100 older paused review events before an ordinary loyalty event and
apply the predicate before `take: 50`. These prove candidate selection, not
end-to-end dispatch for a second active store.

Final fixture `weletic_loyalty_it_shopper_769172847c19` passed **36 tests** in
9.38 seconds. Concurrent publication creates one publication event; a later
republish creates a distinct versioned event without another points-award event.
All email and storage transports remain mocked. The disposable schema used the
compatible collection/reminder draft schema because this worktree shares its
generated Prisma client; this is not an exact public-main-only schema rehearsal.
The Flow slice itself adds no schema migration. The checked-in activation DDL
was rehearsed in the disposable database. Exact fixture database/user cleanup
completed; retained development ledger count remained 16 before and after.

Preserved failures: the first run had 25 passes and 11 failures, including
file-path email mocks bypassed by shared dependency symlinks and an obsolete
all-Flow event-count assertion. Mocking the actual public package specifiers
resolved the email isolation issue. The next run had 35 passes and one new test
assertion typo (`reviewVersion` rather than `version`); the final run corrected
that assertion. No provider send or live Shopify mutation occurred.

The six focused Flow/service/outbox regression suites also passed **148 tests**.
Full web TypeScript checking, focused ESLint and `git diff --check` passed.
The SQL container, exact SSH forward and isolated Lima instance were stopped
after verification. Independent re-review remains pending at this checkpoint.

## September 20 — batch validation and unowned extension manifests

Re-review found that selecting malformed payloads was insufficient: the legacy
store guard could still turn them into successful no-ops. Every `FLOW_TRIGGER`
now validates before that guard; invalid payloads produce a neutral terminal
error without retaining parser details. Fifteen batch cases cover missing/null/
scalar payloads and null/numeric handles under active, suspended and frozen
authority, asserting dead-letter and no completed transition. The affected two
suites passed 77 tests.

Added `weletic-review-submitted` and `weletic-review-published` manifests without
UIDs. Both use a customer reference plus the exact seven string fields emitted
by the normalizer. They include an at-least-once warning and stable event identity.
Hash-pinned offline public staging now includes exactly twelve extensions and
remains `unowned_not_deployable`. Staging/payload/batch suites passed 41 tests.
Independent review found no new concrete defects and independently confirmed
both staged manifests and absence of inherited UIDs. Shopify CLI validation,
public registration, publication and real workflow acceptance remain outstanding.
No CLI auth, extension deployment, provider send or new service startup occurred.
The final combined selection passed **168 tests in seven suites**; focused lint
and formatting passed. The post-correction full web typecheck also passed.

## September 20 — CLI schema validation and Shopify build

The twelve-extension public stage contains 42 files, retains no inherited UIDs,
and remains explicitly `unowned_not_deployable`. Shopify CLI
`app config validate --json --path <isolated-stage>` returned
`{"valid":true,"issues":[]}`. This validates configuration only; it does not
prove ownership, protected-data approval, publication or workflow execution.
Skill/CLI telemetry was opted out; no user prompt was transmitted.

Shopify app typecheck and Remix production build passed. Existing Vite CJS,
React Router future-flag and shared-component sourcemap warnings were emitted;
they did not fail the build. A full web build is next. Its first isolated runner
attempt stopped before fixture creation because MySQL had not finished startup;
retry only after readiness, using a fresh disposable database/account.

The staged Shopify CLI extension build passed (three UI bundles plus theme
check/bundling). Post-validation inspection found 12 local candidate UIDs, all
unique and disjoint from retained source/custom UIDs. CLI generated these only in
the temporary stage; source manifests remain unowned. Remote ownership is not
established. The unchanged Thank you source emitted BigInt-literal warnings for
the CLI's ES2015 target. Live post-checkout runtime compatibility remains open;
build success does not waive this warning or its installed-surface gate.

The expanded native review/Flow regression selection passed **224 tests in 15
suites**. Prisma validation first failed only because the environment omitted
`DATABASE_URL`; rerunning with a non-routable validation-only URL passed, with
existing relation-mode index warnings. No database connection was needed for
schema validation. Full web build fixture `weletic_loyalty_it_shopper_fc6756a16d00`
is running with loopback provider placeholders; cleanup is owned by its runner.
Repository-wide `pnpm lint` passed: ten tasks successful (nine cache hits), with
the changed web package lint executed uncached. The pending build remains the
same running process; no duplicate build was started.

The full web build subsequently passed, including all 367 generated pages and
production trace collection. Its `prisma:generate` step regenerated the shared
client from this branch's schema (not the reminder-draft schema); future work on
the separate reminder draft must regenerate its own compatible client before
verification. The build runner removed the exact disposable database/account;
retained development ledger count stayed 16. No persistent schema was applied.
This closes local build verification, not any installed or production gate.

Implementation sequence for this one slice:

1. Extend existing `FLOW_TRIGGER` payload union and GraphQL normalization with
   the two handles; do not add a second queue or database enum/migration.
2. Enqueue submission and actual transitions into publication in the same review
   mutation transaction. Deterministic keys include review, handle and version.
   Reply-only edits do not publish; hiding and republishing creates a new event,
   not a second built-in participation award. Auto-publication emits both events.
3. Route review events before the loyalty-account-only branch. Resolve the owned
   request/shopper, check Reviews enablement, active store/generation and privacy,
   acquire existing customer settlement locks, and recheck after credentials
   refresh. Never fall back to a new generation. Redacted/missing owners suppress
   dispatch; a publication event for currently hidden content is suppressed.
4. Expose only bounded event metadata and a validated current Shopify customer
   reference. Do not expose content, invitation URLs, email or incentive codes.
   No financial award is performed by producer or worker.
5. Add local trigger definitions and public-app staging/ownership checks without
   copying custom-app UIDs. Run CLI validation only within its approved local
   scope; extension publication and workflows remain explicit external gates.
6. Verify producer atomicity/replay, no loyalty account, stale generation,
   cross-store owner, privacy before/after credential refresh, disabled module,
   low rating, auto-publish, republish, malformed payload, provider failure and
   original event identity on retry. Run relevant SQL races and full checks before
   PR/merge. Test existing loyalty Flow branches for regression.

The transport is at-least-once under ambiguous responses. Stable event identity
must be available to downstream workflows; do not claim exactly-once Shopify
execution or authorize a workflow to duplicate built-in incentive awards.
Named real workflows for both triggers, privacy containment and installation
generation rejection are required before S02 is accepted live.

References checked: [Shopify trigger creation](https://shopify.dev/docs/apps/build/flow/triggers/create)
and [trigger field reference](https://shopify.dev/docs/apps/build/flow/triggers/reference).
Draft contract tests, formatting and focused lint passed. No sends, orders,
schema application, deployment or publication occurred.
