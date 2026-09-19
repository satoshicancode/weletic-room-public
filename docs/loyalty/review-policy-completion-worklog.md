# Review policy completion — working evidence

September 20, 2026. Working branch `codex/review-incentive-policy-completion`,
based on public main `ecd06df057dc29a0603d03c42c785875f4e0f3b6` (PR #86).
This is an in-progress R04/R05 batch, not a release or live acceptance record.

## Immutable coupon terms

The draft policy writer omitted the reward catalog's `purchasePolicy` and
`exchangeType`. Downstream reservation, delivery and settlement already derive
provisioning from saved award terms, so an omitted subscription policy fell back
to one-time purchases. New drafts now copy the fixed exchange type and validated
purchase policy, using the established one-time default only for absent values.
Malformed non-null policies fail before allocating a revision.

Historical snapshots and their digest reader are unchanged. No policy is
activated, no shopper enrolled and no reward issued by this change. No migration
is needed: these are existing optional snapshot fields with deployed readers.

Local verification:

- 41 focused tests passed across coupon snapshot/policy, purchase policy,
  shopper coupon contracts and native review service suites.
- New cases exercise one-time, subscription first payment, first-N and both/every
  payment terms through the actual provisioning snapshot functions; catalog
  edits do not modify the saved promise. Database transaction delegates are
  mocked. This is not real SQL concurrency or live Shopify discount evidence.
- Web TypeScript check and focused ESLint passed; formatting and diff checks
  passed. Independent adversarial review found no blocking findings.
- Build, batch CI, isolated SQL and live acceptance remain open for the batch.

## Next implementation boundaries

In-progress disclosure wiring now renders immutable points and explicit-none
promises as plain text in EN/JA/VI in the preview/form and email. Form locale
changes preserve shopper inputs. The 27 disclosure/form tests pass (jsdom and
mocked transport, not browser/live delivery). **Coupon disclosure currently
fails closed pending readable targeting/native terms; this intermediate state
must not ship or activate as the completed batch.** Complete the remaining
coupon path, delivery integration acceptance and immutable email-content retry snapshot
before publication. In particular, current shopper locale and branding must not
change a retry's provider payload under the same idempotency key. New real-SQL
tests and email-body assertions still need execution/extension.

Email rendering update: subject, introduction, action and legacy wording now
use EN/JA/VI consistently. The pure renderer preserves explicit disclosure,
escapes HTML and removes CR/LF from catalog-derived subjects. Its 11 tests plus
the disclosure/form suites passed (38 total); independent review found no
blocking finding. Added two isolated-SQL delivery cases for JA/VI explicit-none
policies, checking both text and React-rendered HTML; these remain unexecuted.
This closes local template localization work, not real delivery or retry safety.

## Isolated SQL checkpoint — September 20, 02:23 JST

All 18 native-review production-service MySQL tests passed in fresh database
`weletic_loyalty_it_review_0358a5c0d79e`, including the unresolved-policy/no-send
regression and JA/VI explicit-none delivery cases above. These SQL cases are no
longer pending. Email, media and Redis transports were mocked; database
transactions, token consumption, ledger rollback and lease predicates were real.
This is not yamaxdev, an inbox delivery or a Shopify discount acceptance claim.

The database and its matching scoped test account were removed after execution.
The retained `weletic_loyalty_dev` ledger count remained 16 before and after;
count equality is a narrow isolation check, not full financial reconciliation.

A broader shopper-suite attempt on fresh database
`weletic_loyalty_it_shopper_f2dc0b6f9c8e` stopped in its setup guard (144 tests
skipped). That guard previously required the retained development database and
its shared account. No product failure was inferred from the rejected setup.
The empty test database/account were removed. The guard is being replaced with
an explicit fresh-database pattern, matching unique principal and actual SQL
identity verification; retained and production targets remain refused.

The next fresh run (`weletic_loyalty_it_shopper_2f68f6c1d2e4`) passed 142/144;
two cleanup cases failed with `appId` validation / session `invalid_scope` because
the credential-free harness supplied no app ID. The suite now explicitly stubs
`SHOPIFY_API_KEY=shopper-profile-isolated-app`; no authentication rule is relaxed.
The failed fixture database/account were removed, with the retained ledger still
at 16. The failure is retained here rather than counted as accepted coverage.
The new target guard additionally refuses socket/unknown query overrides,
duplicate connection limits, unbounded pools, missing opt-in and foreign or
retained targets. Its 17 focused tests passed.

Rerun `weletic_loyalty_it_shopper_d324fbc4228a` also passed 142/144 (41.17s).
The app-ID failures progressed to two distinct unresolved fixture prerequisites:
`Frozen voucher admission changed` (the old frozen-store fixture lacks current
installation/admission/compliance credential evidence), and a missing
`server-only` module in the direct credential-resolver test runner. Preserve
the original assertions while rebuilding valid, owned credential fixtures and
the server-only test boundary; do not bypass runtime admission to pass them.
The fixture database/account were removed; retained ledger count was still 16.
The broader suite is **not accepted**. The 18-test native-review SQL result is
unaffected and remains bounded to that suite. Test-only guard changes passed web
TypeScript, focused ESLint and independent read-only safety review; harness
freshness/scoped grants were checked separately from URL-pattern validation.

Fixture correction: the frozen-store case now creates an encrypted
store/app/generation credential, HMAC-derived uninstalled admission and a linked
pending uninstall cleanup request. It asserts the provider receives that exact
synthetic frozen token and never uses the normal credential resolver. Runtime
admission/decryption/lease checks and the original usage-grace assertions remain
real. Independent fixture review found no blocking issue.

Run `weletic_loyalty_it_shopper_577c7fb42d2f` then passed 143/144 (39.96s).
Only the direct resolver test failed while loading Axiom's Next.js telemetry
module in Node. The shopper config now includes the repository's existing
`tests/setupTests.ts` telemetry stubs, matching the native-review SQL runner;
it also mocks the build-time `server-only` marker. Neither change mocks credential
resolution or database behavior. This run's fixture database/account were removed
and the retained ledger remained at 16. A subsequent full rerun is required.

Final rerun: `weletic_loyalty_it_shopper_78ee5551ab11` passed **144/144** in
41.01s at 02:34 JST. Combined with the separate native-review suite, this provides
162 passing real-MySQL service cases at this working-tree checkpoint. The earlier
failures remain documented above; they are superseded only for these named
suites. Provider transports, telemetry and Next's build marker remain mocked.
The legacy integration-resolver case intentionally exercised its retained
plaintext-compatibility branch and emitted two fixed decrypt-fallback warnings;
this is not public-app/native credential acceptance. Frozen cleanup exercised
the real encrypted owned-credential path. Web types, focused lint and reviewer
checks passed. The final fixture database/account were removed; retained ledger
count remained 16. No live installation, order, email or deployment occurred.

The working batch now also uses a shared store-bound policy reader before
invitation creation, preview and email lease reservation. Only explicit null
selects the historical path; missing rows, malformed references, wrong ownership
and altered digests fail closed. Unit coverage exercises these cases and
explicit `none` semantics. A real-MySQL regression has been added for an
unresolved invitation promise, checking zero sends and no lease/attempt mutation;
that new SQL case has **not yet been executed**. No disclosure UI or activation
gate is completed by this integrity check.

Expanded local checks: 58 tests across six focused suites, web TypeScript,
focused ESLint, formatting and diff checks passed. Independent review found no
blocking finding. The new guard covers invitation creation, preview and email
reservation, not every shopper write; media preflight retains its existing
authorization, and submission verifies its incentive claim separately.

1. Disclose the immutable invitation policy in email and form in EN/JA/VI,
   including exact points/media cap or coupon value, targeting, purchase type,
   cadence, combination, minimum spend, limits and expiry. Do not expose reward
   codes or shopper identifiers. Missing or corrupt promises fail closed; never
   silently replace an invitation's policy with current settings.
2. Add authenticated revision/generation-fenced merchant configuration and
   prospective activation only when the promise can be displayed. Disabling
   creates an explicit `none` revision, not legacy null semantics.
3. Resume reserved points claims durably after eligible enrollment without
   enrolling reviews-only shoppers. A dedicated bounded job requires additive
   schema/worker compatibility rehearsal; do not repurpose email or coupon jobs.
4. Complete end-to-end failure/concurrency/privacy and UI verification before
   publishing the batch. Named yamaxdev sends and reward journeys retain their
   explicit scoped execution gate.

The [combined checklist](company-store-completion.md) remains authoritative for
all other loyalty, reviews and section-5 completion gates.

## September 20 — private prepared-delivery boundary (not activated)

Added an encrypted invitation-email snapshot contract binding store, request,
installation generation, recipient, token hash, incentive-policy digest, provider
and transport-credential identity. It preserves final rendered provider content
and the original idempotency key. Reopening rejects changed bindings, tampering,
invalid clocks, missing retry classification and attempts outside the conservative
23-hour deduplication window. An ambiguous SMTP attempt cannot automatically retry.
These checks are not a replacement for current privacy, eligibility and lease
authorization.

Added provider preparation/dispatch helpers with no automatic provider fallback.
Preparation performs no send; it normalizes and renders once. The Resend path
rejects preview recipient redirection. SMTP supports already-rendered HTML while
preserving existing React rendering and reply-to behavior. Credential rotation
blocks dispatch. Resend identity is bound to the key that constructed the actual
singleton, with a separate environment/client agreement check; hashing only the
current environment was rejected during independent review. Private credential
fingerprints belong only inside encrypted evidence, not public responses or logs.

Verification: **153 tests across 12 focused suites passed**, including existing
transactional-email and expiry-email regressions. Transports are mocked; singleton
construction tests make no provider calls. Initial failures are retained here:
the web workspace could not import the email package's private render dependency,
so SMTP rendering was moved to its owning email package. Two SMTP tests initially
missed the dependency mock and received connection refusals on loopback port 1025;
the mock now uses the same explicit dependency path as existing repository tests.
No SMTP server was started and no email was delivered. A nondeterministic
ciphertext-tampering test was corrected to flip a decoded byte.
Web TypeScript, focused ESLint, formatting and diff checks passed. Independent
review found no remaining actionable finding in the new contract/provider helpers.

**Still incomplete:** the helpers are not connected to `deliverReviewRequest`.
Persist encrypted evidence before network I/O under exact request/outbox ownership;
reopen it on retries without rebuilding current content; clear it on terminal and
privacy paths, including completed/dead-letter jobs; preserve a non-sensitive
reconciliation marker when retry safety is exhausted. Rehearse persistence,
crash/replay, recipient changes and erasure races in isolated MySQL before enabling
the writer. Do not repurpose the existing token-only column as a JSON envelope.
Coupon disclosure, merchant policy activation and delayed-enrollment recovery
remain open. This work is uncommitted, unpublished and not live acceptance.

## September 20 — retained delivery wired into the worker

Supersedes the preceding "not connected" checkpoint, not its remaining acceptance
gates. `deliverReviewRequest` now retains the rendered encrypted provider request
in the same transaction as token/lease reservation, before entering the transport.
Retries reopen the original body and its authority bindings; locale changes do
not rebuild the message. Legacy attempts lacking evidence require reconciliation.
The additive nullable `encryptedDeliverySnapshot` MEDIUMTEXT column does not
repurpose the token column. Success, expiry observed by the worker, cancellation,
submission and redaction clear it. Cancelled rows with retained private evidence
remain discoverable by privacy cleanup.

Independent review found a pre-existing send-path suppression gap: linked
tombstones alone did not cover identity-only customer-ID/email tombstones. The
worker now checks `assertReviewPurchaseNotSuppressed` under the customer lock,
before opening evidence or reserving a send. Suppression cancels the request and
clears private delivery evidence. Four SQL regressions exercise unlinked ID/email
tombstones on both fresh sends and retries with zero further transport calls.

Named local evidence:

- `weletic_loyalty_it_review_3b9bae35ce53`: 21/21 real-MySQL cases passed (8.07s).
- `weletic_loyalty_it_review_d7d387ea2d3c`: 25/25 passed after suppression fix
  (6.90s). Includes concurrent acquisition, winning-token finalization, retained
  bytes after locale change, ambiguous SMTP containment, legacy-attempt rejection,
  changed recipient rejection, worker-observed expiry and cancelled-row erasure.
- `weletic_loyalty_it_review_migration_b3c622424ece`: the checked-in ALTER ran
  against a minimal old-column fixture; nullable MEDIUMTEXT shape and retained
  token value verified. This is not a full production-schema migration rehearsal.
- 120 unit tests across nine focused suites passed before the suppression fix;
  web types and Prisma validation passed. Provider transports/Redis/media are
  mocked in SQL tests; there were no live sends or Shopify calls.

All exact synthetic databases and scoped users were removed; fixtures are
reproducible rather than recoverable. Retained dev-ledger count stayed 16 before
and after each service run (a narrow noninterference check, not reconciliation).
No shared/runtime schema was applied. Migration instructions require paused email
writers and compatible readers/privacy cleanup before resumption; rolling back to
the old rebuilding writer is not a safe retry strategy.

Still open: an independent bounded retention sweep after outbox dead-lettering
(manual worker expiry is not proof of this), explicit operator reconciliation of
ambiguous sends, full migration/runtime rollout, coupon disclosure and activation,
remaining R1/R2/R3 and Loyalty acceptance. The batch remains unpublished.

## September 20 — independent expired-delivery retention

Added a bounded erasure sweep to the existing authenticated outbox scheduler.
It does not depend on a send retry or a live outbox job. Candidates are selected
by invitation expiry and retained token/body evidence, using an expiry/id index.
An active delivery lease is excluded. Customer locks and a store-row-locked
transaction protect a second exact store/request/generation/expiry/lease check.
The sweep can erase retired-generation data without reactivating an installation.

Cleanup removes token hashes, recoverable tokens, encrypted provider bodies and
lease material. It preserves attempt counts and historical terminal statuses;
unfinished expired attempts retain a non-sensitive unreconciled marker. Retryable
email jobs are cancelled, while completed/dead-letter evidence is preserved.
Removing evidence never creates permission to resend.

Named verification: `weletic_loyalty_it_review_b14830753a9d` passed **26/26**
real-MySQL cases (7.17s). The new case races bounded sweeps, clears an expired
dead-lettered request from a retired generation, preserves future invitations
and active leases, subsequently clears an elapsed lease and proves no resend.
The checked-in additive migration (column plus index) was applied to a fresh
full-schema rehearsal after removing only those new empty-fixture objects.
This is not shared/production migration approval or a production-sized rehearsal.
The exact fixture database/account were removed; retained dev-ledger count was
16 before and after. All email, Redis and media transports remained mocked.

20 unit/authentication tests passed for bounded cleanup, ownership predicates,
terminal-state preservation and rejection of unsigned scheduler calls. Web types,
focused lint and Prisma validation passed. The independent cleanup code gap is
closed locally; scheduler deployment, service supervision and live privacy/recovery
acceptance remain open. Ambiguous-send operator reconciliation, coupon disclosure
and policy activation remain unfinished. Nothing in this batch is published.

Review follow-up: ordinary customer-lock contention initially could abort the
whole scheduler before unrelated outbox dispatch. Retention now reports a
`deferred` count and skips the busy candidate using the existing distributed-lock
deferral hook. The shared customer-lock helper forwards an optional deferral
callback across every rotation key; existing callers keep their default behavior,
and protected work never runs without all locks. SQL failures still surface.
27 tests across retention, authenticated cron and shared-lock suites passed after
this correction, including later-candidate progress and unrelated dispatch.
The 26-case SQL run above preceded this contention-only correction; Redis remained
mocked, so it is not live Redis contention acceptance. Isolated MySQL, SSH forward
and VM are stopped, with no listener remaining on port 3307.
`deferred` means lock unavailable, including Redis acquisition failures, not only
contention. Final web types, lint/format checks and independent fix review passed.

## September 20 — coupon disclosure renderer

Replaced the blanket coupon-disclosure placeholder with EN/JA/VI rendering of
saved native-discount terms: amount/percentage/free shipping, exact minor-unit
currency conversion, minimum spend, purchase type and subscription cadence,
combination flags, actual code-use defaults, per-customer limits and
reservation-relative expiry. The order-wide points-or-coupon promise remains
independent of rating/publication, and coupons do not require loyalty enrollment.
Unsupported caps, incremental coupons, malformed scope or misleading values fail
closed rather than being advertised as enforceable terms.

Coupon awards may now contain optional digest-bound readable `displayTargets`.
Historical snapshots with the field absent retain their original digest. Targeted
disclosures require an exact complete set of labels, correct resource-specific
GIDs, no duplicates, at most 250 targets and bounded text. Rendered output contains
names, not reward-record IDs or target GIDs. Long lists are split into bounded
paragraphs; the form accepts up to 50 paragraphs while retaining text-only output
and its per-paragraph limit.

89 tests in six focused suites passed, covering JPY/USD/KWD conversion, values
above Number's safe integer range, percentage/shipping, all subscription cadences,
usage/expiry defaults, target mismatch and wrong-resource rejection, maximum list
size, historical digests, email/form localization and policy-reader integrity.
Web and Shopify types passed; focused lint/format checks and independent review
found no blocking issue. Tests use synthetic policies and mocked dependencies,
not live catalog or coupon acceptance. No services were started for this change.

**Still required before activation:** capture target labels from the authorized
store's live catalog, including parent product names for variants, then fence
the capture against changed catalog policy/revision/installation on commit.
The draft writer does not yet populate labels. Historical targeted drafts without
labels remain unavailable; do not rewrite their immutable promises. Finish the
signed merchant editor, prospective activation and named coupon issuance/use/
expiry journeys. This renderer is not a claim that the coupon slice is complete.

## September 20 — store-owned coupon catalog capture

The internal draft writer now captures readable target names using the public
installation's store-owned native credential and direct GraphQL, without SDK or
legacy fallback. It rejects incomplete, foreign, duplicate and type-mismatched
results, missing variant parents, and oversized labels rather than truncating a
restriction. Variant labels include both product and variant titles. Untargeted
coupons require no catalog request. Shopify's documented ProductVariant parent
and title fields were checked against the current stable API documentation:
https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductVariant.

Capture runs between two bounded review transactions. Before revision allocation,
the commit transaction rechecks installation generation, store/workspace/domain,
currency verification, reward timestamp and complete saved terms, and review
settings state. Labels are included in the immutable policy digest. No historical
snapshot is rewritten. New drafts must also pass the disclosure renderer before
being saved; unsupported promises fail closed. This remains an internal draft
writer, not a merchant authorization or activation endpoint.

Local evidence: 115 tests across seven focused catalog/disclosure/policy/form/
email suites, web and Shopify types, focused lint and independent review passed.
Provider results and transaction
fences in these new tests are mocked; they do not prove live catalog access or
real SQL concurrent revision/reinstall behavior. No services, policy activation,
emails, rewards, Shopify mutations or deployment were started. The larger batch
is still uncommitted and unpublished. Next: signed revision-fenced merchant
controls and prospective activation, isolated SQL concurrency coverage, then
named live acceptance under the applicable execution gates.

## September 20 — signed merchant incentive draft boundary

Added strict browser-safe draft contracts and a signed internal draft endpoint.
The actor determines the store; browser input cannot override actor, store,
captured catalog labels, receipt behavior or activation. The draft requires an
expected installation generation and policy revision. Points/none use one
authorized transaction. Coupon drafts check reviews.configure before catalog
I/O and again at commit; only commit consumes the merchant action receipt.
Receipt creation, revision validation and policy creation share the same
transaction. This does not change active settings, existing invitations or
awards. Disabling activation is not yet wired; a none draft is only a draft.

The shared staff authorizer now permits an internal recordAction:false preflight,
retaining current session, generation, grant, freshness and replay checks. Its
default remains receipt-producing. Independent review found no blocking defect
but requires real SQL coverage before release: no preflight receipt; consumed
actions rejected even in preflight; revoked/expired identity between phases;
rollback of the commit receipt on stale revision or failed save; competing saves.

53 focused tests passed across five suites. These include the real authorization
function with mocked SQL/session dependencies, signed-route boundary checks,
caller-derived authority, changed revisions and revoked access during capture.
They are not real database atomicity evidence. Initial harness failures (route
alias resolution and incomplete evidence-module mock) were corrected before
the passing run. No services or live Shopify actions were started. The merchant
UI, read gateway, prospective activation, SQL verification, full build/CI and
named live acceptance remain open; this backend work is not shipped.
Web and Shopify typechecks, focused ESLint, formatting and diff whitespace checks
also passed. No new schema change is introduced by this draft boundary.

## September 20 — merchant draft real-MySQL acceptance

Added a dedicated full-schema suite and explicit Vitest configuration. Before
any fixture write it checks the strict disposable URL/account guard and actual
DATABASE()/CURRENT_USER(). Fixtures use synthetic mapped public admissions,
encrypted store-owned credentials, bound online sessions and staff grants.
Authorization, transactions, policy writes and unique constraints are real;
catalog capture alone is mocked, and all external fetches are forbidden.

Final named run: `weletic_loyalty_it_shopper_bd72f6149fee`, **7/7 passed**, 2.83s.
Command after isolated schema provisioning:
`pnpm --filter web exec vitest run --config vitest.review-policy-db.config.ts --reporter=dot`.
Covered: preflight produces no receipt; consumed actions remain rejected during
preflight; stale revisions roll back receipts; concurrent same-revision saves
produce one policy/receipt and a revision-conflict loser; an actual P2002 policy
insert failure rolls back both receipt and settings allocation; grant revocation,
session expiry and generation change between coupon preflight/commit prevent
policy creation. Settings remain unactivated.

Earlier runs passed six then seven cases, but independent review identified that
generic rejection assertions could hide early unrelated failures. Final evidence
above follows fixes: exact error codes, callback count and completed invalidation
markers, plus the explicit P2002/conflict assertions. The initial typecheck also
caught a missing synthetic grant updater field; that fixture was corrected.

All three exact fixture databases/accounts were removed. Retained development
ledger count stayed 16 before/after each run; this is a narrow non-mutation check,
not full financial reconciliation. No shared schema, live credentials, orders,
emails or rewards were touched. This closes the bounded SQL authorization gate,
not the merchant editor/activation slice or live Shopify acceptance.
Final independent review confirmed the corrected assertions. Isolated MySQL and
the Lima VM were stopped, the owned SSH forwarding session closed, and no port
3307 listener remains. Docker Desktop was not started.

## September 20 — merchant policy read path and authenticated client

Added the signed policy-read endpoint, authenticated Remix read/draft routes and
strict browser client. Reads use reviews.configure and the actor-derived store,
validate saved ownership/digests, and never initialize settings or activate a
policy. The only read-side write is the existing one-use authorization receipt.
The response distinguishes legacy null activation, an explicit none promise,
the current active policy and the latest draft. It returns editable draft inputs
and saved EN/JA/VI disclosures, not raw snapshots or shopper identity. An intact
historical coupon lacking saved target labels is explicitly unavailable.

The client validates cross-field state and the exact next draft revision, uses
fresh authenticated POSTs and never retries ambiguous mutations. The draft
gateway timeout now allows 25 seconds for bounded catalog capture; other merchant
operations retain their existing 8-second timeout. Browser transport remains
bounded at 30 seconds. No activation endpoint or UI control was introduced.

102 tests in five focused/read/client/merchant-auth regression suites passed.
Coverage includes separate older active/newer draft policies, missing/corrupt/
foreign policy references, unknown response fields, unrenderable historical
coupons, unsigned requests, caller-supplied selectors, private error responses,
auth/permission/conflict states and no automatic retries. Independent review
found no blocker; its additional history cases were added. A Shopify typecheck
found an unsupported direct zod/v4 type import in that package; the type now comes
from the existing shared contract, with no dependency change. Shopify types pass.
These new tests mock transport/database dependencies; no new live evidence or
SQL-read acceptance is claimed. No services were started. The merchant editor,
prospective activation, remaining review journeys and release gates remain open.

## September 20 — rendered merchant draft editor

Added a reusable EN/JA/VI draft form for explicit none, exact-string point terms
and authorized catalog coupon choices. It labels saved disclosure as previously
saved, never as an unsaved preview or active promise. Video terms are explicitly
marked currently unavailable. Inputs have associated labels, status updates are
announced/focused, and long disclosure text wraps. No HTML disclosure is executed.

A synchronous save latch prevents pending and settled duplicate submissions.
Success, conflicts, expired authentication, denied access and ambiguous failures
all require reload before another save. Changed generation/revision props block
writes rather than silently replacing a dirty draft. Explicit reload confirms
discarding unsaved edits; browser unload is guarded while dirty.

37 tests across editor/client/read suites passed, including 13 rendered jsdom
cases under StrictMode, all three locales, exact values above Number's safe range,
XSS-safe disclosure, missing coupon choice, duplicate and ambiguous saves, stale
props and dirty navigation. Web/Shopify types and focused lint passed. This is not
375px real-browser, live authentication or accessibility acceptance.

Independent review found no blocking component issue and highlighted a controller
requirement: key the editor by explicit successful reload epoch plus generation/
revision, since a non-committed failed save can reload the same revision. Do not
silently remount dirty input on background refresh. The component is deliberately
not mounted yet: the authorized coupon picker and page controller must be wired
together next, followed by prospective activation. No live services or policies
were enabled and this batch remains unpublished.

## September 20 — mounted draft panel and authorized coupon picker

Mounted the draft editor on the Reviews page behind an explicit load action.
The panel shows active versus latest saved promises separately, loads policy and
coupon candidates through authenticated clients, and increments a reload epoch
after every successful explicit reload—even when the policy revision is unchanged.
Search/pagination and locale changes do not remount dirty input. Failed initial
loads do not expose a writable editor. No activation control exists yet.

Added a reviews.configure-authorized coupon search endpoint with store-owned
minimal id/name projection, fixed 50-item pages and one-row lookahead. Cursors
are scoped to app/store/installation/query; SQL always retains the store filter.
Only active, fixed, online amount/percentage/shipping candidates without unsupported
caps are listed. Listing is not eligibility approval: saving still revalidates
full terms, currency, installation and live target labels. Coupon selection does
not require loyalty-management permissions. No catalog or financial write occurs.

50 tests across five picker/client/route/editor/controller suites passed, plus
web/Shopify typechecks and focused lint. Independent review found no blocker and
flagged confusing accumulated search results. The dropdown now shows current
results plus the selected coupon, retaining visited choices only for selection
continuity; a regression verifies nonmatching unselected options disappear without
discarding a dirty draft. Empty-result copy explains the preserved selection.

Evidence is mocked transport/SQL and rendered jsdom, not installed-theme or 375px
real-browser acceptance. Full build/CI, prospective activation, remaining review
journeys and named live gates remain open. No services, sends, orders, rewards or
deployments were started. The worktree is still unpublished.

## September 20 — prospective activation history, internal service only

Added an additive activation-history schema and migration, strict activation
input, and a generation/revision-fenced internal service. Activation records the
staff/action identity and database clock atomically with the active policy pointer.
Explicit none revisions disable prospective incentives without restoring legacy
behavior. No merchant activation endpoint or control is exposed yet.

New order invitations resolve the saved policy effective at order time rather
than webhook processing time; existing invitations keep their original promise.
Pre-history orders retain the pre-cutover policy. Invalid ownership, digest or
current-pointer history fails closed.

Independent review found that shop erasure initially omitted the new history.
Fixed frozen-store purge to drain bounded, tenant-scoped activation pages before
settings/policies, removing staff identifiers without deleting retained financial
claim/policy evidence. Individual customer erasure does not remove this history.
Reviewer confirmed the fix; also fixed the missing typed activation ID prefix.

21 focused activation/history/privacy unit tests passed with mocked transactions.
Real SQL activation atomicity, migration rehearsal, purge/reinstall and retained
financial-policy coverage remain required before activation exposure. These tests
do not establish live acceptance. No schema was applied to a shared database,
and no live policy, send, order or deployment was changed.

Focused lint, formatting and diff whitespace checks passed. The first web
typecheck found the missing ID prefix (fixed); the default-heap rerun exhausted
Node's 4 GiB heap. The 8 GiB rerun passed; the aborted run is not counted as
typecheck evidence.

## September 20 — activation SQL migration and transaction acceptance

Fresh isolated fixture `weletic_loyalty_it_shopper_ca7b1ecd52a4` passed all ten
public-installation policy SQL tests (5.73 seconds). The runner replaced only the
fresh empty generated activation table with the checked-in migration before the
tests, rehearsing the actual deployment DDL. Concurrent activation produced one
winner, one activation audit and one additional committed authorization receipt;
the losing transaction rolled its receipt back. Exact cutover-time resolution
preserved the pre-history legacy pointer and explicit none policy afterward.

Frozen-shop purge removed owned activation identifiers before settings/policies,
left a foreign store untouched, and allowed a clean no-history resolver afterward.
This is database lifecycle evidence, not a fresh Shopify reinstall or invitation
delivery acceptance. The exact fixture database/account was removed. Retained
development ledger count stayed 16 before/after. No shared schema or live state
was changed.

Fresh fixture `weletic_loyalty_it_shopper_817383a31f93` then passed all 144 shopper
SQL tests (43.65 seconds), also using the checked-in activation DDL. Extended both
points and coupon confirmed-invalidity purge cases with activation history: the
extra purge page erases activation identity while retaining the exact policy;
subsequent pages retain invalidity audit/financial parents and erase participation
content. The suite retains its existing mocked external transports; it is not
live Shopify/provider acceptance. Fixture database/account was removed and the
retained ledger stayed 16. Updated web typecheck and focused lint passed.

Independent review accepted the bounded assertions and requested activation-row
cleanup in the shopper fixture's afterAll, so a failure before purge cannot mask
its original error behind a retained-store relation. Added store-scoped deletion
before settings/policy cleanup (this cleanup-only addition follows the SQL run).
Still open: actual invitation creation across multiple cutovers, existing-promise
preservation through that path, and real Shopify reinstall. Direct resolver tests
are not substitutes for those journeys.

## September 20 — fulfillment cutover journey and activation gateway

Added a production-service SQL journey through createFulfilledReviewRequests:
orders before first activation, exactly at points activation, between cutovers,
and exactly at explicit-none activation receive the expected saved policy even
when fulfillment arrives later. Replays retain one request/outbox job. Adding a
product to an already-invited order after cutover retains that order's earlier
promise. Historical activation rows are synthetic fixtures; authenticated writer
atomicity is established by the separate policy SQL suite, not this fixture.

All 27 native-review SQL tests passed in `weletic_loyalty_it_shopper_09c6bed64c7e`
(7.05 seconds). Typecheck then caught a nullable-JSON spread in the new test's
line fixture; replaced it with explicit line fields. The corrected suite passed
again in `weletic_loyalty_it_shopper_5646d14c2346` (8.00 seconds). Both used the
checked-in activation DDL; exact databases/accounts were removed and retained
ledger count remained 16. External delivery/storage/Redis transports are mocked.

Added the signed activation gateway, authenticated Remix action, strict response
contract and browser client with exact saved-policy/revision checks. Ambiguous
responses do not retry. This is unpublished local code, not live activation;
the merchant confirmation UI is still outstanding. Deploy requires migration
before history-aware readers/writers. Independent review found no blocker and
requested additional error-mapping/malformed-response tests, which were added.
Route tests mock signature verification and do not prove cryptographic end-to-end
authentication. Real Shopify activation, delivery and reinstall remain open.

34 focused route/client/activation tests and seven mounted-panel regressions
passed, plus focused lint and Shopify types. Web types identified the existing
panel test client's missing activate member; updated the typed fixture and reran
the panel tests. Final web typecheck passed. No services remain running:
MySQL stopped, isolated Lima release stopped and owned SSH forward closed.

## September 20 — merchant activation confirmation

Mounted a separate EN/JA/VI confirmation view for an unchanged, saved policy with
available disclosure. Dirty drafts and settled saves cannot enter confirmation
until reloaded. Confirmation shows the exact saved promise and prospective-only
scope, requires acknowledgement, and submits the saved id/digest/revision/current
pointer/installation generation. Editor and coupon search are hidden during this
step. The synchronous latch remains closed after every result; success, ambiguity,
permission/session errors and conflicts require an explicit fresh read. No cancel
or reload can race an in-flight activation.

Independent review found no safety blocker and requested focus transitions and
checked-confirmation stale-prop tests. Added heading focus on entry/back and
generation/current-policy/digest change regressions. All 33 rendered editor/panel
tests passed, plus web/Shopify types and focused lint (one existing panel ref-hook
warning, no errors). No live activation, sends, rewards or deployment occurred.

Playwright check uses the actual components in a temporary local Vite harness
with a synthetic client, not Shopify authentication or production styling. At
375px, English keyboard Tab/Space/Enter completed the synthetic activation,
focused its result and left controls locked until reload. English/Japanese
confirmation scroll widths were exactly 375px; Japanese heading focus and absence
of the synthetic installation identifier from HTML were checked. Harness startup
needed /private/tmp and package-local React resolution fixes; its only remaining
console error was a missing favicon. This is bounded component-browser evidence,
not full embedded/mobile/live acceptance.

Vietnamese keyboard submission with a synthetic ambiguous transport failure also
kept scroll width at 375px, focused the localized uncertainty message and disabled
resubmission until reload. Playwright skill guided the real-browser check; the
reviewer-requested accessibility follow-up did not change auth rules.
Local harness artifacts remain outside the public repository at
`/tmp/weletic-review-activation-browser.eV78LH`; no shopper data is present.

## September 20 — integrated verification before publication

Broad web selection passed 534 tests in 45 suites (54.48 seconds); Shopify unit
suite passed 191 tests in five suites (1.81 seconds). Shopify production build
passed with existing React Router/source-map warnings. Prisma validation passed
with existing relation-mode index warnings. Source formatting and changed-source
zero-warning lint passed. Initial bulk checks accidentally included generated
`.next-review-policy-check/types` files; the reruns exclude build artifacts rather
than modifying generated files. These outputs must not enter the PR.

Final cross-slice independent review found no additional concrete blocker. It
confirmed saved coupon schema compatibility, prepared transport binding, privacy/
retention, activation chronology and staff preflight/commit semantics. Additive
schema must precede readers/cron; do not roll back to processing-time policy
selection after activation. Named live auth/provider/reinstall gates remain open.
Web compilation-only build passed with existing CSS gradient/browser-data
warnings; it explicitly requires a later generate phase. This is not a full web
build or CI pass. Updated R04 in the completion matrix without marking it live.
