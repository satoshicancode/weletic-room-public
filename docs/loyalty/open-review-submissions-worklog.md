# Open review submissions — implementation worklog

## Scope and sequence

R03 under [ADR 0040](../adr/0040-company-store-loyalty-and-reviews-completion.md)
remains an unfinished vertical slice, not a released feature. The implementation
starts from public main `b21ca38abf0ea30cf6d3d117e47f299ee292da59` (PR #97).

The complete slice must include:

1. Reader-before-writer compatibility: explicit non-purchase provenance,
   invitation-independent content privacy, safe moderation/admin/Flow readers,
   and no fallback into legacy or prospective invitation incentives.
2. Compatible storage and isolated DDL rehearsal: retain historical invitation
   bindings; never create synthetic orders, purchase lines or invitation records
   to satisfy the current required `requestId`. Open submissions need their own
   immutable source/idempotency evidence. New writers remain disabled until all
   readers and erasure/purge/export paths support the source.
3. Default-off, revision-fenced merchant control and signed Shopify proxy/session
   submission. Only Shopify-authenticated customer identity may establish the
   author; ignore customer/purchase/reward assertions from submitted JSON. Apply
   store admission, installation generation, product ownership, privacy,
   duplicate and bounded-rate controls. Do not create a loyalty account.
4. EN/JA/VI text/photo form, explicit unverified/unrewarded disclosure, pending
   moderation, retry/error/expired-session behavior and safe public display.
   Photo ownership, upload limits, private access and abandoned-upload cleanup
   must support this source before the form offers uploads.
5. Isolated SQL concurrency, replay and privacy tests; full affected verification;
   then named authenticated yamaxdev merchant/shopper acceptance. Green local
   tests do not close that live gate.

Affected subsystems: review models and service/reward guards, merchant gateway
and settings, Shopify app proxy and forms, media ownership, public/admin/Flow
projections, privacy/export/purge, and exact release route allowlists. No public
unauthenticated mutation API, automatic enrollment, real send, deployment or
shared schema application is authorized by this local implementation increment.

## September 20 — invitation-independent content erasure draft

Code inspection found that `redactNativeReviewsBatch` discovered original
review text through invitations. A cancelled invitation with a nominally
redacted review could also hide residual body/reply text from completion checks.

The local draft adds a review-owned, store/shopper-scoped 20-row sweep inside
the existing privacy transaction. It clears original text, display/reply/staff
fields and participation evidence, preserves financial/source fields and the
first erasure timestamp, and enqueues summary work atomically. Completion checks
include residual original content independently of invitation state. Existing
invitation cancellation, photo cleanup, translation/audit and claim handling
remain in place. This is not yet requestless media or whole-shop purge support.

Independent review identified signed-Int version exhaustion as a privacy
failure. Terminal erasure now saturates at 2,147,483,647; redacted status already
rejects moderation and translation writers independently of version. Invalid
version values fail closed. A clean replay has no new version/outbox write.

Verification for this local draft:

- Initial focused tests: 19 passed before the boundary regression was added.
- Expanded tests initially found one outdated challenger mock missing the new
  review-content completion count. The mock was updated; production behavior
  was not weakened. The focused rerun passed all 52 tests. Changed-file lint,
  full web TypeScript and documentation formatting checks passed.
- SQL regression extends existing customer erasure acceptance with leftover
  content repair after invitation cancellation, maximum-version erasure,
  unchanged replay, preserved reward/source metadata, unchanged other shoppers,
  and independent ledger count. It uses synthetic purchases and mocked delivery;
  it is not a real Shopify order or email.
- Isolated fixture `weletic_loyalty_it_shopper_b9df3e2fe9fa` passed all 74 native
  review SQL cases and all 154 shopper SQL cases using the checked-in activation,
  translation and owner-privacy DDL. The exact database and user were removed;
  the retained development ledger count remained 16 before and after. The
  expanded last native-review case proved residual repair, maximum-version
  erasure and no-op replay against MySQL, not only mocks.
- Independent review rechecked the boundary fix and found no remaining blocker
  in this draft. Full unit/build/CI and the complete R03 vertical slice remain
  outstanding; this checkpoint does not certify open submissions.

At that checkpoint there were no schema changes, open submission writer,
merchant enablement, commit, PR, deployment or live acceptance.

## September 20 — nullable invitation reader compatibility

The next local draft makes the existing product-review invitation relation
optional, without changing historical invitation IDs or purchase flags. New
rows default to unverified; the existing trusted invitation submission writer
continues to explicitly set verified purchase. The isolated migration
`20260920_review_optional_invitation.sql` relaxes the invitation column and
changes only the future insert default. No shared database application occurred.

Requestless originals now:

- Cannot reserve/fulfill/reverse/invalidate invitation incentive claims, create
  invitation participation hashes, or fall back to publication rewards.
- Reject merchant reward retry before moderation writes. Ordinary content
  moderation remains possible without earning or reversing rewards.
- Have no retry action and no purchase/incentive label in merchant/public
  projections, even if an inconsistent stored flag says otherwise.
- Are discovered by frozen-shop purge independently of invitations, after
  translation/audit children; outstanding private media blocks purge.
- Do not enqueue publication Flow events until their own source/generation
  evidence is supported. Independent review found the producer/worker mismatch
  and the producer now matches the deliberately gated worker. Summary sync is
  still enqueued. This is a temporary disabled capability, not completed R03 Flow.

This is reader-before-writer work, not the final provenance model. No open
submission gateway/form or merchant activation exists yet. Explicit immutable
submission provenance, source-aware media authorization/export/cleanup and
requestless Flow evidence remain necessary before enabling the writer.

Initial expanded UI/service/privacy/reader tests passed 40 cases. Type checking
identified invitation-only SQL fixtures that still assumed all reviews have a
request. Their shared fixture now asserts the real request binding and explicitly
sets verified-purchase proof rather than relying on the former database default.
The expanded unit run passed 275 cases across 23 files; changed-file lint passed.
The current isolated fixture `weletic_loyalty_it_shopper_6a81a798ee20` rehearsed
the optional-invitation/default DDL and passed all 75 native-review SQL cases,
including a requestless synthetic original, rejected reservation/retry, normal
publication without points or unsupported Flow jobs, and subsequent customer
erasure. All 154 shopper SQL cases also passed; the exact fixture database and
user were removed, with retained ledger count unchanged at 16. Full web
TypeScript passed after the fixture correction. Full unit/build/CI and remaining
R03 implementation remain
open. Nothing from this branch has been committed, published or activated.

## September 20 — submission contract and provenance

The local draft now has a strict open-content contract reusing invitation content
limits. It accepts only a random-version client operation UUID, product identity,
generation/settings expectations, supported locale, current unverified/unrewarded
disclosure, publication consent and review content/photos. It rejects caller
identity, purchase, reward and publication-authority fields. Structural validation
does not authenticate a shopper; the signed gateway remains unimplemented.

Operation hashes bind store, shopper and installation generation. They remain
stable across authenticated surfaces; the accepted source is recorded separately.
Private content hashes bind normalized content, consent, settings revision,
product, locale and sorted media IDs. Changed-content reuse conflicts; terminal
erasure never becomes a replay success. No raw operation UUID or copied content
is persisted in the new source record.

`WeleticOpenReviewSubmission` and its separate exact DDL provide one source per
owned review and a unique store/operation key. This is not yet a submission writer
or complete immutable settings history. Source/privacy helpers retain only a
content-free retry marker on customer erasure and drain source children before
frozen-shop original deletion. Both shopper and Shopify phased exports include
only safe source/disclosure metadata, not hashes, generation or internal owner
IDs. Independent review caught the initially missing phased Shopify export;
that path and its regression assertion were added.

Verification:

- Initial contract execution failed because the installed Zod API has no
  `innerType`. Content fields were factored into a shared base schema instead;
  existing invitation validation still retains strict fields and photo uniqueness.
- Initial Prisma validation required a composite unique constraint on the
  one-to-one relation; the schema and DDL now both include it. Generation passed.
- 156 focused contract/privacy/compliance tests and changed-file lint passed.
- Isolated fixture `weletic_loyalty_it_shopper_6fafe2de2117` rehearsed the exact
  source DDL, passed 75 native-review plus 154 shopper SQL cases, and was removed
  with its database user. The retained development ledger remained 16.
- The synthetic requestless case proved operation-key uniqueness with rollback
  of a duplicate review transaction; subsequent erasure proved private hash
  removal and retained opaque retry identity. This is not simultaneous-request
  acceptance or a live authenticated submission.
- Full web TypeScript passed after the export integration. Full unit/build/CI,
  source-aware authenticated writer/media/Flow, merchant settings/history,
  rate enforcement and named live acceptance remain open.

No shared migration, send, order, deployment or activation occurred. The whole
branch remains a draft toward R03, not a completed shopper journey.

Next identity integration constraint: the existing general
`upsertWeleticShopper` can create a loyalty account when the program is active,
and partial inputs can overwrite marketing preference. The open-review writer
must not use that path unchanged. It needs a scoped identity-only transaction
primitive that reuses an existing author without changing consent/profile data,
or creates only the required review author from trusted Shopify identity, with
current privacy checks/projection and no account/signup reward side effects.

## September 20 — identity-only author primitive

The draft now contains `ensureOpenReviewAuthorInTransaction`. It is explicitly
an internal post-authentication primitive, not an authentication API. The future
gateway must supply the authenticated Shopify customer and a known email/null,
and must check the open policy before calling it in the submission transaction.

It verifies current store admission/generation and enabled reviews, then checks
retained incoming privacy identities without expiry filtering. Numeric and GID
customer aliases are looked up under a current lock; ambiguous duplicates fail
closed. Existing profiles are not updated. New authors receive only minimal
identity fields, followed by the existing persisted-source privacy projection
in the same transaction. Saved and retained email/owner suppression still apply.
There is no loyalty-account, ledger, reward, signup or outbox writer in this path.

Independent review caught an ordinary settings read that could be stale inside
an already-established Repeatable Read transaction. The implementation now uses
a locking current read under the store lock. The SQL regression establishes an
old enabled snapshot on one connection, commits a disable on another, and proves
the subsequent author attempt is rejected without creating the profile.

Verification completed locally:

- 61 focused author/contract/privacy tests passed, including 13 identity-only
  cases. Full web TypeScript and changed-file lint passed after the locking-read
  correction. Independent review confirmed the correction.
- Isolated fixture `weletic_loyalty_it_shopper_3506dde2d968` passed all 78 native
  review SQL cases with exact draft DDL. New cases prove unchanged existing
  profile/consent, one identity under simultaneous calls, no loyalty/account/
  ledger/outbox change, incoming and saved-email retained suppression, stale
  generation rejection and disable-after-snapshot behavior.
- All 154 shopper SQL cases also passed (232 SQL cases in total). The exact
  disposable database and its user were removed; the retained development ledger
  remained unchanged at 16 entries.
- This is synthetic trusted-input service evidence, not a verified Shopify login
  or completed open-review submission journey. Full branch build/CI and live
  acceptance remain outstanding.

Next: immutable merchant settings/history and bounded rate policy, then connect
the authenticated writer and source-aware media/Flow. No route or module
activation has been added by this primitive.

## September 20 — open-policy contract and rate-window specification

Added a strict policy payload and merchant write envelope with generation and
expected-revision fields. Open collection and photos default to disabled. The
draft configurable rolling-24-hour limit defaults to three submissions, bounded
to 1–20 per author/store. These are application defaults, not observed Smile
behavior. The policy cannot configure rating eligibility, purchase proof,
incentives or automatic publication. Canonically ordered snapshot digests retain
explicit disabled revisions rather than treating disable as history deletion.

The owned provenance count specification uses a strict trailing-window cutoff,
counts across surfaces and installation generations, and does not exclude erased
or moderated submissions. Future timestamps count conservatively after backward
clock changes. The future writer must check owned replay first, then count and
insert under the same store lock. This helper alone is not concurrency-safe rate
enforcement, authentication, or persisted immutable settings history.

Verification: 60 focused policy, submission-contract and author tests passed;
full web TypeScript, changed-file ESLint, Prettier and whitespace checks passed.
No schema was applied or runtime started for this increment. Persistence,
revision-fenced merchant gateway/UI, transactional enforcement and live acceptance
remain required before the feature can be enabled.

## September 20 — persisted policy history draft

Added `WeleticOpenReviewPolicy` with an additive exact DDL file, a unique
store/revision key, immutable policy snapshot/digest, installation generation and
trusted merchant attribution. The internal writer requires an authorization
callback inside the existing operational-store transaction; no optional-auth
overload or public route exists. It reads the newest revision using a locking
current read, verifies the stored digest, rejects stale revision commands and
appends an explicit disabled revision when collection is disabled. Missing history
reads as disabled revision zero without creating records.

Prisma client generation passed, and 24 policy/history contract tests passed.
Full web TypeScript initially caught the missing open-policy ID prefix; after
adding it to the shared ID type, the rerun and changed-file ESLint passed.
Prettier and whitespace checks also passed.
These mock-transaction tests do not prove SQL rollback/concurrency behavior.
Exact DDL rehearsal, concurrent revision allocation, frozen-shop history cleanup,
merchant gateway/UI and authenticated shopper submission remain pending. This
draft has not applied a schema to shared infrastructure or enabled collection.

Independent review found no blocker in these bounded primitives. It highlighted
the required reinstall check: latest history can belong to an earlier generation;
the future submission writer must reject it until a merchant-authorized policy
revision belongs to the current installation. Reading history is not permission
to submit.

## September 20 — frozen-store policy cleanup and SQL race verification

Whole-store review purge now drains at most 20 policy-history rows per call,
under the existing frozen/redacted store lock, after source provenance is drained.
Both discovery and deletion retain the store predicate; deletion is restricted
to the selected IDs. It returns pending after a deleted page so retries converge
before parent cleanup. Individual customer erasure leaves policy history intact.
Deletion failures propagate instead of declaring erasure complete.

The new native SQL case races two same-revision commands, requires exactly one
winner, appends a disabled revision without modifying the earlier row, rejects
stale generations and denied authorization, and checks that ledger count does
not change. Its authorization callback is synthetic—not a signed gateway test.

45 focused privacy/policy/history tests passed. Full web TypeScript and changed
lint passed. Exact policy DDL was rehearsed in disposable fixture
`weletic_loyalty_it_shopper_8b4fa6983d24`, with 79 native and 154 shopper SQL tests
passing. The fixture database/user were removed and retained ledger count stayed 16. Frozen-policy purge has focused unit evidence, not SQL lifecycle acceptance.

Independent review found no cleanup blocker and requested a precise stale-generation
error assertion. That assertion was tightened after the full run loaded its test;
a fresh targeted fixture `weletic_loyalty_it_shopper_2ce7a889dd22` passed that case
(78 unrelated cases skipped). Its exact database/user were removed; retained
ledger count again stayed 16. No live merchant authorization or shopper
submission has been claimed from these synthetic service tests.

## September 20 — Shopify merchant policy service integration

Added internal read/write operations using the existing Shopify merchant actor
envelope and transactional staff authorization. Both require `reviews.configure`.
Writes reject mismatched command/envelope installation generations before calling
the history writer; its required callback revalidates permission and records the
merchant action in the same transaction, returning only trusted actor attribution.
Reads use the operational store fence and return policy/revision without hashes
or stored staff identifiers. An old-generation policy is explicitly marked
`requiresReauthorization`, with `policyEnabledForInstallation: false`; this flag
does not claim the global module or shopper eligibility gates have passed.

14 focused merchant/history tests, full web TypeScript, changed-file ESLint,
Prettier and whitespace checks passed. Independent review found no concrete
security defect in this internal boundary. These tests mock the staff service and do not
prove real session authorization or request signatures. No HTTP route has been
added: the next layer must verify HMAC over the complete actor and input before
calling these functions, then connect the editor and signed Shopify client.

## September 20 — signed policy HTTP routes

Added POST-only internal `merchant/reviews/open-policy/read` and `write` routes.
They bound the complete request to 16 KiB, verify the existing service HMAC over
the original body before parsing, validate strict actor/input schemas, and return
private/no-store responses. Permission failures, replay, conflicts and invalid
sessions retain sanitized dispositions; unexpected failures do not expose details
or trigger automatic write retries. The exact Cloudflare route inventory includes
only read/write, still behind explicit Reviews opt-in and method checks.

The first route test run exposed a mocked service/schema coupling; the shared read
schema now lives in the policy contract module. The copied translation-specific
Unicode-body case was replaced by a policy-size rejection test. All 27 HTTP and
merchant boundary cases then passed using the real HMAC implementation with
synthetic test secrets and mocked merchant operations. No network endpoint was
deployed and this does not prove a live Shopify session or editor journey.

All 33 release-route tests, full web TypeScript, changed-file ESLint and whitespace
checks passed. Independent review found no concrete blocker in the new HTTP and
ingress changes; publication and runtime schema rollout remain gated.

The next integration remains the Shopify signed client and merchant editor,
followed by the shopper writer and source-aware media/Flow. Schema rollout must
precede route deployment. The R03 branch remains unpublished.

## September 20 — embedded Shopify client and authenticated action wiring

Added browser-safe open-policy contracts, separating schemas from server-only
Node hashing. The browser client obtains a fresh session token through the shared
transport, omits cookies, and never supplies store/staff identity. It validates
read-state consistency and rejects save receipts whose revision or any policy
field differs from the submitted command; ambiguous writes are never retried.

Two embedded POST action routes now use the existing merchant authenticator and
signed backend transport, with strict read/write input mapping. Their shared
handler retains its 16 KiB bound, timeout and sanitized failures. No editor has
been added yet, and no route was deployed.

48 focused client/policy/HTTP tests passed. These use simulated fetch responses
for the browser client and real service HMAC with mocked merchant operations for
backend HTTP checks. They do not prove the complete embedded authentication or
merchant editing journey on yamaxdev.

Seven additional embedded-action adapter tests passed, including authenticated
actor forwarding, denied-auth non-dispatch and sanitized permission errors.
Shopify typecheck/build and full web TypeScript passed before adding these final
adapter tests; the final web check and adapter-test lint also passed. Build emitted existing
sourcemap/deprecation warnings, not a build failure. Client boundary and action
tests use synthetic tokens/actors and mocked transports, not live authentication.
Independent review found no blocker in the browser import boundary, exact save
receipt validation or authenticated action mapping. Editor concurrency/recovery
and live acceptance remain outstanding.

## September 20 — merchant policy editor draft

Added an explicitly loaded open-policy panel to the embedded Reviews page with
EN/JA/VI copy. It edits open collection, photo eligibility and the 1–20 rolling
limit; disclosures state unverified/unrewarded participation, rating-independent
moderation, global photo prerequisites and separate module enablement. Old-install
policies show a reauthorization notice. Installation IDs never render in the DOM.

The panel uses a synchronous single-flight guard, ignores responses from discarded
client lifecycles, confirms dirty-draft reloads and disables controls during work.
An ambiguous or denied save clears the editable snapshot and requires a fresh
load rather than retrying. Revision overflow disables save. No write occurs on
initial rendering or language selection.

Six React component tests passed across three languages, including dirty reload,
simultaneous submissions, ambiguous failure recovery and stale-client response
rejection. These are jsdom tests with a mocked client, not 375px browser, screen
reader or live authenticated acceptance. Page navigation/unload draft protection,
rendered-theme visual QA and the shopper submission flow still need verification.

Independent review identified missing page-level draft/flight integration. The
panel now reports dirty state to the page guard and acquires the existing page
operation fence before reads/saves, releasing it only after settlement. Home and
beforeunload use those shared guards; generic EN/JA/VI leave prompts cover both
policy and translation changes. Eight component tests pass after adding lease
denial, dirty-state reporting and unresolved-save ownership cases. Full-page
navigation/browser acceptance is still outstanding rather than inferred from
these component callbacks.

After the guard correction, independent review confirmed the fix. Shopify
typecheck/build, full web TypeScript, focused-test lint, Prettier and whitespace
checks passed. The build retained its existing sourcemap/deprecation warnings.
No shared schema, live policy, deployment, order or send was changed.

## September 20 — internal text-submission transaction

Added `submitOpenReview` behind a mandatory in-transaction authorization callback.
It is not a public API or authentication implementation. The callback must supply
verified Shopify customer identity and source, never values from shopper JSON.
The transaction uses the operational store/generation fence, current enabled
policy from the same installation, privacy-aware identity-only author creation,
and a current owned active-product lookup. No loyalty enrollment is performed.

An owned exact replay returns a content-free receipt before rate counting; changed
content conflicts, and erased or foreign provenance fails closed. New writes must
match the current policy revision. The rolling limit uses the database clock and
current locking reads under the store lock. Review and provenance are inserted in
the same transaction. The review is always pending, unverified and unrewarded,
including one-star submissions. No invitation or historical order is fabricated.

Photo input currently rejects explicitly pending source-aware media ownership;
Flow production remains pending. Those capabilities remain required for the full
open-review journey. Fourteen focused tests passed using mocked transactions.
They prove branch behavior, not database atomicity, race safety, Shopify identity
verification, real moderation/display or live submission acceptance.

Independent review found no concrete blocker in this bounded writer and confirmed
that real SQL rate races and commit-loss replay still need evidence. The callback
is explicitly transaction-local/replay-safe because deadlock recovery may rerun
it; external sends or mutations are prohibited within it.

Full web TypeScript, changed-file ESLint, Prettier and whitespace checks passed.
No runtime, database migration, deployment or live submission was performed in
this increment. The next verification must exercise this writer against isolated
SQL, not infer atomicity from the mocked transaction tests.

## September 20 — submission writer isolated SQL acceptance

Added a production-service SQL case for simultaneous duplicate operations,
competing distinct submissions at a one-per-day limit, committed-operation replay,
and rollback on provenance insertion failure. It independently inspects content,
provenance, author/coverage, loyalty-account, invitation and ledger state. Accepted
one-star text remains pending, unverified and unrewarded. The replay simulates a
lost response by reusing an already committed operation; it is not process-kill
or real network-loss evidence.

Independent review caught a prepared-query trigger compatibility risk before
execution. The failure injection now uses the existing disposable-harness pattern:
a named CHECK constraint rejected by the synthetic Vietnamese provenance row,
then removed in `finally`. This does not impose a production language restriction.

Fixture `weletic_loyalty_it_shopper_c255fa991c35` passed 80 native and 154 shopper
SQL tests after exact draft DDL rehearsal. Its exact database/user were removed;
retained development ledger stayed at 16 entries. Full web TypeScript and changed
test lint passed after the CHECK correction. Author and merchant callbacks remain synthetic;
external Shopify identity, media and Flow are not certified by this SQL test.

Next gateway constraint: the current App Proxy review handler receives only shop
and subpath, not the verified logged-in customer. The open path must explicitly
carry authenticated customer context through a signed internal envelope; adding
customer identity to shopper body JSON would violate the writer's trust boundary.

## September 20 — trusted customer-data prerequisite

Added `readOpenReviewCustomer`, a server-only prerequisite for the authenticated
shopper gateway. It accepts already-verified Shopify identity, obtains credentials
from the generation-bound installed token authority, requires customer scope, and
reads only customer ID and default email. It performs no profile synchronization,
consent changes or loyalty enrollment. Reviews do not require an active loyalty
program. Store admission, installation generation, domain and review enablement
are checked before and after external I/O.

Only an explicit Shopify `defaultEmailAddress: null` means no email. Missing
protected fields, partial GraphQL errors, mismatched IDs, malformed email,
credential errors and upstream failures reject with a neutral error. Response
headers and body share a five-second deadline; body size is bounded at 32 KiB.
The transaction must still recheck authority, policy and privacy before writing;
this reader is not authentication and must never receive shopper JSON identity.

Reference fields were checked against Shopify's current
[Customer](https://shopify.dev/docs/api/admin-graphql/latest/objects/Customer) and
[CustomerEmailAddress](https://shopify.dev/docs/api/admin-graphql/latest/objects/CustomerEmailAddress)
documentation. Protected-data approval and live field availability remain open.
Independent read-only review found no concrete blocker in the bounded reader.
No public endpoint was added, and no Shopify request, live mutation, database
migration, deployment or background runtime was started for this increment.

Verification: 37 reader cases plus 14 writer and 13 identity-author tests passed
(64 total), with mocked Shopify transport and transaction dependencies. The
reader suite includes response-size, invalid UTF-8 and body-deadline rejection.
Changed-file ESLint passed. This is not live authentication or protected-data
acceptance; authenticated gateway wiring remains the next integration step.

## September 20 — App Proxy text-submission wiring

Connected `reviews/open-submit` to the existing authenticated App Proxy. The SDK
must authenticate before the gateway receives the customer context. The gateway
signs canonical customer ID and fixed `app_proxy` source separately from shopper
content. The backend verifies the service signature, rejects duplicate/unknown
context and content identity fields, resolves the exact shop domain, checks the
current enabled installation policy, and applies an attempt limit before reading
protected customer data. The writer rechecks domain/generation under its store
lock and retains its existing policy, privacy, ownership and accounting fences.
No email or customer identifier is returned in the receipt. Customer-account
submissions and photo input remain unavailable in this path.

Adversarial review caught a first/last-value discrepancy between URLSearchParams
and the installed Shopify SDK for duplicate query parameters. This new action now
rejects duplicate parameters before SDK authentication in both loader and action.
Actual proxy-route tests prove rejection without authentication or dispatch. The
release inventory also now admits this exact POST only with Reviews opt-in; this
is ingress preparation, not deployment or permission to submit a review.

An initial test-file syntax error and misuse of invitation-token hashing for the
attempt-limit key were fixed before acceptance. The final focused run passed 109
tests across seven files, including existing proxy regressions, customer-data
reads and submission writer checks. All 33 Cloudflare ingress tests passed, as did
full web and Shopify types, changed-file ESLint, Prettier and Shopify production
build. Existing build sourcemap/deprecation warnings remain. Follow-up independent
review confirmed both findings corrected with no remaining bounded-path blocker.

The SDK boundary is mocked in these tests; HMAC service signatures are real test
signatures. No live Shopify authentication, order, email or submission occurred.
This draft still needs shopper policy bootstrap/form, photos, customer-account
wiring, Flow and named live acceptance. No PR or deployment is claimed complete.

## September 20 — authenticated preparation and localized text form

Added signed `open-prepare` and static `open-write` App Proxy surfaces. Preparation
accepts only a canonical product ID and checks active store/generation, current
open policy, module enablement and owned active product under the store fence.
It returns current revision/disclosure metadata without customer lookup, profile
creation or enrollment. Its exact POST ingress is Reviews-opt-in. Photo support
is explicitly unavailable until source-aware media ownership is implemented.

The shared nonce/CSP form shell now renders an independent EN/JA/VI open-review
script. Disclosures state unverified/unrewarded participation and rating-neutral
moderation. It validates preparation, applies trim-aware input validation, keeps
submission state in memory, blocks simultaneous requests and preserves exact
payload/UUID on ambiguous retries. Network responses have bounded body/deadline
handling. Customer identifiers and email are never rendered or stored locally.

Review identified account-switch retries as a duplicate-creation risk. Preparation
now issues an opaque domain-separated HMAC binding for shop/customer/generation;
the backend checks it against current signed identity before protected reads or
writer access. It is stripped before the content writer and is not a standalone
authorization token. A signed switched-customer regression returns 409.

Review also identified whitespace/validation retry trapping. Local trim checks
prevent it; the gateway marks only its own pre-dispatch validation rejection as
safe to correct. Generic upstream 400 responses do not unlock a submission, and
once any response is uncertain, subsequent errors retain the exact original
payload. Independent re-review confirmed the fixes without a further blocker.

Final verification: 90 tests across five route/form/gateway suites passed, along
with 33 ingress tests, full web/Shopify types, changed web/test ESLint, formatting
and the Shopify build. Production form scripts run in jsdom with mocked transport;
this does not prove rendered 375px layout, keyboard behavior in a real browser,
Shopify account switching, protected-data access or live submission acceptance.
Existing build warnings remain. No live sends/orders, schema application or
deployment occurred. This remains an unpublished draft; photos, account surfaces,
Flow, browser acceptance and the full release gates remain outstanding.

## September 20 — real-browser synthetic mobile acceptance

Ran the production form renderer and script in a named Playwright browser session
(`weletic-open-review`) against loopback-only preview fixture
`weletic-open-review-browser.GFDLFt`. Its in-memory synthetic transport returned a
503 after recording the first operation, then accepted a retry only when the UUID
and complete raw payload matched exactly. No Shopify authentication, customer,
database, order, email or real review was involved.

At 375×812, the English form prepared and submitted with keyboard Tab/Enter;
Japanese language switching retained the draft and the same-operation retry
completed. A fresh Vietnamese journey repeated keyboard submission/retry with the
updated script. English and Vietnamese measurements reported scrollWidth 375 at
viewport width 375. Inspected Japanese and Vietnamese full-page screenshots had
no clipped form controls or horizontal overflow. Browser localStorage and
sessionStorage remained empty; the synthetic opaque author binding was absent
from markup. The only recorded browser console error was the deliberate HTTP503.

This check found focus falling to body when the disabled submit button lost focus.
The open script now moves focus to the enabled Retry control, associated with its
status message, or to the final status after completion. Browser evidence confirmed
activeElement `retry` on failure and active status on successful Vietnamese retry.
Focused jsdom assertions were added; all 35 open/invitation form tests passed,
along with Shopify types/build and test lint. Existing build warnings remain.

Screenshots are local synthetic artifacts in `output/playwright/`, not published
customer evidence. This bounded check does not close installed-theme, account
extension, real Shopify account-switch, live privacy, complete accessibility or
full R03 acceptance. Photos, account integration and Flow remain unfinished.

The English 1280px desktop screenshot was also inspected. Full web types and
formatting checks passed after the focus change. The named browser session and
exact loopback server were stopped; no preview listener remains on its port.
CLI snapshots/logs were retained under `output/playwright/open-review-cli-20260920`
with the screenshots, outside published source artifacts.

## September 20 — customer-account review gateway

Connected the existing Shopify SDK-authenticated customer-account action gateway
to only `reviews/open-prepare` and `reviews/open-submit` POSTs. The gateway uses
verified token destination/subject, signs fixed `customer_account` attribution,
and never accepts identity/source from shopper content or query parameters. It
reuses bounded review transport, pre-dispatch validation, CORS and private/no-store
responses; account responses vary on Authorization, proxy responses on Cookie.
Invitation, media, form-rendering and health routes are not exposed through this
account entrypoint. No new authentication model or schema was introduced.

The backend accepts either authenticated source while keeping the prepared author
binding and operation identity scoped to shop/customer/generation, intentionally
not to the display surface. Moving the same prepared operation between legitimate
surfaces cannot create a second operation. Writer provenance records the trusted
source. Account-switch binding failure still rejects before protected reads.

73 focused tests passed across the account/proxy/backend route suites, covering
real test HMAC signatures, SDK denial, malformed/missing identity, forged shopper
fields, unsupported routes/methods, CORS and upstream uncertainty. SDK verification
and backend transaction dependencies are mocked; this is not live customer-account
token or extension-network approval evidence. Full web/Shopify types, changed-file
lint, formatting and Shopify build passed; existing build warnings remain.
Independent review found no auth/tenant blocker and the Vary consistency note was
addressed. No live state, installed extension, database or deployment changed.

The account extension UI is still unfinished. Its existing page is loyalty-specific
and must not become a prerequisite for standalone Reviews; UI integration must
respect independent module enablement. Media ownership, Flow and release/live
acceptance remain open, so this draft is not a complete account-review journey.

## September 20 — attached-media privacy prerequisite

Photo-path inspection found that erasure discovered media through invitation
records only. Added `reviewOwnedMediaRedactionWhere` and a bounded 20-row cleanup
batch that discovers attached media through the review's own store/shopper.
Discovery and compare-and-set retain both media and parent tenant predicates;
ownership/status changes reject rather than acknowledging incomplete erasure.
Marking deletion-pending and enqueueing the existing idempotent cleanup job occur
in the caller's privacy transaction. The orchestrator deduplicates IDs, awaits
actual private-object cleanup, and counts remaining nondeleted owned media before
reporting completion. No financial record is changed.

55 focused tests passed across attached-media, original-content, moderation and
loyalty privacy suites, including pending retries, outbox failure, cleanup failure
and completion containment. These use mocked storage/transaction dependencies;
they do not prove real provider deletion or concurrency. Full web types,
changed-file lint and formatting passed.
Independent review found no concrete ownership/replay blocker in this prerequisite.

Open photo uploads remain disabled. `WeleticReviewMedia.requestId` is still
required, and unattached uploads need explicit store/shopper/generation/product
ownership plus immutable retry identity, bounded reservation/expiry and privacy
discovery before any upload writer or UI can be enabled. That additive schema
must be rehearsed in isolated SQL, with reader-before-writer rollout; no shared
schema or R2 state was changed in this increment.

## September 20 — unattached-media ownership and privacy readers

Added an optional invitation relation for media plus a separate
`WeleticOpenReviewMediaOwnership` record. Existing invitation IDs remain unchanged;
no fake request or purchase is created for an open upload. The prospective record
contains exact media/store/shopper/product ownership, installation generation,
policy revision, authenticated source, scoped submission/upload operation hashes,
private content digest and an erasure timestamp. The checked-in additive DDL is
`20260920_open_review_media_ownership.sql`. It activates no writer or setting.

Privacy now discovers attached originals and unattached reservation owners,
scrubs private content hashes while retaining terminal retry markers, awaits
actual deletion, and includes outstanding ownership in completion checks.
Adversarial review found two containment gaps; both were corrected: authoritative
review/request ownership also discovers mismatched secondary owner metadata, and
frozen-store purge drains media independently of missing or malformed parent
pointers. Purge refuses any selected nondeleted object and retains its cleanup
evidence. Other-store rows remain excluded throughout.

Authorized shopper and Shopify compliance exports include a bounded, explicit
open-upload metadata projection. It excludes object keys, content hashes, retry
keys and installation authority. This is metadata export, not complete image-file
export; that acceptance remains part of the disabled upload path.

Initial isolated rehearsal `weletic_loyalty_it_shopper_387c40ce227f` applied the
exact media DDL and passed 81 native-review plus 154 shopper SQL tests. Its exact
database/user were removed and the retained development ledger remained 16 → 16.
The second rehearsal `weletic_loyalty_it_shopper_ddae1c28a868` was interrupted by
the isolated MySQL container being OOM-killed (exit 137, `OOMKilled=true`, 768 MiB
container limit). SQL connections closed and automatic fixture cleanup could not
run. This is failed evidence, not acceptance of the final fixes. After restarting
the same container, the exact interrupted database and `wr_ddae1c28a868` user were
verified and removed; the retained ledger was still 16. No resource limit was
increased. Fresh final rehearsal `weletic_loyalty_it_shopper_df7385fdfb35` then
passed all 81 native-review and 154 shopper SQL tests (235 total), including the
ownership-corruption correction. Its exact database/user were removed; retained
ledger remained 16 → 16. Storage and Shopify transports were mocked throughout:
this is real SQL evidence, not live photo deletion or live shopper authentication.
The exact MySQL container, SSH port forward and isolated Lima instance were
stopped after verification. No background test or preview service was retained.

148 focused tests, full web TypeScript, changed-file lint and formatting passed
for the corrected predicates. Independent follow-up review found no remaining
blocker in this bounded correction. These results do not replace the final SQL
or real-provider acceptance.

This is reader-before-writer preparation, not a finished photo journey. Remaining
work before enablement: exclusive source authorization, atomically reserved
ownership/expiry jobs, per-submission and outstanding-upload quotas, byte-identical
retry semantics, before/after-PUT privacy/generation checks, exact attachment CAS,
safe public/download projections, authenticated upload gateway/UI, and real
private-storage acceptance. Existing open submission still rejects nonempty
`mediaIds`, prepare still reports photos unavailable, and no live setting, shared
database, provider resource, order or email was changed.

## September 20 — internal open-photo reservation and storage service

Added strict photo metadata/evidence contracts and the internal
`uploadOpenReviewPhoto` service. Identity is provided only by a mandatory trusted,
transaction-local authorization callback, never upload JSON. Store admission,
generation, current open-policy revision, both photo enablement controls, active
product and retained customer privacy are checked before decoding and around
storage I/O. Images reuse the existing bounded decode/re-encode/EXIF removal.
Customer settlement and media locks are retained.

Media, immutable ownership and the 24-hour expiry job are reserved in one store-
fenced SQL transaction. Exact retries reuse the same object identity; changed
bytes, encoding, product, submission or revision cannot reuse an upload operation.
The submission hash is the same identity later used by the review writer.
There are at most five nondeleted slots per submission. A customer's 24-hour
attempt budget is five times the saved policy's submission limit, including
deleted attempts and older generations. This bounds abandoned drafts as well as
accepted submissions; it does not grant extra reviews or loyalty enrollment.

Adversarial review identified a provider ambiguity hazard in immediate deletion
after a PUT timeout. The service now commits a durable one-shot storage claim
before PUT (`not_started → in_flight → confirmed | ambiguous`) with a private
attempt token. Only the process awaiting a successful PUT may record confirmed.
A confirmed PUT with failed SQL finalization retries without another PUT; an
unresolved write never re-PUTs or becomes proof of erasure. Media cleanup locks
the media and verifies settled exclusive ownership in the same transaction as
its deletion claim. Unknown storage outcomes also block privacy/purge completion.
These additional columns are part of the still-unpublished additive media DDL.

Unresolved records must not starve later privacy work: scrubbing candidates are
separate from completion accounting, and safe cleanup candidates exclude unknown
PUTs before pagination. A SQL fixture with 25 unresolved leading rows and a later
settled object exercises continued digest scrubbing and safe deletion while
overall privacy remains incomplete. This is containment, not provider recovery.

241 focused tests passed across 11 suites. Isolated rehearsal
`weletic_loyalty_it_shopper_bb7017817c32` passed 82 native-review and 154 shopper
SQL tests (236 total), including two simultaneous upload calls producing one
mocked PUT, exact replay, changed-byte rejection, no loyalty enrollment,
successful cleanup, ambiguous-write containment and multi-page privacy progress.
Full web TypeScript and changed-file lint passed. The exact fixture database/user
were removed, and the retained development ledger remained 16 → 16. These are
real SQL/normalizer checks with mocked storage, Redis locks and identity callbacks,
not provider, real distributed-lock or live Shopify acceptance.

Remaining before photo enablement: provider-specific authoritative reconciliation
for unknown writes (a missing HEAD result or elapsed timeout alone is insufficient),
attachment validation/CAS, authenticated upload gateway, localized upload UI,
coherent public/download ownership projections, real storage and live acceptance.
The existing gateway still rejects photo submission and reports photos unavailable.
No service was deployed and no private R2 object, order or email was created.

### Storage SDK one-shot correction

Source review of the installed `aws4fetch` implementation found that one call to
`storage.upload` could still perform multiple PUTs: its default client retries
429/5xx responses. Added an opt-in `singleAttempt` upload option that sets a fresh
client's retry count to zero. Open-photo writes opt in; existing callers retain
their default behavior. Single-attempt requests also reject redirects, preventing
a 307/308 from silently resending the body outside the reserved object identity.
The independent review identified the same redirect hazard; it is corrected.

13 focused tests passed using the real signing/SDK implementation with synthetic
credentials and mocked network responses, plus the upload-service regressions.
They verify one request for 429/500/503, the actual signed Request's redirect-error
policy, and preservation of the default retry/redirect policy for other callers.
This is not a real-provider acceptance test and does not resolve unknown writes.

The default-heap full TypeScript run exhausted Node's approximately 4 GB heap
without reporting a type diagnostic. The full non-incremental rerun with
`NODE_OPTIONS=--max-old-space-size=8192` and changed-file ESLint both passed.
Formatting and diff whitespace checks passed. Independent follow-up review found
no remaining blocker in this bounded SDK correction. The larger R03 branch is
still an unpublished draft; none of these checks closes its remaining live gates.

## September 20 — atomic open-photo attachment

The internal submission writer now attaches confirmed open uploads in the same
transaction as the pending, unverified, unrewarded review and its immutable
provenance. Current locking reads require exact store, shopper, product,
installation generation, submission key and policy revision. Both photo settings
must permit new attachments. Invitation-owned, mixed-source, expired, already
attached, redacted, non-normalized and unresolved uploads are unavailable. The
final attachment update rechecks expiry and requires the exact affected-row count.
Media locks precede ownership locks, matching cleanup and storage claims.

Exact accepted replays still return the original receipt before new attachment
eligibility checks; they never attach additional media or award participation
points. Source switching between the two authenticated surfaces does not create
a second operation. Public gateways still reject photos, and preparation still
reports photo uploads unavailable. No live feature was enabled or migration added.

65 focused attachment/writer/gateway tests passed. An initial parameterized test
used an empty array as an argument tuple instead of a row fixture; that test-only
setup error was corrected before the successful rerun. Full web non-incremental
TypeScript (8 GB heap), changed-file lint and diff whitespace checks passed.
Disposable fixture `weletic_loyalty_it_shopper_8aadc2cbe11c` passed 82 native-review
and 154 shopper SQL tests. It proves invalid selection and changed submission
rollback, concurrent exact submission producing one review/source/attachment,
rating-independent acceptance, replay and subsequent privacy cleanup. Storage,
authentication and Redis locks are synthetic; this is not live acceptance.
The exact fixture database/account was removed; the retained ledger stayed 16 → 16.

Independent review found no runtime blocker but requested an additional SQL
failure injected at provenance insertion after valid attachment, to prove that
the attachment itself rolls back. Dedicated fresh fixture
`weletic_loyalty_it_shopper_75461ef6e5c8` passed the extended open-photo test
(1 selected test passed; 81 unrelated cases skipped). A temporary disposable-only
CHECK constraint forces the provenance insert to fail after the valid media
update. The original/source counts remain zero and the media remains uploaded
with no review, followed by successful concurrent retry. The constraint is
removed in finally; exact database/account cleanup completed, ledger 16 → 16.

## September 20 — coherent public photo ownership

Listing and signed-download readers now share a private ownership projection.
Invitation photos require the same store/request/shopper/product as their review
and no open provenance. Open photos require an exclusive, unredacted immutable
submission and matching confirmed upload owner: store, shopper, product,
submission key, policy revision and historical installation generation. Object
keys and normalized size/type are checked too. Listing output explicitly maps
eligible media to IDs only; private owner, source, digest and key fields are not
serialized. Existing publication, admission and owner-privacy SQL checks remain
in the same repeatable-read transaction.

Upload expiry does not expire already attached published content. Matching
historical source/upload generation is intentionally distinct from current store
admission: reinstall must not rewrite accepted review provenance. This structural
rule does not constitute live reinstall acceptance.

63 focused ownership/service/requestless/translation-reader tests passed. Full
web TypeScript, changed-file lint, formatting and whitespace checks passed.
Disposable fixture `weletic_loyalty_it_shopper_3faf58c0b116` passed 82 native-review
and 154 shopper SQL tests. The open-photo case proves public listing and signed
download success after synthetic moderation, explicit private-field exclusion,
omission/no new signature for corrupted submission ownership, and denial after
privacy cleanup. The exact database/user were removed, retained ledger 16 → 16.
Storage signatures and authentication remain synthetic; no live object or
Shopify setting changed. Independent review found no bounded code blocker.

Follow-up fixture `weletic_loyalty_it_shopper_e6e3fb8e2686` passed both selected
open-photo and invitation-photo reader cases (2 passed, 80 unrelated skipped).
The invitation case additionally injects conflicting open ownership: listing
omits the photo and signing is denied without a provider call. Removing the
synthetic conflict restores the original fixture. Exact database/user cleanup
completed, ledger 16 → 16. Provider reconciliation, authenticated upload UI,
real storage and live `yamaxdev` acceptance still remain before photo enablement.

## September 20 — positive-evidence R2 reconciliation

Added an internal reconciliation helper and an opaque upload-attempt proof.
New one-shot PUTs include a domain-separated HMAC over the store/media identity,
keyed by the existing random 256-bit durable write token. Metadata contains only
the resulting non-authorizing proof—not the token, shopper identity or content
digest. No schema change is required, and the proof remains verifiable after
privacy scrubs content evidence. Legacy objects without this proof remain
unresolved; no retry or deletion authority is fabricated for them.

The reader accepts only the configured private bucket on the default direct
Cloudflare account S3 HTTPS endpoint. It rejects custom/CDN endpoints, uses a
signed HEAD with no cache, retries or redirects and a 10-second deadline, and
returns bounded size/type/proof metadata. Other R2 jurisdictions and providers
remain unavailable pending explicit provider compatibility validation.

[R2 consistency documentation](https://developers.cloudflare.com/r2/reference/consistency/)
states that direct S3 reads bypass cache and object/metadata reads are strongly
consistent. [R2 S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/)
documents HEAD support; [R2 custom metadata](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
documents object-associated user metadata. These guarantees support positive
matching-write evidence, not an inference that an absent object can never appear.
Real S3 metadata interoperability still needs provider acceptance.

Recovery locks media then its exclusive owner, reads metadata outside the SQL
transaction, and locks/rechecks every immutable attempt field before promoting
only `storageWriteState` to confirmed. Same-token in-flight→ambiguous drift is
allowed; changed token/key/owner/media state is not. Concurrent confirmation is
idempotent. Missing or mismatched metadata stays unresolved. No PUT, attachment,
publication, erasure declaration or content restoration occurs in this helper.

48 focused recovery/upload/state/storage tests passed, including the real SDK
signer with mocked network responses, changed ownership/state during HEAD,
concurrent confirmation, and preserved privacy erasure. Independent review found
no bounded implementation blocker. Worker discovery/fairness, runtime retry
integration, monitoring and real R2 acceptance remain unfinished; this helper is
not an operationally accepted recovery workflow and is not publicly exposed.

Disposable fixture `weletic_loyalty_it_shopper_82aae796c828` passed 82 native-review
and 154 shopper SQL tests. It exercises actual attempt metadata captured from the
mocked PUT, absent evidence remaining ambiguous, two concurrent positive
reconciliations after privacy scrubbing, a late ambiguous outcome failing to
downgrade confirmation, and subsequent object cleanup without another PUT.
Unrelated unresolved uploads still keep privacy completion false. Exact fixture
database/account cleanup completed; retained development ledger stayed 16 → 16.
Full non-incremental web TypeScript, changed-file lint, formatting and whitespace
checks passed. All remote storage/authentication behavior in this run is mocked;
no real provider object was read, written or deleted.

## September 20 — authenticated retry and cleanup recovery

Exact authenticated photo retries now invoke positive-evidence reconciliation
only after current owner, policy, generation, privacy and byte evidence pass.
They repeat those checks after recovery before finalizing. Changed content and
foreign or redacted ownership do not authorize recovery. Provider failures stay
generic; unresolved writes remain quarantined and are never uploaded again.

The existing media cleanup handler can reconcile an exclusive open-upload
attempt under its media lock, then repeat the original due, attachment and
deletion checks in a fresh transaction. Confirmation alone never authorizes
deletion. Mixed invitation/open ownership fails closed. This uses existing
expiry jobs; it does not prove scheduler leases, proactive discovery, fairness,
dead-letter monitoring or operational acceptance.

49 focused upload, reservation, cleanup and write-state tests passed. Disposable
fixture `weletic_loyalty_it_shopper_d269fa2b4e05` passed all 82 native-review and
154 shopper SQL tests, including exact draft DDL rehearsal. Added SQL assertions
cover changed-byte rejection before HEAD, absent evidence without a second PUT,
concurrent exact retries, a recovered-but-not-due cleanup job refusing deletion,
the same handler deleting after synthetic expiry, and privacy redaction during
HEAD preventing subsequent attachment. The latter preserves the scrubbed
content evidence while permitting safe cleanup of a confirmed object.

Exact fixture database/account cleanup completed; retained development ledger
stayed 16 → 16. SQL and worker-handler execution are real and isolated; provider
responses, expiry advancement and authentication are synthetic. No Shopify order,
email, production migration or real R2 operation was performed. Public photo
upload remains disabled pending authenticated gateways/UI and live acceptance.

## September 20 — signed photo gateways and shopper form

Connected `open-upload` through the existing authenticated App Proxy and
customer-account wrappers and signed backend route. Customer/source authority
comes from the verified gateway, never content JSON. Uploads retain the prepared
author binding and generation/revision fences. Transport is bounded to 3 MiB;
canonical base64 decodes to at most 2 MiB. The service rechecks ownership and
privacy around normalization, reservation and provider I/O. Receipts expose only
the owned media ID. The exact POST-only route is included in opted-in Reviews
release ingress; other methods and suffix variants remain denied.

The EN/JA/VI form now shows photos only when both current photo policies and
private-storage configuration permit them. It validates at most five nonempty
2 MiB JPEG/PNG/WebP files, reads them before dispatch, and retains exact bytes,
upload UUIDs and submission UUID across uncertain replies. Confirmed uploads
are reused on submission retry; accepted receipts clear retained photo payloads.
Submission attachment remains the existing atomic ownership-checked writer.

Independent review identified two correctable-photo traps: malformed images and
valid source images whose normalized WebP exceeds 2 MiB. Both now emit a typed
pre-reservation validation rejection. Only the exact upload route/status/code
can carry that signal through the gateway. The form permits correction/removal
only before any review dispatch; uncertain review outcomes remain frozen.
Previously uploaded objects abandoned by correction retain their expiry jobs;
the browser never claims they were erased. Generic errors cannot unlock this
correction path.

127 focused route, gateway, form and upload tests passed, including all three
languages, immutable retries, identity injection, changed domain, encoding
bounds, no-write validation failures and text-only correction. Shopify
typechecks, all 247 Shopify tests, Shopify production build and all 33 release
ingress tests passed. Web TypeScript and changed-file lint passed before the
final normalized-length guard (that guard has focused regression coverage).
The first full web regression stopped after 1,690 passing tests because the
local invocation omitted CI's synthetic `SHOPIFY_API_KEY`. The unchanged
store-validation harness then passed all 29 tests with
`SHOPIFY_API_KEY=quality-gate-client-id`, matching the checked-in quality job.
No authentication rule or test assertion was weakened. The full suite is being
rerun with that setting; it is not yet a completed gate.

Real Chromium at 375px exercised the actual renderer with synthetic upload and
submission lost responses. English and Vietnamese receipts, keyboard retries,
focus restoration, no horizontal overflow and absence of the private binding
in markup were checked. Japanese receipt, keyboard retry, focus and no-overflow
verification also passed. The synthetic server and browser session were stopped.
These checks did not
use real authentication, provider objects or Shopify transactions.

This supersedes the earlier gateway/UI-disabled draft notes, not live release
gates. No store policy was enabled. Customer-account review UI, open-review Flow,
live R2 metadata, installed surfaces and named `yamaxdev` acceptance remain open.

## September 20 — open-review Flow and retained privacy

Open submissions now enqueue the existing submitted Flow trigger in the same
transaction as content, photo attachment and immutable provenance. Exact replay
returns before enqueue. Actual transitions into publication enqueue the existing
published trigger for intact, exclusively open provenance as well as invitations.
No invitation, purchase, loyalty account or incentive is synthesized.

The worker validates store/review/shopper provenance, unverified/unrewarded
flags, intact private content evidence and source disclosure. Submitted events
bind to the original generation. Later publication uses the current fenced
generation without rewriting historical submission provenance. Mixed invitation
and open ownership, erased evidence and stale submitted generations fail closed.
Private content evidence never appears in Flow payloads. Remote delivery remains
at-least-once under ambiguous provider responses, not guaranteed exactly-once.

Independent review found that the old current-identity/expiry-filtered privacy
check was insufficient for this reader. All three eligibility checks now run in
the existing Serializable store-generation transaction and invoke the retained
owner check, including old email proofs, expired retained tombstones, terminal
coverage and account privacy markers. Transactions finish before acquiring the
customer distributed lock or performing credential/provider I/O. A second review
confirmed the bounded correction with no remaining blocker.

89 focused ownership, worker, producer and service tests passed. Disposable
fixture `weletic_loyalty_it_shopper_ae8c95c650fe` passed 88 native-review and 154
shopper SQL tests. Each of six new privacy scenarios first proves a healthy
dispatch through the real worker with mocked GraphQL, then proves zero additional
provider calls after expired/old-email/terminal suppression either before or
during credential resolution. Content intentionally remains pending to prove
privacy suppression does not depend on completed content erasure.

SQL also proves one submitted event per concurrent accepted operation, publication
of an unverified review without financial changes, and rollback of review,
provenance and new author when enqueue fails. The injected CHECK constraint is
limited to the disposable fixture and removed in `finally`. Fixture database and
account cleanup completed; retained ledger remained 16 → 16. Redis serialization
and remote GraphQL remain mocked; this is not a real Shopify workflow execution.

The broad regression rerun reached 6,964 passing tests and six skipped before a
failure in the Flow suite while those files were being edited. That mixed run is
not final verification. Final web TypeScript and changed-file lint passed against
the stable Flow implementation. Changed-file Prettier also passed after a formatting-only
correction to the merchant policy client test; its 11 focused tests passed again.
The fresh full suite completed successfully: 607 files, 9,825 tests passed and six
skipped (621.56 seconds). Full changed-web-file lint and Prisma validation also
passed; Prisma retained the existing relation-index warnings. The isolated
MySQL container, SSH forwarding and Lima runtime were stopped successfully after
fixture cleanup. No PR, deployment or live acceptance is
claimed. Customer-account UI, installed surfaces, real provider/Flow acceptance
and the remaining company-store release gates remain unfinished.

## September 20 — broad regression and merchant mobile verification

An additional independent read-only review covered signed open-submission and
customer lookup boundaries, proxy/account source binding, merchant policy routes
and the browser policy client. It found no concrete blocker: server-derived
identity, author binding, revision/generation checks, narrow responses and
Reviews enablement independent of loyalty enrollment remained intact. This is
bounded code-review evidence, not live authentication or whole-feature acceptance.

Chromium at 375px, using the actual `OpenReviewPolicyPanel` inside a Polaris card
with a synthetic in-memory client, exposed crowded inline labels and undersized
controls. The panel now uses separated grid rows, wrapping checkbox labels and
44px buttons/number input without changing policy or authentication behavior.
The focused component/client suites passed all 20 tests; Shopify typecheck and
production build passed again. The preceding broad 9,825-test result predates
this layout-only change and its one new regression test.

The English browser journey proved dirty-change confirmation, keep-editing,
keyboard save, exactly one synthetic write, no horizontal overflow and no private
generation marker in the DOM. Japanese also passed stale-installation notice and
keyboard save with one write. Vietnamese ambiguous-save testing proved one write,
no remaining stale form, a localized reload requirement, released operation lock,
no horizontal overflow and no private generation marker in the DOM.
Screenshots remain local ignored artifacts; no real settings were read or saved.
The permission-denied browser case returned the localized authorization message,
no form and zero writes. The browser and loopback fixture server were stopped
after checks.

The isolated Linux web candidate build compiled successfully in 7.8 minutes,
generated all 353 static pages and completed the Next build step in 582.1 seconds;
image-layer export completed using the existing two-CPU,
6 GiB/no-swap recipe and synthetic build-only environment. Its source snapshot
predates the merchant-only layout fix; do not treat that image as final branch
release acceptance. SQL stayed stopped, Docker Desktop was not started, and no
image upload, credentials or provider-connected operation is included.

The resulting local image was `sha256:00ce2beb49cddf59e25d4befde1aec7be692c844918366c9735a0015384735d5`
(Linux/amd64, 4,853,885,525 bytes reported after unpacking). The first smoke
invocation mistakenly used the config digest and failed before runtime testing;
the rerun used Docker's inspected immutable image identity and passed missing
configuration rejection, real Next unsigned/foreign-host/excluded-route rejection
and graceful shutdown with networking disabled. No smoke containers remain.
This image also predates the provenance privacy correction below and must not be
promoted as final release evidence.

## September 20 — orphan provenance erasure correction

The final media/privacy audit found that provenance erasure and its completion
predicate required a surviving same-store review. With `relationMode=prisma`, an
orphan or corrupt cross-store pointer could retain a private content digest while
the worker reported completion. The corrected predicate retains exact source
store scope and accepts either source shopper ownership or the same-store review's
shopper ownership. Whole-store scrubbing has no parent dependency. This inclusive
privacy predicate is not used to authorize submission, attachment or download.

Four new focused tests cover the predicate and bounded/timestamp-preserving
updates. The moderation privacy expectations now assert inclusive ownership and
identical selection/completion predicates; the combined focused run passed all
42 tests after correcting outdated test expectations. Independent review
confirmed the correction and the meaning of new SQL coverage without a remaining
blocker. Disposable fixture `weletic_loyalty_it_shopper_f11b8dfcfff0` passed all
90 native-review and 154 shopper SQL tests. New SQL checks prove 23 affected rows
drain as 20 + 3 without false completion, preserve the original erasure timestamp,
make replay a no-op, and leave unrelated/foreign sources, foreign review content
and financial records unchanged. Whole-store orphan erasure is separately tested
at the primitive level, not represented as frozen-store authorization acceptance.
Exact fixture database/account cleanup completed; retained ledger stayed 16 → 16.
Final non-incremental web TypeScript, changed-file lint, Prettier and diff checks
passed. MySQL, SSH forwarding and the dedicated Lima instance stopped cleanly at
22:39 JST. The final full web regression passed 608 files and 9,830 tests, with
6 skipped, in 616.80 seconds (started 22:37:59 JST). This supersedes the earlier
9,825-test checkpoint and includes the privacy correction and mobile regression.

The fresh complete Shopify suite passed 247 tests across 10 files after the
merchant mobile correction. All 141 release-policy Node tests also passed.
These are local regression results, not installed-store or provider acceptance.

Current activation gates remain explicit: private photo exports include metadata
only, not authorized image-file delivery. Complete that private export journey,
customer-account UI, real R2 and installed/authenticated journeys before claiming
open reviews accepted. Earlier historical statements that upload code is disabled
were superseded by gateway/form implementation, not by live activation. The module
and open policy remain default-off; compatible DDL must precede deploying readers.
