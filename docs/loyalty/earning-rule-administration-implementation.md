# Shared earning-rule administration

Status: implementation in progress. No live acceptance or schema change.

## Pre-merge review-policy truth correction (2026-09-08)

PR #82 initially described product-review earning as publication-independent.
Cross-checking the unified acceptance matrix against `reviews/service.ts` found
that this editor configures legacy rules, not prospective incentive policies.
The native legacy writer requires publication; later moderation can reverse its
points. Requests with `incentivePolicyId` bypass that legacy path. Judge.me uses
its provider-specific accepted verification statuses, not a universal verified
purchase guarantee. Corrected EN/JA/VI copy and added rendered regression tests.
This fixes the unsupported UI claim, not the outstanding participation-policy
implementation. No financial behavior or existing promise was changed.

The full local suite on `d49358d4f5` passed 5,183 tests with six skips, non-web
package tasks passed, and web compile-mode plus Shopify builds passed. Existing
CSS gradient/browser-data/revalidate warnings remain. PR #82 is open; CI must
validate the corrected head before merge. Earlier whole-branch review missed
this cross-component wording issue; this evidence supersedes its no-blocker
conclusion for the original copy.

## Current release status (2026-09-07)

This section is authoritative for current status. The dated sections below are
an implementation archive: their statements that work was pending describe the
checkpoint when written, not the current branch. This is one increment of the
approved completion plan, not acceptance of all loyalty/reviews capabilities.

| Area                        | Current evidence                                                                                                                                                                                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared writer and transport | Implemented: legacy API compatibility, signed Shopify gateway, scoped workspace gateway, strict inputs, exact strings and revision preconditions.                                                                                                                                                 |
| Shared merchant UI          | Implemented and mounted in both apps; EN/JA/VI, read-only details, currency context, create/edit/retire. Duplicate workspace catalog/modal removed.                                                                                                                                               |
| MySQL transactions          | 38 cases pass, including four earning-rule cases using actual transactions and production services. Exact values, competing writes, rollback, retirement and tenant/generation rejection covered. No live reinstall proof or directly observed SQL lock ordering claimed.                         |
| Browser                     | Synthetic functional checks and desktop/mobile screenshot inspection pass, including currency copy, review bonuses, social URL validation and trigger reset. EN/JA/VI inspected. No live App Bridge, complete Shopify shell or yamaxdev acceptance.                                               |
| Late responses              | 19 mounted UI tests pass, including A → B → A late reads/writes, write-lock retention and unmount/replacement isolation.                                                                                                                                                                          |
| Checks                      | Whole-branch adversarial review found no production blocker at `970e3c9fc6`. Root lint: 10 tasks pass. Latest currency increment: 228 focused tests, both type-checks, Shopify build and 38 DB cases pass. Earlier full web run: 5,160 passed, six skipped; rerun required on final release head. |
| Release                     | PR #82 is open. Local full suite and compile-mode build passed before the review-label correction; corrected-head CI is required. No merge/deployment or live store acceptance.                                                                                                                   |

The isolated DB fixture cleanup completed. No shared migration, historical
backfill, external email, Flow publication or live-store operation ran. PR #78's
separate schema merge gate remains unchanged. PR #81 is already merged and its
foundations are integrated here.

Release-check update: repository-wide Prettier and root lint pass; Prisma schema
validation passes with pre-existing relation-mode index warnings. The added
navigation tests also pass web type-checking, focused lint and independent
review. The final release head still needs the complete unit/build/validator
run after any remaining implementation fixes.

## Implementation evidence archive

Historical pending-work statements below are superseded by the current status
above. Retained details distinguish simulated, mocked, actual-DB and browser
evidence and preserve the sequence of fixes.

## Visual and review/social browser evidence (2026-09-08)

Reopened the same local synthetic harness in fresh headless Chromium at
`5fb343a7a5`. Screenshots now succeed; the earlier headed-session timeouts are
not evidence of a rendering failure. Inspected desktop currency text, the
390-pixel-wide English review form, Japanese social form and Vietnamese saved
rule list. Labels and text wrap without overlap or horizontal overflow in these
views. The harness uses the shared screen CSS but not the complete Shopify
shell/Polaris provider, so host-app typography and navigation are not proven.

Browser assertions additionally verify a native-review save with 100 points,
25 photo bonus and 50 video bonus, inactive by default; changing the trigger to
X share resets activation and removes review-only fields. An HTTP destination
is rejected without a save; an HTTPS destination and share message produce one
valid social save without leaked review-provider conditions. The honor-system
warning is visible in Japanese. The saved Vietnamese list retains the actual
shop-currency context, URL, event limit and points.

Local artifacts are retained under ignored `output/playwright/earn-ui/`:
`review-mobile.png`, `social-ja-mobile.png`, `social-vi-saved.png`, and
`visual-cli-evidence/` (desktop screenshot, snapshots and console log). The only
console error was the local missing favicon. Browser and harness server were
closed. No network delivery, provider activation or live-store write occurred.

## Shop-currency context correction (2026-09-07)

Resolved the missing context found in local browser checks. Both authenticated
gateways project the current store's `shopCurrency`; malformed or missing values
become null without a USD fallback. The new response field is optional so the
new browser client still accepts older responses without it. The legacy API is
unchanged. Shared EN/JA/VI copy shows the current shop currency or unavailable,
and explains that each order's shop currency governs minimum-subtotal evaluation,
not Program accounting currency. No threshold FX conversion, earning-engine,
policy-revision or schema change was introduced.

Validation: 228 focused tests pass, all 38 actual MySQL cases pass (including
JPY projection through both gateways), web and Shopify type-checks, focused
lint, Shopify build and independent review pass. Tests cover USD/JPY/VND/BHD,
malformed/missing values, old responses, and currency visibility while editing.
Real-browser visual verification of the updated copy remains pending, as do
the broader branch release gates.

## Local browser functional evidence (2026-09-07)

Ran the actual shared `EarningRulesSession` and Shopify browser client in headed
Chromium against an in-memory synthetic fetcher. The local Vite harness lives
under ignored `output/playwright/earn-ui`; it contains no credentials and
refuses unexpected fetch URLs. This is UI/client proof, not signed HTTP,
App Bridge authentication, backend persistence or live Shopify acceptance.

Observed with browser assertions and accessibility snapshots:

- One create request preserves `9007199254740993`, `1.2500` and `123.45`
  as strings; the saved list displays the exact point cap.
- Editing and switching EN → JA → VI → EN retains the draft.
- At 390 × 844, the Japanese editor has no horizontal DOM overflow.
- Keyboard submission rejects `1e3`, marks the multiplier invalid, displays an
  alert, and sends no additional save request.
- A synthetic 503 clears editing controls and requires reload, without an
  automatic save retry. Reloading into read-only mode preserves exact details
  and hides create/edit/retire controls.
- Retirement sends nothing before confirmation; keyboard confirmation removes
  the rule and returns the empty list after a validated acknowledgement.

Screenshot capture timed out twice despite a responsive page; visual screenshot
inspection remains unproven. The only initial console error was a missing local
favicon. The harness does not exercise workspace navigation, real permissions,
review/social rules, or live store installation changes.

Release follow-up found during this check: the minimum-subtotal field lacks
currency context. `earn.ts` converts that threshold using the order's shop
currency (falling back to presentment currency, then USD), not Program accounting
currency. Restore an accurate shop-currency context in the shared contract/UI
without silently changing the earning engine. Browser visual inspection and
the remaining interaction matrix are still release gates.

## Actual MySQL earning-rule evidence (2026-09-07)

Extended the existing guarded staff database suite with four earning-rule cases.
All 38 cases pass against the isolated `127.0.0.1:3307/weletic_loyalty_dev`
database as `loyalty_dev@%`. The suite invokes production signed HTTP routes,
authorization, workspace services, store fencing and Prisma transactions.
Only the privacy-identity helper is replaced by a synthetic local identity;
the Prisma singleton points to the actual guarded client and fetch is forbidden.

- Exact `9007199254740993` point-cap and decimal persistence, with identical
  workspace and Shopify revision projections and no program creation on reads.
- Competing workspace/Shopify multiplier updates produce one winner and one
  rejection, with exactly one additional financial-policy revision.
- A deliberate post-write exception rolls back the rule, program, policy and
  authorization receipt; the same nonce succeeds after rollback.
- Competing update/retirement requests preserve the winner's immediate state;
  retired rows cannot be resurrected, and rejected writes leave policy,
  receipt counts and editor revision unchanged.
- Stale expected generations and foreign-store rule IDs are rejected by both
  gateways without changing either store's policy or revision.

The initial race test changed only the name and incorrectly expected another
financial snapshot. Existing policy deduplication correctly reused the unchanged
snapshot; changing the multiplier now tests a real financial-policy change.
These tests observe committed competing-request outcomes, not SQL lock ordering
or a live installation transition. Fixture cleanup completed. No migration,
Shopify store operation or external send ran. Independent review found no
blockers; broader browser/release gates remain open.

## Duplicate editor cleanup (2026-09-07)

Removed the unused 495-line legacy earning-rule modal after a repository-wide
reference check and independent review. The shared workspace/Shopify editor
remains; the legacy API is retained for compatibility. The deleted source is
recoverable from Git history. The baseline below describes the pre-change state.

All 218 focused earning-rule tests across 15 files, web lint and web type-check
pass. Shopify type-checking exposed an implicit-any inference in the shared
read-only condition display; explicitly treating entries as unknown preserves
the existing provider guard without a suppression. Independent review, seven
screen tests, Shopify type-check/build and all 21 Shopify unit tests pass after
that fix. The full web unit suite passes: 333 files, 5,160 passed and six skipped
tests. Database concurrency, browser acceptance and release gates remain
pending; this cleanup does not establish live acceptance.

## Scope

Continue approved Unified Completion Plan packages 4 and 8: share earning-rule
configuration between the Weletic workspace and embedded Shopify, retaining
the existing earning engine, immutable policy publication, and review-provider
eligibility checks. Do not create a second ledger or reinterpret historical
earn-policy snapshots. This increment does not complete subscriptions, referral
settlement, review collection or all merchant interfaces.

PR #81 (configuration) was released separately and its verified merge was
integrated into this branch. The earning-rule PR will target main directly.

## Initial baseline evidence (before implementation)

- `apps/web/app/(ee)/api/shopify/loyalty/admin/earn-rules/route.ts` contains legacy
  validation, defaulting, review-provider activation checks, CRUD and policy
  publication. GET does not initialize a missing program. POST can create a
  draft; DELETE soft-retires a rule and publishes a policy revision.
- Workspace `modules/tab-earn.tsx` and `modals/modal-earn-rule.tsx` provide the
  existing editor. There is no embedded earning-rule route in the current main.
- POST validates positive points/multiplier, priority, non-order event limits,
  fixed action limits and conditions. Legacy Number/BigInt coercions are not a
  suitable strict exact-string contract for new clients; preserve compatibility
  at the old boundary while new inputs enforce actual database ranges.
- DELETE reads program/rule ownership before acquiring the mutation fence.
  The extracted writer must recheck ownership and retirement inside the caller's
  transaction, including stale requests, rather than rely on the earlier read.

## Implementation sequence

1. Extract transport-neutral validated rule inputs and transaction-local
   create/update/retire primitives. Preserve the legacy API response envelope,
   accepted inputs/defaults, and error messages unless a demonstrated bug needs
   an explicit compatibility treatment. Caller retains authorization/fencing.
2. Add bounded strict browser-safe contracts and minimal projections. Use exact
   decimal/integer strings, canonical condition schemas, generation and
   state-revision preconditions. Keep raw metadata and credentials off responses.
3. Add signed Shopify gateway with fresh `loyalty.read`/`loyalty.configure`
   authorization, owner requirements where existing policy requires them,
   transaction-local installation fencing and no automatic mutation retry.
   Workspace gateway uses scoped workspace permissions, never fabricated staff.
4. Share EN/JA/VI rule-list/editor components with thin navigation/auth adapters.
   Preserve tier/reward/catalog boundaries, provider eligibility, and explicit
   honor-system labels for social actions. Replace duplicate active editors only
   after feature-preservation tests pass; retain old URLs/API compatibility.
5. Verify and publish a focused PR through full local checks, adversarial review,
   CI and the existing auto-merge guards. Live yamaxdev acceptance remains a
   separate gate; n0pvef-cs and competitor trials are untouched.

## Tests and risks

- Legacy route regression tests before/after extraction; reads never initialize.
- Production writer tests: tenant ownership, soft-deleted rules, provider
  enablement, single immutable policy publication, rollback and stale workers.
- Strict input/response tests: exact values and database boundaries, trigger and
  condition validation, limits, explicit booleans and no silent rounding.
- Isolated MySQL concurrent updates/retirement and installation changes; label
  mocked execution and observed database evidence separately.
- HTTP HMAC/tampering/replay and workspace scoped-token/owner cases; bounded
  bodies, private responses, sanitized errors and uncertain-response recovery.
- Shared UI: all supported rule kinds, three locales, read-only controls,
  creation/update/retirement, failed saves and cross-workspace navigation.
- Root formatting/lint, web and Shopify types/builds, Prisma, full Vitest,
  relevant validators and service-backed Playwright before release claims.

No automatic database migration, historical repair, external test sends,
extension publication, provider cutover or deployment is authorized here.

## Baseline evidence (2026-09-07)

Replaced the old two Prisma-mock-only assertions in `earn-rules-api.test.ts`
with 16 tests invoking production GET/POST/DELETE. Coverage includes empty and
populated reads, exact response serialization, order defaults, fixed action
intervals, successful and rejected scoped updates, native/Judge.me provider
activation, invalid inputs, soft retirement and the legacy `id` alias. The
authority wrapper, database, mutation fence and policy publisher remain mocked;
these tests establish route behavior, not real authorization or rollback.

Fresh-worktree dependencies were installed from the offline lockfile cache and
workspace packages built. Initial collection failed until the route test used
the same `server-only` test marker mock as the existing route suites. All 16
tests and focused lint pass. Review requested the additional successful-update,
serialization, provider and alias cases, which are now covered. Production
extraction and the new strict gateways/editor remain to be implemented.

## Shared writer extraction (2026-09-07)

The legacy route now delegates create/update and soft retirement to
`lib/weletic/loyalty/earning-rule-writer.ts` inside its existing mutation fence.
The caller still owns authorization, validation, installation checks and the
transaction lifetime. Provider enablement and immutable policy publication stay
inside that transaction. Transport-neutral errors are adapted to the existing
workspace error codes/messages.

Retirement additionally rechecks program ownership and non-retired rule identity
after entering the transaction. A test supplies an available pre-fence record
then an unavailable in-transaction record and verifies no write/publication.
This proves the recheck, not actual concurrent SQL contention.

Review caught overly permissive Prisma-derived inputs: normalized fields are now
required, including activation, and lifecycle/identity fields are excluded.
The legacy route already supplied explicit activation, so no existing HTTP
bypass was found. Compile-time assertions cover this new internal contract.
Strict public contracts, gateways, shared editor and MySQL race proof remain
pending. No production earning calculation, schema or live store was changed.

Verification: 135 route/admin/RBAC regression tests passed after extraction;
the final focused route suite passes 18 tests including the internal type
assertions (validated by a passing web type-check). Focused lint, formatting and
final review pass. The fresh-worktree default 4 GB type-check exhausted its heap;
the final run passed using the existing CI 8 GB setting. No dependency or CI
configuration was changed to accommodate that local check.

## Browser-safe customer-intent policy (2026-09-07)

Extracted the existing pure URL, provider-host and share-action helpers into
`customer-intent-policy.ts`, with compatibility re-exports from the server-side
earning service. The new entry point has no imports or database dependencies.
This enables the upcoming strict shared editor contract without duplicating
policy or importing server services into a browser bundle. Existing normalization
and honor-system labels are unchanged.

Verification: 76 existing earning-action and route tests plus 10 direct policy
tests passed. Web type-checking with the existing 8 GB setting, focused ESLint,
formatting and independent read-only review passed. This is local refactoring
evidence, not a completed editor, browser bundle proof or live-store acceptance.

## Strict earning-rule input (2026-09-07)

Added a browser-safe full-field schema and write/retire envelopes with explicit
installation generation and state revision. Decimal and BigInt values remain
strings on the wire and are converted directly by `parseEarningRuleData` after
revalidation. No client-provided store/program authority or lifecycle columns
are accepted. Legacy endpoint coercion is unchanged.

The contract checks trigger-specific limits, purchase tax/shipping exclusion,
explicit review provider settings, provider-specific HTTPS URLs and database
numeric/string bounds. Review found and corrected the description column bound
and effective review award overflow; the latter uses the existing maximum media
bonus and explicit event cap semantics, not a new bonus calculation.

The contract/parser and legacy route suites pass 55 tests. Web type-checking,
focused ESLint and formatting pass; BigInt constructors retain compatibility
with the repository's TypeScript target. Independent review
reports no remaining blockers. These schemas are not yet connected to the new
gateways or editor; stale-token validation is a shape check only until the
transactional revision comparison is implemented. Schedule/tier fields remain
outside this write contract and must be preserved by later scoped updates.

## Transaction-local revision orchestration (2026-09-07)

Added internal read/save/retire helpers. Reads never create a program. Mutations
validate the input generation against the gateway-supplied trusted generation,
compare a stored-state fingerprint, invoke the existing writer on the supplied
transaction, then reread the saved state. Failures are propagated without retry.
Gateways must still authorize and acquire/recheck the live store fence before
calling; these helpers neither establish authority nor open transactions.

The fingerprint includes program lifecycle/policy revision and all non-retired
rule fields, including schedules and tier eligibility not editable in the new
contract. JSON object keys are canonicalized, rules are queried by stable ID,
and BigInts are serialized exactly. This is a state fingerprint, not a write
counter. Internal rows must not be returned directly as a public API response.

Verification: 68 service/contract/legacy-route tests passed, followed by 14 final
service tests including JSON key-order equivalence. Web types and focused lint
pass. Independent review found no blockers. Persistence and the underlying
writer are mocked in the service tests: they do not prove rollback, locks,
authorization or concurrent acquisition. Gateway and MySQL proof remain pending.

## Internal Shopify staff gateway and response (2026-09-07)

Added the transaction-local Shopify adapter using fresh `loyalty.read` or
`loyalty.configure` authorization, expected-generation checks, the existing
operational write fence, and a post-fence workspace-binding read. All operations
use the caller's transaction and trusted actor store identity. The signed HTTP
route is not yet connected; the helper requires prior signature verification.

The strict public response projects exact editable fields, visible schedule/tier
constraint markers and capabilities, not raw database rows or unknown JSON.
Legacy fields that fail the new contract remain visible with an explicit review
reason and no editable payload; missing review-provider defaults are not silently
reinterpreted. Later UI work must show this state and preserve historical data.

Nine gateway/projection tests pass with mocked authority, fence and persistence;
the combined contract/service/legacy-route/gateway regression passes 78 tests.
Web type-checking, focused ESLint and formatting pass.
Independent review found no blockers. This does not establish signed HTTP or SQL
security evidence. The future HTTP route must classify invalid stored response
data separately from invalid request input, even when both originate as schema
validation errors. Workspace gateway, browser clients, editor and real database
tests remain pending.

## Signed internal HTTP endpoint (2026-09-07)

Connected `/api/internal/shopify/merchant/earning-rules` to the staff gateway.
The endpoint bounds the body to 16 KiB, verifies the signature over the complete
body and path before database access, validates the actor/request envelope, and
opens one Serializable transaction. Errors are sanitized with private/no-store
responses. Unknown errors and schema failures after request validation return
503, not a misleading client-input 400. No mutation is automatically retried.

The 18 HTTP tests use production HMAC verification and body reading, but mocked
database/gateway calls. They cover signed reads/save/retire, unsigned requests,
actor/operation/path tampering, expired signatures, malformed and oversized UTF-8
bodies, error mapping and no-retry behavior. Combined earning-rule regression:
96 tests passed. Web types, focused lint and formatting pass; independent review
found no security blockers. This is not live staff authorization, actual replay
consumption, transaction rollback or MySQL concurrency proof. Remix transport,
workspace gateway and merchant editor remain pending.

## Remix authenticated transport (2026-09-07)

Added `/api/merchant/earning-rules`, wired to `withAuthenticatedMerchant`.
The action validates bounded input, forwards the authenticated actor and request
using the existing signed service client with an eight-second abort signal,
validates the response contract and returns sanitized private responses. Reads,
saves and retirements use POST; GET is rejected. No automatic mutation retries.

Eighteen action tests pass, covering all operations, injected authority, malformed
input, authentication rejection, upstream statuses and invalid response data.
Authentication and forwarding are mocked here; SDK authentication, actual HMAC
signing and timeout enforcement are not independently established by this suite.
Web/Shopify types, focused lint, formatting and the Shopify build pass.
Independent read-only review found no blockers. No deployment or store changes.
Browser client, shared merchant editor, workspace gateway and real database
integration remain pending.

## Browser client and mutation acknowledgement (2026-09-07)

Added the embedded browser client using the existing fresh-token, cookie-free
POST transport. It validates input before requesting credentials and validates
responses before acknowledging success. Save responses identify the affected
rule using the persisted writer result; retirement returns the target identity.
Reads and older responses default this additive field to null, but the new client
requires it for every mutation acknowledgement.

The client checks installation generation, affected identity, exact rule fields
and retired-rule absence. Decimal strings are canonicalized without Number;
customer-intent URLs use the same normalization as the server. It does not retry
ambiguous writes. The existing transport deadline covers token acquisition,
fetch and response body reading.

The 55 client/service/gateway/Remix regression tests pass, including wrong IDs,
large integer mismatch, stale installation, HTTP errors and an actually stalled
response-body promise under fake timers. Independent review found no blockers.
The client is not yet mounted in an editor; live App Bridge and SQL concurrency
acceptance remain pending.

## Shared acknowledgement and workspace browser transport (2026-09-07)

Extracted the exact response acknowledgement into a browser-safe helper shared
by Shopify and workspace clients. Shopify keeps its existing error classification
and fresh-token transport. The new workspace client uses an explicitly encoded
workspace ID, same-origin credentials, private GET/POST requests and one
eight-second deadline covering fetch plus response-body parsing. No retries.

Twenty-four client tests pass, including the retained Shopify acknowledgement
regressions, workspace scope encoding, malformed responses, invalid inputs,
HTTP errors and stalled fetch/body promises under fake timers. Independent
read-only review found no blockers. No browser rendering or live authentication
is proven by these tests; the shared merchant editor remains to be connected.

## Shared editor form model (2026-09-07)

Added typed draft form state, inactive new-rule defaults, explicit trigger-change
reset and conversion through the strict earning-rule contract. Points and decimal
values stay strings; only bounded integer fields use numeric conversion. Blank,
exponent, fractional and out-of-range integer inputs fail validation. Activity
awards require an explicit value rather than an invented default amount.

Trigger changes retain name/description/priority but reset activation and
earning-specific settings. Valid stored fields round-trip without changing exact
values. Nineteen model tests pass across all supported triggers; independent
review found no blockers. This is not a rendered UI or accessibility/localization
proof. The shared form component and transport mounting remain pending.

## Rendered localized rule form (2026-09-07)

Added a controlled React form with complete EN/JA/VI control labels, trigger
options and policy disclosures. It renders purchase, activity, social and review
settings conditionally; financial inputs remain text-backed. Social actions are
explicitly honor-system, and review rewards are described as independent of star
rating/publication. Parent screens retain transport and lifecycle ownership.

The initial model/rendered regression passed 26 tests; the final rendered suite
passes 10 tests after adding invalid URL, bonus and interval feedback cases.
Review caught missing control annotations for nested conditions/selects, now
fixed with aria-invalid and associated alert text. Final review found no blocker.
This is jsdom rendering, not visual browser, keyboard audit or live acceptance.
List/create/edit orchestration, uncertain-save recovery and mounting in both
merchant interfaces remain pending.

## Shared rule-management screen (2026-09-07)

Added localized list/create/edit orchestration, read-only controls, a retirement
confirmation and explicit reload recovery. Mutation uncertainty removes the
editable state; no automatic retry. Scope changes remount inner state, and a
synchronous outer lock prevents duplicate writes while an earlier write remains
pending. Reads and write completions are fenced against newer read generations.

Review found that an older save could overwrite a fresh denied read after a
same-scope transport replacement. Added the generation check and a held-save
regression; final review found no blocker. Six mounted jsdom tests pass, covering
save revisions, retirement confirmation, uncertain recovery, read-only access,
duplicate synchronous submissions and the stale callback regression. This is
not real-browser or live authorization proof. Mounting in Shopify/workspace,
broader navigation tests and MySQL verification remain pending.

## Embedded Shopify mounting (2026-09-07)

Mounted the shared screen at `/earning-rules` with links from the embedded
homepage and Loyalty configuration. The route reuses the data-free authenticated
settings bootstrap; reads and writes use fresh App Bridge tokens through the
new client. Added the shared EN/JA/VI language selector without remounting edits.

Seven mounted screen tests pass, including locale changes preserving an active
edit without a new read. Shopify type-checks, unit tests and build pass; web
type-checking and focused lint pass. Independent review found no blocker. This
is local code/build evidence, not a deployed Shopify or real-browser journey.
The existing workspace Ways to Earn tab still uses its legacy editor and awaits
consolidation after compatibility inspection. MySQL proof remains pending.

## Workspace editor consolidation (2026-09-07)

Replaced the Ways to Earn tab's duplicate catalog/toggle/modal path with the
shared screen using an explicit workspace ID. The wrapper keeps transports
stable and notifies the parent overview only for acknowledged operations in the
current mounted workspace visit. Obsolete or failed saves do not refresh it.
The legacy API and now-unreferenced modal file remain for later compatibility
cleanup; no historical records were removed.

Review identified lost read-only visibility of rule configuration. Added a
localized definition-list projection containing exact values, limits and plain
text conditions for readers as well as editors. This removes the old catalog's
lossy Number conversion and unconditional Judge.me verification label.

Eleven mounted wrapper/screen tests pass, including callback replacement,
cross-workspace late saves, failed saves, and read-only detail visibility.
Final review found no remaining blocker. Full navigation, real browser, SQL
concurrency, whole-repository validation and PR release gates remain pending.

## Workspace authority adapter (2026-09-07)

Added the workspace transaction adapter over the same earning-rule services.
Authority is supplied by `withWorkspace`; token-scoped permissions are honored
independently of owner membership. Reads require `loyalty.read`, mutations require
`loyalty.write`. The active store and installation are workspace-scoped, with
generation and binding rechecks after the existing operational write fence.
The outer workspace helper opens one Serializable transaction without retries.

Fifteen adapter tests pass with mocked authority and persistence, covering
read-only owner tokens, write-only tokens, generation changes, all post-fence
binding changes, failed fences, malformed projections and transaction options.
Independent review found no blockers. This does not prove database contention or
workspace HTTP authentication. The HTTP route, shared editor and MySQL tests
remain pending.

## Workspace HTTP routes (2026-09-07)

Added `/api/weletic/earning-rules`: GET requires workspace `loyalty.read`, POST
requires `loyalty.write` and accepts only strict save/retire operations. The route
uses the authenticated workspace and narrowed permission list, never body/query
authority. Body reading is bounded to 16 KiB and validation precedes service
execution. Failures are sanitized; internal schema errors return 503, while
stale state and transaction conflicts return 409 without retry.

Thirty route/adapter tests pass with mocked authentication and persistence,
including exact create values, retirement, injected authority, UTF-8 byte limits
and error mapping. Web type-checking, focused lint, formatting and independent
review pass. This is not live workspace authentication or SQL locking proof.
The workspace browser adapter, shared merchant editor and database integration
tests remain pending.
