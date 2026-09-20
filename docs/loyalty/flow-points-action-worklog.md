# Owner-granted Flow points adjustment

## Approved scope and current boundary

The September 20 completion plan authorizes an owner-enabled scoped automation
grant, authenticated Shopify action requests, unique action-run identity and
no invented live staff identity. This branch starts from public main
`887b174a087a83d28ef39b54fc755674a9ca73bd`, separately from PR #90. No action
endpoint, grant or live writer is enabled by this planning document.

## Vertical-slice implementation plan

1. Add a strict, bounded action contract in `lib/weletic/loyalty/flow-action-*`:
   exact handle, Shopify shop identity/domain, action-run ID, customer reference,
   immutable grant ID and exact signed integer points. Reject unsafe numbers,
   zero, overflow, unknown actions and unsolicited properties. Do not accept
   caller-supplied staff, account, installation or ledger identity.
2. Add additive grant and action-run persistence in the Prisma Weletic schema
   and a reviewed local rehearsal migration. Grants bind store, current public
   installation generation, revision, authenticated approving owner and immutable
   authority. Owner configuration requires explicit credit/debit permission,
   per-action absolute limit, cumulative absolute budget and expiry; there is no
   default-enabled or unlimited grant. Editing replaces authority prospectively;
   revocation must linearize with ledger mutation. Readers precede writers.
3. Add signed merchant gateway/editor controls using existing Shopify identity,
   owner authorization, expected revision/generation, localized EN/JA/VI copy and
   audited grant history. Never reuse workspace-user email as automation identity.
   Show limits, expiry, used budget and revocation; grant IDs are identifiers,
   not bearer authorization. Reviews-only shoppers are not enrolled.
4. Verify raw-body HMAC with the isolated public-app secret before parsing or
   resolving a store. Match both canonical shop ID and its verified domain/alias;
   no provisioning fallback. The backend lifecycle receiver already provides a
   bounded-body/signature pattern. Require the new action handle; no fabricated
   legacy action-definition mapping. Use neutral errors without raw payloads.
5. Within the existing store/program/account transaction fences, lock grant and
   action-run authority, resolve the owned active loyalty account and privacy
   state, consume the budget and append the exact ledger adjustment atomically.
   Run identity is unique per store and action, independent of later grant or
   installation changes. A matching completed replay returns success without a
   second mutation; changed semantic payload under the same run fails closed.
   Persist a canonical digest, generation, grant revision and ledger receipt.
   Do not issue a separate built-in review award or treat the workflow as staff.
6. Add a public-only action manifest and exact release-route admission. An
   unapproved store, disabled loyalty, revoked/expired grant, stale installation,
   missing account, privacy tombstone or exceeded bound cannot write. No new
   public unauthenticated API and no permissive CORS. Shopify retries transient
   failures; successful response follows the durable commit, never precedes it.
7. Cover merchant controls, shopper accounting, dispatch, recovery and audit as
   one slice. Run isolated MySQL races for duplicate runs, changed payload,
   concurrent budget usage, revoke/expiry, reinstall and privacy; inject crashes
   around transaction commit. Run types/lint/builds/CI and independent review.
   Publish and exercise a named yamaxdev workflow only after scoped approval.

## Test and completion gates

- Unit/contract: exact integer boundaries, safe Shopify identifiers, byte limits,
  malformed/unknown fields, normalization and stable semantic digest.
- Auth/API: wrong HMAC, wrong app secret, foreign shop ID/domain, unapproved store,
  wrong handle, obsolete grant, no implicit staff session or loyalty enrollment.
- Financial SQL: one ledger entry and one budget debit per action run; concurrent
  duplicates converge; failed transactions leave no consumed budget or receipt;
  same run with changed customer/points/grant is rejected. Lifetime absolute
  budget never resets because a retry changes sign or crosses a day boundary.
- Revocation and generation: a writer commits before revocation or observes it;
  stale grants cannot acquire a fresh installation generation. Completed replay
  acknowledgment contains no private ledger/customer data.
- UI: EN/JA/VI, 375px, keyboard, load/error/permission states and revision conflicts.
- Live: real workflow receipt reconciles independently to SQL; no duplicate
  built-in incentive; revoked authority cannot write. Record exact cleanup and
  leave append-only financial evidence intact.

## Execution gates and risks

Local implementation and isolated SQL rehearsal are in scope. Shared/production
schema application, real point adjustments, publication, sends, orders and
production activation remain separately gated. No extra infrastructure is needed
for local work. Existing customer-settlement lock ordering and grant revocation
must receive independent review before publishing a PR. The extension is not
advertised as available before all applicable live gates pass.

Sources checked September 20:
[Shopify action endpoints](https://shopify.dev/docs/apps/build/flow/actions/endpoints),
[action reference](https://shopify.dev/docs/apps/build/flow/actions/reference).
Shopify authenticates requests with HMAC; `action_run_id` identifies an execution.
Its retry protocol is not proof of exactly-once app-side accounting.

## September 20 implementation checkpoint

Added the pure request/digest contract and 29 passing focused tests. Point deltas
are canonical non-zero signed 64-bit integer strings; numeric JSON point amounts
are rejected rather than rounded. Unsafe numeric shop IDs, unknown handles,
unsolicited staff/generation/account authority and extra properties fail closed.
Shop GID/numeric identity normalizes before hashing. Run key does not change when
the customer, grant or amount changes; the semantic digest does, so the future
transaction can reject conflicting replays instead of granting a new execution.

These are contract tests only. Persistence, raw-body HMAC route, current grant
checks, signed owner controls, ledger mutation, SQL races and live workflows are
not implemented by this checkpoint. No endpoint, schema, grant or financial writer
was enabled. Separate PR #90 remains under CI and is not a dependency of this
public-main-based branch.

## Persistence draft and review constraints

Added two additive Prisma models and matching draft DDL; schema validation passed
without applying the migration. Grants hold unsigned BigInt absolute limits and
usage; completed receipts have a store/app/run unique key and ledger reference,
with no TTL. Grant deletion is restricted while receipts reference it. Runtime
ownership checks remain mandatory because the repository uses Prisma relation
mode, not database foreign keys. The shared generated client has not been changed
for these new models yet.

Independent review requires privacy lock before SQL, then store → program →
grant → run → account locking, and fresh database time after authority lock waits.
Retain receipt/tombstone identity across customer erasure and reinstall. SQL
round-trip coverage must prove unsigned values including 2^63 through Prisma;
pure arithmetic tests alone do not establish provider compatibility.

Review also found that existing frozen-shop staff cleanup does not know about
new grants. Approval/revocation actor columns are now nullable with an explicit
`staffRedactedAt` marker. Before writer enablement, extend frozen-shop staff
erasure to clear these actor identifiers while retaining immutable grant policy,
opaque audit links and financial replay receipts. Ordinary customer privacy
requests must not erase merchant authority. A new grant must require an identified
authenticated owner; nullable storage exists only for later privacy cleanup.

The request and grant/budget contract selection now passes 48 tests. This includes
canonical signed deltas, explicit non-default grant authority, unsigned budget
bounds, credit/debit absolute consumption and abs(-2^63). Post-review schema
validation, focused lint, formatting and diff checks passed. No database has been
started or migrated for this action draft; unsigned Prisma round trips and actual
writer concurrency remain unproven.

## Frozen-shop privacy integration checkpoint

Frozen-shop staff erasure now selects at most 100 exact-store automation grants
with remaining actor identifiers, clears only the approving/revoking staff IDs,
and records `staffRedactedAt`. Immutable policy, budget usage, audit links and
financial run receipts remain intact. An empty subsequent read is required before
finalization; errors propagate to the existing transaction/retry boundary.
The focused contract/privacy selection passes 52 tests with mocked persistence.
Independent review found no concrete logic defect in this bounded erasure path.
Real SQL rollback, foreign-store isolation and unsigned round trips remain open.

Deployment ordering is mandatory: apply the additive grant/run migration and
regenerate the client before deploying this privacy reader, even if the Flow
action writer remains disabled. The existing shop-redact path unconditionally
queries the new grant table. A missing table must fail/retry, never be interpreted
as successful empty cleanup. Only then may owner controls/action writers be
enabled after their separate acceptance gates. No shared schema was applied.

PR #90 merged as `a6965d65079cd57fc15f558d977bace14790f4c0` after all six CI
checks succeeded; post-merge CI is separate and pending at this checkpoint.
The new Flow action remains an uncommitted, disabled implementation draft.

Existing compliance-worker and new staff-erasure regression selection passes
78 tests; focused lint, formatting and diff checks pass. This does not replace
generated-client typechecking or the planned real SQL/privacy acceptance.

## Isolated SQL compatibility failure — September 20

Rehearsed the checked-in draft DDL in fresh disposable database
`weletic_loyalty_it_shopper_7f7dcfb872a0`, using a newly generated Prisma 6.19.1
client from this branch. Four real MySQL tests ran: two passed and two failed.

- A budget of `9223372036854775807` round-tripped through Prisma and an independent
  SQL `CAST(... AS CHAR)` read.
- `9223372036854775808` and `18446744073709551615` failed at Prisma argument
  conversion despite the SQL column being `BIGINT UNSIGNED`. Pure BigInt tests
  and Prisma schema validation had not exposed this runtime incompatibility.
- The 101-grant frozen-shop privacy lifecycle passed: rollback leaves all actor
  records intact; two bounded batches and an empty reread finish erasure; a
  foreign store remains unchanged; authority, used budget, opaque audit links
  and the synthetic completed-run receipt remain unchanged. The receipt points
  to a synthetic ledger identifier, so this is retention—not ledger-write proof.

Exact disposable database and restricted user were removed in the runner's
finally block. Retained development ledger count remained 16 before and after.
No shared schema or real shopper state was changed. The shared generated Prisma
client now includes this draft schema; other worktrees must regenerate their
own compatible client before running checks.

Storage decision required before enabling the writer: prefer integer-only
`DECIMAL(20,0)` for the three nonnegative grant limit/budget/usage fields, preserving
canonical string boundaries and BigInt arithmetic. Alternative: retain unsigned
SQL storage behind a dedicated raw-SQL string/cast repository. Do not silently
restrict the approved contract to signed-64 absolute values or route through
JavaScript Number. Either representation needs the same real range/concurrency
tests; the current draft is not publishable as a completed action.

## Approved decimal storage correction — September 20

Hiro approved the recommended representation and delegated routine technical
execution. ADR 0041 records the decision. The affected fields are grant absolute
limit, budget and used quantities, **not Shopify identifiers**; the earlier chat
shorthand was incorrect. Shopify IDs remain strings and ledger/run deltas remain
signed integers.

The unpublished Prisma and fresh-table DDL now use `DECIMAL(20,0)` for those
three fields. `readFlowGrantQuantities` decodes exact ORM decimals into BigInt,
rejecting fractions, negative/nonfinite values, invalid ranges and inconsistent
limit/budget/used combinations. The future writer must validate canonical input
before SQL serialization: a scale-zero SQL column is not an input validator and
may round fractional input. No endpoint or financial writer is enabled here.

Fresh fixture `weletic_loyalty_it_shopper_ee4222fd9b1f` passed all **5 isolated
MySQL tests** after rehearsing the exact checked-in DDL. All three budget range
cases now round-trip through Prisma and independent SQL. Two simultaneous
minimum-signed debit consumptions yield one exact success and one explicit budget
rejection; a raw SQL reread proves used budget `9223372036854775808`. This tests
storage/locking/arithmetic, not action authorization or ledger posting. The
101-grant bounded staff-erasure test also passes with decimal fields.

The exact fixture database and restricted account were removed; retained ledger
remained **16 → 16**. The focused decoder/arithmetic unit suites passed **31
tests**. Independent review found no storage blocker. Preserve the earlier
unsigned-Prisma failures above as historical evidence; that representation
decision is now resolved, while the complete action and live workflow remain open.

## Owner-grant mutation service checkpoint

Added `manageShopifyFlowGrantInTransaction` for the future signed merchant
gateway. The caller must verify the full request signature and retain the
Serializable transaction through authorization, action audit and grant effects.
Current owner evidence is required in addition to `loyalty.configure`; delegated
configuration staff cannot create or revoke automation authority. Every operation
requires explicit expected installation generation and revision.

Creation requires an active program, explicit bounded policy and an expiry later
than fresh database time after lock acquisition. Revocation uses store/program/
grant ordering, exact tenant/app/generation ownership and revision CAS. It records
the authenticated revoking actor/action without resetting budget or altering the
original policy. A disabled/killed loyalty program permits revocation, not new
authority; store admission/compliance fences still apply.

The focused service/contracts/storage selection passed **43 tests** with mocked
authority and persistence. These prove forwarding, rejection, expiry and CAS
contracts, not live owner authentication, rollback or revocation races. The prior
decimal correction also passed a full web typecheck and 155 related unit tests.
The new service still needs current typecheck, independent review and real SQL
owner/grant integration. No merchant route, editor or action writer is activated.

## Owner authority and revocation SQL checkpoint

Fresh fixture `weletic_loyalty_it_shopper_a1d8b59411cf` passed **7 tests**, then
the expanded fixture `weletic_loyalty_it_shopper_864e97b76414` passed **12 tests**.
Both rehearsed the exact Flow DDL, removed their exact database/account and kept
the retained ledger at **16 → 16**. The environment uses synthetic encrypted
online/offline credentials with real persisted installation/session bindings;
the production owner authorizer runs without mocking. Network fetches are
forbidden. This is not a live Shopify authentication or HTTP/HMAC journey.

Verified: grant creation and merchant-action audit roll back together; delegated
configuration staff leave no grant/audit; a kill-switched program rejects new
authority but permits revocation; rolled-back revocation preserves the complete
grant; two competing revocations produce one committed revision increment and
one explicit conflict, with exactly one approval and one revocation action.
Expired sessions, changed generations, suspended admission and past policy expiry
cannot create grants. Another authenticated store owner cannot revoke a foreign
grant, and the foreign owner's failed action audit rolls back.

The service and fixture typechecks passed. Independent SQL-test review identified
two evidence gaps: generic rejection assertions and audit counts without resolving
the grant's approval/revocation references. Both were corrected: assertions now
check the exact error name/code/state, and both distinct action IDs resolve to
the expected store, app, installation generation, owner, user and permission.
Independent follow-up review found no additional issue in this bounded change.

Fresh fixture `weletic_loyalty_it_shopper_2990f12e3871` passed all **12 tests**
with these stronger assertions and the exact Flow DDL. Its database/account were
removed; the retained development ledger stayed at **16 → 16**. Formatting passed.
Owner UI, signed merchant routes, workflow financial writer, real Shopify calls
and live acceptance remain open. This draft is not a completed Flow action.

## Transactional execution checkpoint — September 20

Added the internal Flow execution primitive. It locks the store/current generation,
acknowledges matching durable receipts before new-write eligibility checks, and
requires active admission/program, a current unexpired owner grant, an existing
active account and both identity and durable metadata privacy checks for new runs.
The signed adjustment uses existing manual-adjustment semantics: no purchase,
review incentive or lifetime-earned/VIP credit is fabricated. Grant consumption,
ledger/cache mutation, receipt and storefront sync outbox commit together.
No shopper is enrolled automatically. Signed balance overflow fails closed.

Fresh SQL fixture `weletic_loyalty_it_shopper_59e0bb299d2c` passed 14 tests;
expanded fixture `weletic_loyalty_it_shopper_4847281b57ca` passed **26 tests**.
Both rehearsed the exact DDL, removed their exact database/account and retained
the development ledger at **16 → 16**. Coverage includes transaction rollback,
concurrent duplicate delivery, `9007199254740993` exact ledger/SQL reconciliation,
one sync job, payload-conflict rejection, overflow, revoked/expired/foreign/stale
grants, closed/privacy-marked accounts, direction and budget rejection, plus
completed replay after revocation, simulated erasure, kill-switch and suspension.
The erasure case simulates retained state; it does not run the privacy worker.

Independent review found replay-gate ordering and missing durable metadata
redaction checks; both were fixed and the expanded SQL run passed. Follow-up
review found no remaining blocker in this delta. Full web typecheck with the final
expanded fixtures, focused lint, formatting and diff whitespace checks passed.

Still unwired: the outer request handler must verify HMAC, resolve the paired
Shopify shop ID/domain and app identity, acquire customer settlement/privacy locks,
and own the Serializable transaction/retry boundary. These SQL tests call only
the internal primitive; they do not prove Redis privacy races, actual Shopify
workflow execution, merchant controls, HTTP authentication or live delivery.
No endpoint, extension publication, shared schema or production writer is enabled.

## Request orchestration checkpoint — September 20

Added `/api/shopify/flow/points-adjustment`, disabled unless
`WELETIC_SHOPIFY_FLOW_ACTIONS_ENABLED=1` and the runtime app ID matches the
existing public registration. It uses the existing `SHOPIFY_WEBHOOK_SECRET`
(the public app secret in the isolated web runtime) and optional
`SHOPIFY_WEBHOOK_SECRET_NEXT`, never a generic custom-app fallback.

The handler verifies exact-byte HMAC before lookup. Unknown stores cannot obtain
credentials, network calls or locks. Existing stores must have current mapped
native credentials. A bounded, read-only GraphQL query verifies BOTH the signed
shop ID and the canonical persisted domain; redirects are forbidden, timeout is
four seconds and streamed response size is limited to 16 KiB. Native credentials
do not inherit legacy aliases. Customer settlement locks precede the Serializable
write transaction, which rereads native credential revision/token and generation
before executing. No customer lookup, enrollment or token exchange uses Shopify.

Success and replay return empty 200 responses. Immutable run conflicts return
neutral 409 responses; uncertain commits and transient failures return neutral
503 for redelivery of the same run. No in-process blind retry, new run key,
credential, customer identifier or provider error is included in the response.
This follows the [Shopify Flow endpoint contract](https://shopify.dev/docs/apps/build/flow/actions/endpoints).

The request/handler/shared-auth selection passes **63 tests**. Handler tests use
mocked SQL, Redis and Shopify transports: they prove orchestration, not actual
credential-reader/SQL/Redis integration. Independent review found terminal
conflicts incorrectly mapped to retryable errors; this was fixed with regression
coverage. Replay, credential changes, second-read lifecycle rejection, oversized
and malformed upstream responses, unknown stores and privacy-lock failures are
covered. Final web typecheck, focused lint, formatting and whitespace checks
passed. Independent follow-up review found no additional blocker in this delta.

The endpoint is code only, not enabled or published. Owner UI/gateway, real
combined HTTP-to-SQL/Redis tests, extension packaging and live workflow acceptance
remain open. The earlier unwired-executor note describes the preceding checkpoint,
not this new handler. No shared schema or production setting was changed.

## Signed merchant grant gateway checkpoint — September 20

Added the internal POST gateway at
`/api/internal/shopify/merchant/flow-grants` for create/revoke. It bounds requests
to 16 KiB, rejects malformed UTF-8, verifies full body/path/timestamp HMAC before
parsing, separately validates the strict Shopify actor and operation-specific
policy, and invokes the existing owner-only primitive in one Serializable
transaction. Unknown fields, numeric point quantities, invalid revisions and
missing generation fences fail before SQL. Typed permission/conflict errors stay
neutral. Ambiguous grant commits are not automatically retried.

The route/service/contract selection passed **50 focused tests**. Route unit tests
use real HMAC but mock SQL/owner authorization. Fresh isolated fixture
`weletic_loyalty_it_shopper_df20c4693f85` then passed **27 SQL tests**, including a
combined HTTP → genuine owner authorizer → SQL case: body tampering is rejected,
valid create stores one grant/audit, nonce replay cannot duplicate it, and
delegated configuration staff leave no grant or audit. Credentials remain
synthetic; this is not a live Shopify login or browser test. Exact fixture cleanup
completed; retained development ledger stayed **16 → 16**.

Independent gateway review found no blocker. Typecheck, focused lint, formatting
and whitespace checks passed, including the added SQL fixture. Owner grant listing,
embedded controls, create-ambiguity recovery UX, combined Flow execution transport
tests and live workflows remain open. No runtime grant or production setting was
created; all database writes above were disposable fixtures.

## Owner listing and recovery checkpoint — September 20

The signed grant gateway now accepts `list`. The read primitive authenticates the
current owner and installation generation without writing an action audit. It
returns bounded pages (default 20, maximum 50), exact decimal-string quantities,
remaining budget and grant lifecycle state. Grant `active` describes its own
policy only, not whether the module/endpoint is enabled. No staff identifiers or
action IDs are exposed. Cursors must belong to the same store/app/generation;
equal timestamps use the grant ID as a deterministic tie-breaker.

An optional `approvalRequestId` resolves an uncertain create through its exact
scoped owner action and linked grant. It never falls back to a general list or
matches by similar policy fields. No match is not permission to resubmit
automatically. Pagination cannot be combined with recovery. Reads remain possible
under a module kill-switch so owners can inspect existing authority.

Focused read/route tests passed. Fresh fixture
`weletic_loyalty_it_shopper_c4f0daf145af` passed **28 SQL tests**, including real
owner authorization, exact quantities, same-time pagination, foreign cursor and
foreign approval-request containment, recovery and unchanged audit counts.
The fixture database/account were removed and the retained development ledger
stayed **16 → 16**. Independent review found no blocker; requested route-list and
foreign-recovery cases were added. An initial TypeScript callback-union inference
error was fixed with an async transaction callback; typechecking then passed.
Focused lint and formatting passed. No live grants or runtime settings changed.

Embedded owner controls and uncertain-response UX still need to consume these
contracts. This checkpoint is backend verification, not a completed merchant UI.

## Historical request authentication helper

While storage selection awaits approval, added the independent request boundary.
It requires POST and an explicitly server-supplied public-app secret, rejects
malformed signatures, bounds streamed/declared payloads to 16 KiB, verifies HMAC
over exact bytes before fatal UTF-8 decoding/JSON parsing, and applies the strict
action schema. Errors return only neutral status codes; successful output contains
only validated action fields. Explicit server-configured rotation is supported.
There is no development bypass, implicit staff identity or raw-payload logging.

The request/contract selection passes 44 tests; focused lint, formatting and diff
checks pass. Independent security review found no concrete defect in this helper.
It is intentionally unwired: no endpoint, public route admission, store lookup,
grant authorization or financial writer is enabled. Future execution must still
enforce paired shop/domain identity, current admission/generation, owner grant,
privacy and durable replay protection. HMAC alone is not adjustment authority.

The combined contract/grant/privacy/request/compliance selection passed 141 tests.
Two additional body-consumption and stream-error cases then passed in the
17-test request suite: invalid signature headers leave the body unread, and
stream failures return a neutral error while releasing the reader lock.
The initial full web typecheck exhausted Node's default 4 GiB heap; the full
8 GiB retry passed. The final combined selection passes 143 tests across five
files. This does not resolve the real unsigned-storage failures above.
PR #90 post-merge run `35476237558` completed successfully with all six checks
passing on merged commit `a6965d65079cd57fc15f558d977bace14790f4c0`.

## Embedded transport and stable attempt IDs — September 20

Added the embedded `/api/merchant/flow-grants` adapter and browser transport.
The existing Shopify authenticator supplies fresh shop/user/store/app/generation
authority. Browser input cannot contain an actor or tenant override. Initial
listing bootstraps the authenticated generation; writes require the previously
observed generation and revision, rejecting stale values before gateway dispatch.

Writes require a 256-bit `attemptId`, generated and retained before dispatch.
After authentication, the adapter uses it ONLY as the signed actor request nonce;
all authority-bearing actor fields remain Shopify-derived. This makes the original
approval queryable even when its HTTP response is lost. The durable audit key is
still app/store/generation scoped. The nonce is not a token or authorization grant.
The client obtains fresh bearer tokens, omits cookies, does not persist tokens or
automatically retry mutations, and exposes read-back separately. The UI must keep
its pending attempt until reconciliation and must not treat an empty recovery
result as automatic permission for a new attempt.

Strict response schemas preserve exact strings and check remaining-budget math,
allowed directions, lifecycle status against database observation time, duplicate
rows and cursor membership. Both transports check mutation acknowledgments;
revocation must match the requested grant and next revision. No internal actor
fields or upstream errors reach the browser.

The adapter/client/response-contract selection passed **35 tests** using mocked
Shopify authentication/gateway/network. Shopify and web typechecks passed after
fixing a Zod-version API mismatch and a test-only direct dependency import.
Focused lint passed. Independent review approved nonce handling and found missing
lifecycle consistency validation; it was corrected with negative tests. Final
follow-up review found no additional blocker. No SQL, live installation, grant, email,
workflow or deployment was changed in this checkpoint. The visual controls and
their pending-attempt state machine remain to be implemented and browser-tested.

### September 20 — owner controls and recoverable authorization intent

Added the shared EN/JA/VI owner Flow-grant screen and the authenticated
`/loyalty-flow` embedded route/navigation entry. Owners must explicitly choose
credit/debit directions, exact positive limits, expiry and consent. Revocation
requires confirmation. The screen shows exact remaining budgets and paginated
grant lifecycle state; it does not represent Flow as published or enabled.

Independent review found and drove fixes for lost recovery IDs on navigation,
page-window-dependent revocation recovery, stale consent across client/generation
changes, and permanently blocked correction after definitive validation rejection.
The browser now stores only the pending operation/recovery nonce in same-tab
session storage, keyed by the authenticated installation generation, before any
dispatch. Storage failure prevents dispatch. Restored entries are strictly parsed
and used only for signed read-back, never automatic replay. Tokens, shopper data
and staff identity are not stored. Clearing browser session storage or closing the
tab is not a durable operator recovery guarantee; server audit/grant records remain
authoritative. A confirmed invalid request allows explicit correction, while
conflict/timeouts/unknown outcomes retain the pending attempt. Recovery by exact
grant ID retains authenticated store/app/generation scope and cannot combine with
pagination or approval-request selectors.

Verification: **68 tests passed** across the jsdom shared screen, read service,
response contracts and embedded client/action selection. Web and Shopify
typechecks, focused web lint, Prettier and diff checks passed. Shopify production
build passed with the existing shared-screen sourcemap and framework-deprecation
warnings. Independent follow-up review found no further blocker in this bounded
UI change. These tests use mocked transport/SQL/Shopify authentication; they are
not new live or isolated-SQL evidence.

Still draft: real-browser 375px/keyboard verification, isolated-SQL regression for
the new exact-ID selector, complete Flow extension publication/workflows, fresh
public-main integration and full PR/CI gates. No deployment, live grant, order,
email, shared migration or running service was created by this checkpoint.

### September 20 — rendered controls and exact-ID SQL verification

Ran the actual shared screen with the built embedded-app CSS in Chromium using a
loopback-only synthetic transport fixture. EN/JA/VI each fit a 375px viewport
without horizontal overflow; 1280px desktop also fit. Visual inspection prompted
scoped 44px button/select targets, visible keyboard focus and larger checkboxes.
The selected locale now marks the section language for assistive technology.

The browser journey entered exact limits `9007199254740993` and
`18446744073709551615`, submitted by Tab/Enter, simulated a committed create with
a lost response, reloaded, observed disabled writes and recovered the original
attempt through read-back. It then confirmed revocation in Vietnamese, simulated
another lost response, and recovered the exact grant as revoked. One grant remained
and the pending journal was empty after confirmation; neither operation was
automatically replayed. The only console error was the fixture's absent favicon.
This verifies rendering/interaction with synthetic transport, **not** authenticated
Shopify installation or real Flow execution. Local screenshots/snapshots are in
the temporary `weletic-flow-browser.L5ET1B` fixture, not the public repository.

Extended the real SQL owner-read journey with exact grant-ID results for two owned
grants and an empty result for another tenant's grant. Fixture
`weletic_loyalty_it_shopper_ccfbfb4821c1` passed all **28 integration tests**, including
the exact additive DDL rehearsal. The harness removed only its fresh database and
restricted account; retained ledger rows stayed **16 → 16**. The dedicated MySQL
container, SSH forwarding and Lima instance were stopped after verification.
The temporary browser session and loopback HTTP server were also stopped.

The updated shared-screen suite passed **16 tests**; web typecheck, focused lint,
formatting and diff checks passed. The Shopify build passed after the scoped CSS
change, with the previously recorded non-fatal warnings. Remaining Flow gates:
extension definition/publication and real workflows, full current-main integration,
full verification/CI and release authorization. This is still an unpublished draft.

### September 20 — action manifest and release routing

Added the unowned `weletic-adjust-points` Flow action manifest, with a Shopify
customer reference and required exact-text grant/points fields matching the
runtime contract. Its URL targets the separate public API host. Added it to the
hash-fenced public staging inventory (now eleven extensions), with zero inherited
UIDs. No source/custom identity was reassigned.

Shopify CLI `app config validate --json` returned `valid: true, issues: []` on
the fresh private stage `weletic-flow-stage-80336a17-d232-44df-b731-d401ab586d47`.
The initial attempt to stage under the noncanonical macOS temporary path was
correctly rejected; using its canonical path succeeded. No dev/deploy/registration
command ran. Optional skill telemetry was opted out.

Added only the exact owner gateway and action runtime paths to Cloudflare's
existing loyalty admission list. Signature, owner, tenant, generation and runtime
enablement checks remain in the application; no prefix access was added.
Staging/action-contract tests passed **34 tests**; the release HTTP/admission suite
passed **33 tests**, including raw-body preservation and route-file existence.
Independent review found no blocker in the manifest/staging or exact route changes.

The [acceptance runbook](flow-points-action-acceptance.md) now specifies public
identity, bounded grant/workflow tests, independent financial reconciliation,
replay/privacy/reinstall cases, cleanup and queue-aware containment. Publication,
runtime activation, real workflows and complete current-main PR/CI verification
remain open. Config validation is not live acceptance.

### September 20 — current-main integration and final verification in progress

Preserved the complete draft in a named Git stash, fast-forwarded this branch to
public main `01a9ab591b245f43d88fd7e40de9d127d723b421`, and reapplied the draft.
Resolved two staging/test conflicts by retaining the merged review-submitted and
review-published triggers together with the new points action. The integrated
inventory is **13 unowned extensions**, not the historical eleven above. No
unrelated worktree or history was rewritten; the backup stash remains available.

The integrated focused regression selection passed **316 tests across 17 files**.
Prisma validation and Shopify typecheck/build passed. A full-diff format check
found one client-test import ordering issue, corrected by Prettier. Final
independent cross-cutting review found no additional blocker and independently
verified the thirteen-extension inventory and hash gates. The acceptance runbook
now explicitly requires schema-first deployment, including disabled-action
privacy readers.

Full web typecheck initially exhausted Node's default 4 GB heap, without producing
a TypeScript diagnostic; an 8 GB retry is in progress. The broad web unit suite
and sanitized-placeholder web build are also in progress. Their output is not yet
passing evidence. Do not publish or merge based on this checkpoint alone.

The 8 GB web typecheck retry subsequently passed. The sanitized-placeholder web
build also passed, including 353 generated static pages and both compiled Flow
routes in the Next app-paths manifest. Existing CSS/framework and unconfigured
build-provider warnings were non-fatal; this was a local build, not a deployment
or provider-compatibility test. Final formatting/lint checks passed. The broader
unit suite remains running; local commit checkpoint only, no PR publication yet.

### September 20 — full-suite disposition

The broad web run completed in 595 seconds: **9,006 passed, 30 failed, 6 skipped**
across 557 files (six failed files). Reproducing those six files without an app
fixture reproduced all 30 failures. They entered existing Shopify session
coordination with no `SHOPIFY_API_KEY` and failed `invalid_scope` (or assertions
downstream of that rejection). These were not failures in the new Flow suites.

Reran all six files with `SHOPIFY_API_KEY=quality-gate-client-id`, the same
non-secret app fixture already declared by the checked-in quality workflow:
**133 passed, zero failed**. No application/authentication changes were needed.
Do not describe the original broad invocation as green; its failure and the
configured rerun are separate evidence. The forthcoming PR must still pass the
complete applicable CI checks on its exact head before merge.
