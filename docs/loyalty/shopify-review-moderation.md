# Shopify review moderation — implementation and evidence

Date: 2026-09-07. Implements a prerequisite for the approved plan's audited
moderation and Shopify merchant interfaces. This is not an activated moderation
gateway or live-store acceptance. Audit persistence has only isolated local
MySQL staging evidence; shared infrastructure is unchanged.

## Transaction boundary

`moderateNativeReview` preserves the existing workspace API and its
`withReviewMutation` lifecycle/maintenance fence. Its implementation delegates to
`moderateNativeReviewInTransaction`, which uses a supplied Prisma transaction
without starting or retrying another transaction. The primitive still validates
input, checks store/review/version, preserves existing reward policies and
enqueues summary updates using that same transaction.

The primitive is internal, not an authenticator. The local merchant gateway must
verify the complete signed request, resolve current `reviews.moderate` authority
and write the moderation reason/audit on the same fenced transaction. Do not
authorize first and then call the workspace wrapper in a second transaction.
Financial release gates are not bypassed by a staff permission or owner status.

Legacy publication-based rewards retain their existing reversal behavior.
New policy-backed participation rewards remain independent of publication and
are not revoked for hiding genuine criticism. This extraction does not migrate,
reinterpret, repair or reactivate historical incentives.

## Incremental verification history

2026-09-08 integration refresh: merged the PR #82 main baseline into this branch,
retaining customer/profile routes and all fixture cleanup alongside moderation.
Independent conflict-resolution review found no blocker. The combined local
suite passed 5,234 unit tests across 338 files (six existing skips), 46 isolated
MySQL staff cases, 21 Shopify route cases, web/Shopify types, all ten lint tasks
and the Shopify build. Exact audit schema revalidation created zero tables,
changed zero existing tables and wrote zero merchant rows. Final refreshed web
build, formatting and exact-head CI remain separate checks.

Hiro explicitly requested completion of PR #78 and the participation integration
on 2026-09-08, then deferred further reviews work in favor of loyalty. This
provides PR-specific merge approval, not permission to deploy shared schema or
activate the gateway on a store.

Counts below record successive checks, not separate test suites to be added
together. The latest isolated MySQL run passes 27 tests.

Final local PR preflight: 4,664 unit tests passed across 305 files with six
existing skips; the 27-case MySQL suite passed again. Web/Shopify types, six
Shopify route tests, repository-wide formatting, all ten lint tasks, Shopify
build, Prisma validation and guarded web compile/tracing completed successfully.
Prisma retains existing relation-mode index warnings. Exact isolated schema
revalidation created zero tables, changed zero existing tables and wrote zero
merchant rows. Compile mode is not generated-page, CI Playwright or live-store
acceptance; required GitHub release checks remain separate.

- Fourteen focused production-service tests pass with mocked persistence,
  including supplied-transaction identity, input rejection before reads and
  error propagation without a nested recovery transaction. Existing tests cover
  legacy and new-policy reward behavior.
- Twenty-one isolated MySQL staff tests pass. The audited mutation test uses
  real `withReviewMutation`, merchant authorization, moderation, audit and outbox
  services. A failure after a published-to-hidden transition rolls back review
  version, merchant nonce receipt, audit and summary job; retry commits once and
  replay is rejected. The initial reward is pending; the additional awarded
  variant below extends this to financial rollback. A second case drains 21 audit rows over two privacy passes
  after review redaction while preserving another shopper's audit. Minimal
  fixtures are not validated purchase journeys and are cleaned up afterward.
- Independent read-only review found no semantic or transaction blocker.
- Eighteen additional pure contract tests pass (32 including the service tests).
  Web type-check and focused lint pass for this local increment. These do not
  prove audit persistence or runtime gateway authorization.
- Full audit-draft unit suite: 304 files, 4,648 passed, six skipped, using four
  workers. The first run exposed a missing audit delegate in a legacy privacy
  mock and a fork-start resource timeout; the mock was updated and the full run
  repeated successfully with bounded worker concurrency. No assertion or test
  was skipped to obtain this result.
- The initial transaction preparation introduced no schema. Its subsequent
  local audit draft adds one table and SQL migration. The guarded stager applied
  it only to owned loopback MySQL (`127.0.0.1:3307/weletic_loyalty_dev`): one table
  created, zero existing tables changed, zero merchant rows written. A first
  exact-DDL comparison refused index formatting differences before any CREATE;
  the SQL was aligned to generated DDL and then staged. Prisma format, validation
  and generation pass locally. No shared database rollout is authorized.
- The next local gateway draft adds authenticated moderation endpoints; none
  is deployed. No staff grant, external send or Shopify store mutation has been
  performed outside isolated synthetic database fixtures.

## Local contracts and release limits

The local `moderation-contract.ts` defines the implemented staff gateway's
strict input and response, mandatory reason, bounded explanation, safe expected
version increment, and separately supplied workspace/Shopify actor provenance.
It rejects browser-supplied identity, store, purchase-validation and reward-retry
fields. This contract is connected to the internal audited mutation and signed
gateway draft, and does not change the compatibility workspace API. Content moderation reasons do
not confirm fraud or invalidate participation incentives.

`moderateReviewWithAuditInTransaction` records before/after versions and status,
reason, explicit actor namespace and reply-change boolean on the supplied
transaction. It does not copy review/reply text or authorize its caller.
Audit failure propagates; the caller must roll back all effects. A unique
store/review/resulting-version marker prevents duplicate transition audits.
The legacy workspace user column remains null for Shopify actors.

Privacy redaction scrubs 20 audit rows per pass, with a separate remaining-row
check so already-redacted reviews cannot strand private audit details. Frozen
shop purge drains audit pages before deleting review parents, leaving financial
ledger history intact. Shopper exports include bounded audit pages without
staff IDs or merchant nonce links. These paths require the new table before
deployment; drain old privacy workers before audited writes are activated.

Seven mocked audit-service tests and four mocked privacy tests pass; they do not
prove database atomicity or migration correctness; the isolated SQL evidence
above covers only its stated cases. The later database checks below cover legacy
financial rollback and a controlled competing-moderator race. Policy-backed
invalidation, full erasure and live acceptance remain required. The export
evidence below now covers moderation-audit pagination and tenant isolation.

The signed internal `/api/internal/shopify/merchant/reviews/moderate` route
verifies the full actor/input body (32KB maximum). `moderateShopifyMerchantReview`
uses the existing lifecycle/maintenance transaction, current `reviews.moderate`
authorization, nonce receipt, review effects and audit creation together.
The Shopify `/api/merchant/review-moderation` adapter obtains fresh online
authority and never automatically retries an uncertain write. Its browser
client checks returned review ID, resulting version, status and audit ID.
The local inbox now connects EN/JA/VI moderation/reply controls. A synchronous
shared in-flight guard covers all forms and list navigation. Each attempted
write clears displayed rows and requires a fresh manual read; success, denial,
conflict and uncertain results have distinct focused notices. Redacted reviews
and exhausted versions have no editor. The UI never claims a browser-provided
permission; the gateway still authorizes every action. Rendered interaction,
mobile and accessibility acceptance are bounded by the local evidence below.

### Rendered browser checks (2026-09-07)

Playwright exercised the real Vite-rendered controls with synthetic App Bridge
identity and intercepted API responses on loopback. External requests were
blocked; no Shopify store or live backend was connected. These are UI checks,
not live authentication, incentive or purchase evidence.

- Missing reasons and an unexplained `other` reason prevent dispatch.
- A held save disables both forms and list controls. Forced submissions from
  both forms while it is pending still produce exactly one write.
- Success, HTTP 403, HTTP 409 and an aborted connection each clear all review
  forms, focus the corresponding outcome and require a manual reload. No
  automatic mutation retry was observed.
- A Vietnamese publication change submits only review ID, expected version,
  status, reason and explanation, then focuses the localized success message.
- Japanese and Vietnamese rendered pages were visually inspected at 390 × 844;
  document width remained 390 pixels with both forms present. This is not a
  complete keyboard, screen-reader or embedded-Shopify accessibility audit.

Screenshots and snapshots are retained locally under ignored
`output/playwright/moderation/.playwright-cli/`. An initial load encountered a
development-runtime hook error; a fresh intercepted navigation rendered without
a production-code change. Browser coverage of the actual deadline, reinstall
during a write and full mobile form interactions remains pending.

Twenty-two isolated MySQL tests pass after adding signed-gateway checks for
read-only staff denial, cross-store rejection, missing signature, injected owner
fields, competing expected versions, revocation and maximum-length Unicode
content. Seventy-four SDK/client tests and six Shopify route tests pass; Shopify
type-check passes. Web type-check, focused lint and independent gateway review
also pass. The competing-request case uses Promise.all, not a forced lock-wait
barrier; the later controlled service-level race below adds that proof. These
are synthetic identities, not live Shopify evidence.

The expanded isolated MySQL suite passes 23 tests. Its legacy-award rollback
variant seeds an immutable historical award of 9,007,199,254,740,993 points and
a prior redemption leaving seven points. Hiding the legacy review appends an
exact negative reversal, preserves both historical rows, changes the cached
balance to 7 minus the original award, and enqueues one tier review alongside
the summary update. A failure after audited moderation restores the complete
account row and ledger history and leaves no audit, merchant receipt or outbox
job. Retry commits once; nonce replay preserves complete committed snapshots.
The same fixture proves that an active-store purge refuses without mutation;
after freezing only the fixture store, audit deletion precedes review/request
deletion and the complete account, ledger, outbox and merchant-receipt snapshots
remain unchanged. This is the bounded purge helper, not full compliance-worker
erasure or a concurrent privacy race. Legacy lifetime-earned
and redeemed totals retain their existing semantics. This proves supplied-
transaction financial atomicity, not purchase validation, coupon recovery or
the newer participation-incentive invalidation path.

Current local regression after the gateway/UI increment: 305 unit-test files,
4,664 passed and six skipped; 23 isolated MySQL tests passed with the final
rollback/replay/purge assertions. Web type-check, focused test-file lint and
Shopify build pass. Independent read-only review found no blocker. These results
do not replace the remaining release gates or authorize shared-schema rollout.

The subsequent controlled-race suite passes 24 isolated MySQL tests. Two real
Serializable transactions invoke the production operational fence, staff
authorization and audited moderation. The first holds its transaction after
mutation; a scoped `information_schema.PROCESSLIST` query observes the second
connection executing the store `FOR UPDATE` statement before the first is
released. The winner commits version 2; the loser reports a version conflict.
Exactly one moderation audit, merchant receipt and summary job remain. Both
transactions are drained on an observation failure before fixture cleanup.
The first observer using `SHOW FULL PROCESSLIST` failed because Prisma exposed
unnamed `f0` columns; switching to an explicitly aliased SELECT fixed the test
observer without changing production code or database privileges. This covers
the real transaction services, while the separate signed-route race covers the
gateway. It does not exercise wrapper retry behavior and is not a live Shopify
concurrency or privacy/reinstall-race proof.

The subsequent export/redaction suite passes 25 isolated MySQL tests. The
production shopper export returns all 101 target moderation audits in stable ID
order across its 100-record page boundary, with no duplicates. Exact exported
keys exclude staff identity, installation and merchant-request fields. Another
shopper in the same store and the same Shopify customer ID in a different store
receive only their own audits; an absent store/customer combination returns
null. After freezing only the synthetic target store, six bounded redaction
passes retain all target audit IDs while removing private explanations and
review content from the next export. Complete Prisma row comparisons confirm
neighboring audits are unchanged. Independent read-only review found no blocker.
This tests production helpers, not the full compliance-worker journey or a
concurrent privacy/installation change.

The latest lifecycle variants bring the isolated MySQL suite to 27 passing
tests. A synthetic freeze or installation-generation transition holds the store
row while the delayed moderation's locking SELECT is observed on its own
connection. After commit, production fencing rejects frozen or stale-generation
state. The complete review is unchanged and no audit, merchant receipt, outbox
or ledger row is created. Generation fixtures update both the store and retained
integration binding; they do not exercise full reinstall or erasure workers.
Independent adversarial review of the complete additive branch found no code
blocker.

Remaining acceptance includes full compliance/reinstall-worker journeys,
live authenticated `yamaxdev` moderation, actual browser deadline and complete
keyboard/screen-reader/mobile interaction checks. The local denial/conflict,
ambiguous connection, ledger rollback, tenant isolation and observed lock-race
checks above are complete only within their stated test boundaries.
Existing compatibility callers must remain explicit about missing legacy reason
data rather than inventing historical reasons. Schema merge/deployment and
financial release gates remain separate approvals.
