# Pending public installations — implementation record

Decision: [ADR 0023](../adr/0023-pending-public-installations.md), approved by
Hiro on September 9, 2026. This feature is **in progress, not release-ready**.

## Current delivery boundary — September 10, public-main refresh

The [local runtime smoke receipt](local-runtime-smoke-2026-09-10.md) records
separately approved loopback startup: all seven HTTP checks passed, and both
temporary app processes were stopped afterward. This is not Shopify acceptance.

The [purchase-policy schema receipt](isolated-purchase-policy-schema-2026-09-10.md)
records ADR 0028's separately approved three-column application. Previously
failing Prisma reads now pass; all ten retained-schema differences are unchanged.
This removes the missing-column blocker without authorizing startup or deployment.

The [September 10 isolated schema receipt](isolated-installation-schema-2026-09-10.md)
records Hiro's ADR 0027 approval and successful application of the two reviewed
pending/native-credential migrations to the isolated development database.
Approved hostnames are recorded as inert configuration only. This supersedes
earlier statements that these specific schema/hostname choices await approval;
deployment, public exposure, installation and business mutations remain gated.

Latest update: [ADR 0026](../adr/0026-audited-company-store-bootstrap.md) approves
first-store bootstrap. Its [local implementation checkpoint](company-store-bootstrap-implementation.md)
supersedes the earlier policy-decision blocker below; verification and live gates
remain open. Public-main refresh `2e4949a56f` passed all six checks in
[run 34385088639](https://github.com/satoshicancode/weletic-room-public/actions/runs/34385088639).
The bootstrap update is a subsequent draft revision: 25 contract tests,
13 isolated SQL tests and the source-frozen full regression (394 files,
6,020 passed, six skipped) passed. New public CI remains required.

The dated checkpoints below preserve historical evidence, including failures and
superseded limitations. They are not a cumulative list of current blockers. Use
this table and the newest relevant checkpoint when assessing readiness.

| Gate                                                                                 | Current disposition                                                                                                                   |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Store/app-owned authentication, pending admission, retained-map reconnect            | Published as draft PR #15; not merged or deployed.                                                                                    |
| Latest offline fallback security fix                                                 | Reviewed; 56 focused tests and 38 isolated MySQL tests passed.                                                                        |
| Latest local code checks                                                             | Web typecheck, lint, formatting and full-schema build passed. Source-frozen full regression: 394 files, 6,020 passed and six skipped. |
| Merchant installation UI                                                             | Partial actual-component browser evidence with synthetic identity/transport; no live embedded acceptance.                             |
| Public repository review/CI                                                          | PR #15 refresh `2e4949a56f` passed all six checks. The bootstrap update requires fresh public CI; PR #13 remains frozen.              |
| New runtime migrations                                                               | Not applied. Earlier PR #5 approval does not authorize the two new migrations.                                                        |
| First company-store provisioning in an empty environment                             | ADR 0026 approved; bootstrap implementation passed 25 contract and 13 isolated SQL tests. Public CI and live acceptance remain open.  |
| Public HTTPS identity and extension ownership                                        | Hostnames proposed only; no approved endpoints, public configuration deployment or UID reconciliation acceptance.                     |
| Named `yamaxdev` installation and loyalty lifecycle                                  | Outstanding; local tests do not establish points, checkout, redemption or refund acceptance.                                          |
| Communications, appearance/nudges, remaining surfaces, analytics, operations/release | Remain in the broader loyalty backlog; this installation draft does not complete them.                                                |

Publication must describe these gaps explicitly. First-store provisioning,
runtime schema application, public exposure and live operations are separate
decisions, not implicit consequences of passing tests or approving ADR 0025.

## Implemented in the local draft

- A pre-workspace admission model and additive two-table migration. The identity
  is app-scoped and matched through the existing versioned shop-privacy HMAC
  keyring, not a stored raw domain. Neither a workspace nor customer is created.
- A minimal signed status contract and gateway. The browser cannot select a
  shop/user or supply an approval command. JWT verification is extracted from
  the existing merchant authenticator without removing its online-exchange,
  exact-user, or staff-authorization checks.
- EN/JA/VI homepage status copy and navigation/overview gating. An active status
  does not grant staff permissions; the existing overview authorizer still runs.
- An operator-only preview/apply mapping service and CLI. It requires an already
  provisioned pending store, matching generation, both reviewed revisions and an
  exact app/shop identity. Mapping writes an audit containing the target store
  snapshot; it does not activate the store or project any credential.
- The key-retirement audit includes pending-installation identity dependencies.
- Coordinated unknown offline publication now creates a pending record in its
  credential transaction. Session observations carry the pending generation but
  no worker credential hash. Unknown online/legacy writes are rejected.
- Unknown-store privacy ingress now uses authenticated exact header/body shop
  matching. Uninstall revokes leases/sessions; redaction erases authentication
  and operator audit data while retaining a bounded keyed replay fence. Replayed
  redaction does not recreate raw-domain coordinator rows or extend retention.
- The existing operator activation path checks any pending record under the
  store lock and requires its exact healthy mapped generation. Legacy company
  stores without a pending record retain explicit operator approval. Suspension
  does not depend on a healthy admission record, preserving emergency containment.
- Existing privacy recovery now prunes expired, fully redacted admission records
  in an interactive transaction. Primary-key candidate selection uses
  `FOR UPDATE SKIP LOCKED`; deletion is limited to those candidates and repeats
  lifecycle predicates. Stored expiry and shorter current retention both apply.
  Mapping/authentication-bearing and audit-inconsistent records are preserved.
- Mapped-store uninstall now freezes the exact admission generation, preserving
  its mapping for existing voucher cleanup. Final shop erasure removes the
  admission's operator audit, authentication metadata and store link in the same
  transaction. A keyed app/shop fallback also handles the deliberate interval
  between Store provisioning and admission mapping; that interval is not legacy.
- An explicit, signed reconnect action for uninstalled, unmapped admissions.
  Fresh verified identity must postdate uninstall; private revision/generation
  observations fence preparation. Preparation rotates the generation and revokes
  old sessions without creating a Store or granting approval. Provider bootstrap
  follows preparation; failures remain errors, not successful authentication.
- A static `/installation` shell remains reachable without normal SDK bootstrap.
  Its status and reconnect requests still require fresh verified identity. The
  homepage error boundary links to it, and a normal-root link allows bootstrap
  recovery after provider failure. Embedded query context is preserved.

## Required before publication

### September 10 — publication and public-main refresh

- [Draft PR #15](https://github.com/satoshicancode/weletic-room-public/pull/15)
  published commit `713527a93a5369bd83b848aea70d8091315b0b11`. All six checks
  passed in [CI run 34382415061](https://github.com/satoshicancode/weletic-room-public/actions/runs/34382415061).
  It remains a draft because first-store provisioning, runtime schema, public
  configuration and live acceptance gates are unresolved.
- Public main advanced through [PR #16](https://github.com/satoshicancode/weletic-room-public/pull/16),
  merged as `98ec37645ce78f934d8121cbb415d8f441db9ad3`. It sanitizes existing
  points-expiry provider exceptions without activating delivery or changing
  eligibility/idempotency. Its full pre-merge CI passed; post-merge CI is running.
- The draft incorporates that exact main commit with a normal, conflict-free
  merge, not a force-push. The combined tree passed all 74 focused expiry tests
  across four files and the full web typecheck. Fresh public CI is still required;
  prior green checks do not prove the refreshed head. No runtime changes occur.

### September 10, 02:20 JST — current full regression passed

The full web Vitest rerun finished with exit 0: 393 files passed, 5,993 tests
passed and six skipped (5,999 total), in 679.43 seconds. This run includes the
latest offline fallback fix. It does not turn simulated commerce, mocked Redis
or provider transports into live `yamaxdev` acceptance. Repository-wide formatting
also passed. Public CI has not run for this unpublished draft.

### September 10, 02:18 JST — current full-schema build passed

- The latest full-schema web build completed successfully after the offline
  fallback fix: compilation, type/lint validation, static-page generation and
  build tracing. The guarded runner used fresh database
  `weletic_loyalty_it_access_20260909170853904` on port 3307 and returned exit 0.
- Independent SQL reconciliation returned zero Store, Program and approval-audit
  rows. The isolated schema remains retained; no runtime migration was applied.
- Final bounded review found no new blocker for draft publication only. The
  full web regression is still running; no PR has been opened yet.

### September 10, 02:15 JST — locale/layout matrix and publication scan

- Actual-component browser assertions passed 16 combinations: Japanese and
  Vietnamese, 375px and 1280px widths, suspended admission, expired authentication,
  status-service failure and approved-store/denied-overview responses. All had
  no horizontal overflow, no English page-ready announcement and none of the
  tested synthetic token/domain/GID markers in the DOM. Denied-overview states
  retained six static navigation links; the other three states had zero links.
  This does not prove destination-route permissions, complete translation
  correctness, keyboard coverage or comprehensive absence of private data.
  Transport and identity were synthetic; no live Shopify calls were made.
- The first matrix command failed CLI parsing before execution; the corrected
  command completed successfully. Only the corrected run is evidence.
- Shopify package tests passed 32/32 and its typecheck passed. Prettier passed
  all changed/new TS/JS/JSON/Markdown files. A targeted read-only scan across
  123 changed/new files found no matching Shopify/GitHub token formats, private
  key headers, signed credential URLs or private-repository PR/commit links.
  This pattern scan is not a comprehensive secret audit.
- Full web regression and isolated-schema build remain running. No public PR,
  runtime migration, installation or release is claimed by this checkpoint.

### September 10, 02:09 JST — offline fallback authority revalidation

- Security review found an unfenced SDK offline-session fallback after an earlier
  legacy credential-source selection. The draft now holds the Store lock through
  workspace/domain, active lifecycle and exact generation checks, legacy ownership
  revalidation, current generic-integration absence and the unexpired offline-session
  read. It does not provision a first store or change company approval policy.
- The focused resolver/legacy-fence/adversarial suites passed 56 tests. A fresh
  isolated MySQL run passed 38 tests, including unchanged legacy success and
  rejection after committed public-admission or generic-integration creation.
  These new cases are deterministic interleavings, not simultaneous contention.
  Database: `weletic_loyalty_it_access_20260909170723783`; independent pending,
  coordinator and SDK-session counts were `0/0/0`. The schema was retained;
  runtime and legacy databases were not migrated.
- Independent source review found the reported fallback race closed, with no
  concrete remaining blocker in that fix. This is not a whole-product acceptance.
- The synthetic reconnect browser scenario also covered an ambiguous response:
  one reconnect request returned an error; explicit status reload recovered to
  pending approval without another reconnect request or protected navigation.
  No live Shopify installation was exercised.
- Current web typecheck and repository lint passed (10 lint tasks). Earlier
  full-regression/build results predate this resolver fix. Fresh full regression
  and isolated full-schema build revalidation are running, not accepted yet;
  the feature is still an unpublished local draft.

### September 10, 01:58 JST — reconnect and failure-state browser checks

The actual component in the synthetic loopback harness passed these English
375px checks (Playwright `installation-acceptance`, commands 96148 and 4299):

| Fixture response                                     | Observed result                                                                                                                                                              |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reauthentication required, then successful reconnect | Reconnect disables during the held response; a second click produces no extra request; exactly one synthetic reconnect returns pending approval; zero links and no overflow. |
| Suspended installation                               | Suspension/non-reactivation message; zero merchant links.                                                                                                                    |
| Status HTTP 401                                      | Reopen-from-Shopify instruction; focus moves to the error; zero links.                                                                                                       |
| Status HTTP 503                                      | Unavailable/reload instruction; focus moves to the error; zero links.                                                                                                        |
| Approved installation, overview HTTP 403             | Explicit staff denial receives focus; no overview data; six static navigation links remain, which is not permission to use their destination gateways.                       |

All four failure-state DOM measurements found no horizontal overflow or tested
synthetic-token/domain/GID markers. No live request or real credential was used.
These checks do not prove arbitrary rapid-event races, backend idempotency,
destination-route authorization, real account permissions or all-language error
coverage. Remaining UI acceptance includes JA/VI versions of these failure states,
desktop, ambiguous reconnect response, loading/focus transitions and actual
Shopify frame/installation behavior. Public GitHub inspection still found only
the frozen import draft PR #13; this installation draft has not been published.

### September 10, 01:54 JST — full regression passed; Polaris locale fix

Full web regression 62892 is terminal, exit 0: all 393 files passed, 5,986 tests
passed and 6 existing skips, in 670.75 seconds. This completes the rerun of the
29 legacy-fixture failures; no test was removed to obtain the result. The small
Shopify-page localization change below was made near the end of that run and is
covered separately by the Shopify package checks and direct browser verification,
not attributed to the earlier web-run start state.

The overview/installation screen now wraps its existing content in a Polaris
provider using the selected EN/JA/VI translations. Locale resources come from
the installed Polaris package, with no dependency changes or copied Smile assets.
The parent provider and other routes remain unchanged. Three regression tests
check page-ready translations and actual SSR pagination accessibility labels.
All 32 Shopify package tests (74949), package typecheck (11347), direct Remix/Vite
build (58441), Prettier and diff whitespace checks passed. Existing Vite sourcemap
warnings remain visible; no Shopify CLI link/deploy command was used.

The refreshed 375px browser snapshots now announce page readiness in Japanese
and Vietnamese respectively. The Vietnamese DOM check confirmed `lang="vi"`,
localized readiness present, English readiness absent, zero links and no
horizontal overflow. Artifacts are retained outside Git under
`output/playwright/store-approval/browser-artifacts-polaris-fix/`.
This fixes only this screen's
Polaris context; it does not establish multilingual coverage for all app routes,
typed authentication error boundaries or real Shopify owner/staff sessions.

### September 10, 01:52 JST — current production web build passed

Build 19512 completed with exit 0 against fresh isolated schema
`weletic_loyalty_it_access_20260909164256332`. Compilation, build-integrated
lint/types, all 367 static pages and final tracing completed. Independent SQL
reconciliation found zero Store, Program and access-audit rows (`0/0/0`); the
fixture schema is retained. External Redis/QStash were disabled in the verification
environment and their missing-configuration warnings were visible. This replaces
the older pre-resolver-change build evidence; it is not runtime health, deployment
or live store acceptance. Full regression 62892 remains a separate pending gate.

### September 10, 01:50 JST — initial real-browser installation UI evidence

Built an ignored loopback-only harness in `output/playwright/store-approval/`
that bundles the actual `_index.tsx`, Polaris components and merchant clients.
Only server imports/App Bridge identity and HTTP responses are synthetic. CSP
disallows network connections; no Shopify token, customer data or live endpoint
is used. Server process 80175 listens only on `127.0.0.1:19443`; Playwright session
`installation-acceptance` is isolated from the reference-store browser.

Observed pending-approval content in EN/JA/VI. At 375x812, the Japanese screenshot
was visually inspected; Vietnamese DOM measurements found no horizontal overflow,
zero links, and no synthetic token, `myshopify.com` or Shopify GID markers in
`body.innerHTML`. This is a bounded marker check, not a general data-leak audit.
The snapshot contains only pending/disabled messaging, language selection and
reload controls. Tab first focuses the status banner; the next Tab reaches Reload.
An explicit focused-element assertion confirmed the Vietnamese reload button,
then Enter preserved the pending state. No store approval or reconnect request
was exercised. Local browser artifacts are retained under ignored
`output/playwright/store-approval/browser-artifacts-20260910/` and are not public
repository evidence or copied Smile assets.

**Open defect:** Polaris' page-ready live announcement stays English after
switching to JA/VI (for example, `Weletic — 概要. This page is ready`). The harness
uses the same English-only Polaris provider as production `app/root.tsx`; the
page's locale selector changes its own copy but not that provider. Implement
locale-aware Polaris messages using the installed EN/JA/VI translation resources,
then repeat keyboard/screen-reader and visual checks. Full multilingual
accessibility acceptance is therefore **not passed**. Reconnect, suspended,
expired-auth, denied-staff, errors/loading and desktop checks remain outstanding.
No production source was changed while regression/build verification runs.

### September 10, 01:44 JST — current-tree build verification in progress

The previous full-schema web build predates the final resolver and webhook
fallback changes, so it is not treated as current-tree publication evidence.
Started a new guarded build (19512) using fresh
`weletic_loyalty_it_access_20260909164256332` on `127.0.0.1:3307`, with a dedicated
database-scoped non-root principal. Container/project/loopback-port and private
secret-file checks passed. Prisma schema application succeeded against that new
fixture only; Next production compilation is still running. The build runner
will independently reconcile zero Store/Program/access-audit rows on completion.
No runtime migration or destructive fixture cleanup was performed.

Full web regression 62892 was polled and confirmed live with new test results at
this checkpoint. It has not produced a terminal summary; do not restart it or
claim a pass based on the earlier focused checks. Source files remain unchanged
while these two verification processes run. Public configuration/first-install,
browser acceptance, live lifecycle and operations/release gates remain open.

### September 10, 01:41 JST — remaining legacy fixture repairs

All six files that failed run 32992 now pass their focused reruns. The remaining
five used incomplete Store rows or returned Store-shaped data for the new locked
credential read. Their adapters now provide canonical domain/compliance state,
read the actual installation fixture by ID, execute the real legacy ownership
fence against absent public/native/privacy records, and explicitly model the
coordinator anchor/revision write. Shared helper
`tests/weletic/helpers/legacy-credential-sql-fixture.ts` rejects unknown SQL;
it deliberately does not claim real locking or contention coverage. The provider
upgrade assertion now includes the production `select: { id: true }` contract.

The validator additionally needed the standard test-only `server-only` module
stub after the newly reached ownership fence imported server error types. Its
assertions now include structured check diagnostics; expected outcomes were not
weakened. This validator still uses synthetic records, not the reference store.

Focused evidence: two-way sync plus canonical/legacy-fence suites, 50 tests
(42569); discount provider, 17 (32602); archived discounts plus challenger UI/API,
50 (43890); validator, 28 (80433). All exited 0. Web types (56873), root lint
(41897, 10 tasks), Prettier and diff whitespace checks passed. These runs overlap
in coverage and must not be summed as unique acceptance cases. Full web regression
is being rerun (62892). Independent read-only review found no concrete regression
or weakened behavioral assertion. It explicitly confirmed these mocks do not
prove Store-predicate isolation, coordinator revisions/leases, native credential
selection or SQL concurrency; dedicated acceptance evidence remains required.
No production source, runtime database, deployment or live store was changed by
this repair. First-install provisioning and HTTPS-host decisions remain open.

### September 10, 01:36 JST — complete regression result and webhook fixture repair

Full web regression 32992 is terminal, exit 1: 387 files passed and 6 failed;
5,957 tests passed, 29 failed and 6 skipped (523.16 seconds). Failures are in
`adversarial-stress-shopify-sync`, `e2e-shopify-2way-sync`,
`archived-disabled-discount-codes`, `challenger-2-adversarial-ui-api`,
`shopify-discount-provider` and `test-store-validation-harness`. This is not a
green publication gate.

The adversarial webhook fixture returned a Store for every raw SQL query,
including privacy-tombstone and locked credential reads added by the native
cutover. Its adapter now dispatches explicit table reads, returns the actual
fixture credential, models absent program/admission/tombstone/native rows, and
accepts only the coordinator-anchor insert. Unknown SQL fails loudly. The real
legacy ownership fence executes; no production authorization check was relaxed.
These remain in-memory simulations, not proof of SQL locking or live Shopify.

An attempted boundary mock plus dynamic-import initialization did not eliminate
the concurrent-test failure and was removed. The final explicit adapter passed
all 49 tests across the adversarial webhook, canonical resolver and dedicated
legacy-fence suites (49247, exit 0, 13.09 seconds). Formatting and diff whitespace
checks passed; the final web TypeScript check also passed (64834, exit 0).
The other five failing files still require diagnosis and repair,
followed by a complete rerun. No commit, push, merge, runtime schema application,
installation, order, redemption or email occurred during this repair.

### September 10, 01:28 JST — build checks and first-install dependency

Current Shopify app TypeScript check (71485) and direct Remix/Vite production
build (77454) passed. This did not invoke Shopify CLI, alter extension identities,
deploy code or start a runtime. Existing Vite sourcemap/future-flag warnings remain
visible; the exit code was 0. Full web regression 32992 remains active.

First-install readiness is still unproven independently of reconnect success:
`mapPendingInstallationInTransaction` requires a pre-existing Store with the
exact pending generation and access revision. It deliberately creates no Store,
Project, Program or credential. `WeleticShopifyStore` requires unique Project and
Program links plus currency/API metadata. No audited native first-Store
provisioning command has been implemented in this draft. Do not use the retired
user-based bootstrap or copy custom-app installation metadata to satisfy this.

Required follow-up: define and implement the approved operator-controlled initial
provisioning step, with explicit existing workspace/program ownership (or a
separately approved creation policy), fresh canonical Shopify identity/currency
evidence, pending-generation/revision fences, privacy exclusion, immutable audit,
rollback tests and no loyalty activation/customer sync. Reconnect fixtures and
mapping-only SQL tests do not satisfy this gate. Unknown installations must stay
pending without automatic workspace/customer provisioning. Public hostname
selection also remains pending; no answer is inferred from goal continuations.

### September 10, 01:25 JST — resolver SQL evidence and CLI side effect

Added three real-MySQL resolver cases: legacy source selection followed by
same-generation public admission before preverified credential use; admission
during synthetic live verification before metadata publication; and successful
legacy alias persistence with canonical-only coordinator advancement. Both
denials preserve credentials and generation. These are deterministic transaction
interleavings, not simultaneous lock-contention tests; mapping is explicit fixture
SQL and Shopify verification responses are synthetic.

Fresh schema `weletic_loyalty_it_access_20260909162334530`: **35 tests passed**,
exit 0, remaining pending/coordinator/session rows `0/0/0`; schema retained.
Two earlier runs failed only the alias success case because Prisma returned unused
`InstalledIntegration.userId` from the minimal fixture schema. The production
update now selects only its ID; stored alias/generation are independently reread
in the test. Native ownership never requires a generic installer.

Full regression 48260 ended with **1 failed, 4183 passed, 5 skipped**, bailing
before all 393 files ran. The failure was the referral Flow manifest's no-UID
guard: the earlier CLI validation had unexpectedly inserted a local UID. Removed
only that generated line; extension manifests now have no diff from HEAD. This
corrects the earlier incomplete CLI side-effect report. No UID was intentionally
linked or deployed; CLI validation must be treated as potentially mutating local
files and performed in a disposable configuration copy next time.

A focused rerun exposed eager server-only imports for domain-only consumers.
The legacy ownership helper is now imported inside its async credential function,
preserving its checks without eagerly loading the request-error layer. Flow and
canonical resolver suites now **33 tests passed**; web types, focused ESLint and
diff checks passed. Current full-web no-bail regression 32992 is running after
these fixes; do not restart unless terminal. The whole cutover remains local and
unmerged, and live/public execution gates remain unchanged.

### September 10, 01:20 JST — legacy resolver ownership race

Consumer review confirmed a same-generation cutover race: the native/legacy
source-selection transaction ended before `verifyAndBindShopifyIntegrationCredential`
returned or updated a retained generic credential. Both subsequent Store-locked
transactions checked generation but not newly appearing public ownership.

Both paths now require an active locked lifecycle and run the shared legacy
ownership fence using **locked Store.shopDomain**, not the requested legacy alias.
They then read generic credentials with `FOR UPDATE`, avoiding consistent-read
snapshot staleness. Metadata publication advances the canonical legacy coordinator
revision first and rejects SDK-promoted publication. The source reviewer found no
concrete regression; verified alias support remains separate from canonical
ownership fencing.

The 19-test canonical resolver suite passed, including native ownership denial
for preverified and live-verified credentials, SDK-promotion denial and existing
alias/token-rotation regressions. These are mocked-boundary tests; real-MySQL
coverage of this exact helper race remains required. Focused ESLint passed.
A TypeScript error in the test's async Prisma mock was corrected by configuring
the actual hoisted test double instead of the generated PrismaPromise signature;
the follow-up typecheck (55725) and focused rerun (29638, 19 tests) passed.
Formatting and diff whitespace checks also passed.

The full regression process (48260) is still running and was not restarted.
It began before this resolver change, so its result cannot certify an unchanged
final tree. Inspect its final failures, revalidate affected credential consumers
and add SQL race evidence before publishing the cutover. Public hostnames remain
awaiting owner confirmation; no configuration/exposure approval is inferred from
automatic goal continuation. No runtime, live store, commit or merge action here.

### September 10, 01:15 JST — public configuration disposition

Ran `shopify app config validate --json` from `packages/shopify-app`: returned
`valid: true`, no issues, for the existing **custom-app** default TOML. This does
not establish public registration ownership, deployment readiness or live
capabilities. The CLI unexpectedly auto-upgraded globally from 4.7.1 to 4.8.0
after validation; no upgrade was explicitly requested. Default TOML, package
manifest and lockfile remain unchanged. Skill telemetry was opted out.

Current tracked state confirms no separate public-app TOML. The approved
environment documents and setup code identify public registration
`c7d49cebb06e445db345bb200f966a03`, while the default TOML identifies the retained
custom app. Local public runtime URLs deliberately remain loopback and cannot
serve as Shopify HTTPS callbacks. Requested scope inventories already include
`write_app_proxy`; that does not prove scopes have been granted, and stored-value
scopes still require capability review. Existing extension UIDs are explicitly
recorded as old-app identities. The existing checkout extension includes the
Plus-only reductions target; the public release must exclude it rather than
deploying the directory unchanged.

Before preparing the reviewed public configuration, select dedicated Shopify
frontend and backend HTTPS origins. Proposed names for owner confirmation:
`loyalty-shopify-dev.weletic.com` and `loyalty-api-dev.weletic.com`, routing only
to isolated ports 3002 and 8890. These names are proposals, not existing DNS or
approved exposure. Configuration preparation does not authorize DNS/tunnel
changes, remote app linking, UID publication, deployment or installation.
Do not use custom-app production endpoints as placeholders. The required
follow-up is origin selection, separate configuration and extension ownership
reconciliation, then local validation before requesting execution approval.

### September 10, 01:12 JST — lock-safe webhook credential handling

The source reviewer accepted the preceding legacy activation ownership fix, but
identified an inherited recovery hazard: canonical webhook provisioning allowed
SDK fallback while the activation caller held Store/coordinator locks. Recovery
could need those same locks or substitute credentials during a fenced operation.

Canonical webhook provisioning now accepts an optional `allowSdkFallback` policy
and forwards it to every creation request and its final exact-subscription audit.
Both locked activation callers (the legacy CLI and session publication's legacy
activation branch) explicitly pass `false`. Other callers retain the existing
default; segment provisioning remains unchanged. This is failure containment,
not a new authentication mechanism or an automatic reconnect implementation.

**47 focused tests passed** across provisioning, segment compatibility, activation
and tenant binding. Two cases exercise the real GraphQL helper with synthetic
HTTP 401 responses during creation and audit: neither calls the mocked SDK
recovery entry point, and neither reports successful provisioning. Separate
tests check policy propagation to all 17 requests and both locked callers.
No request can reach Shopify in those transport tests. Source review found no
concrete defect; focused ESLint, formatting, web TypeScript and diff whitespace
checks passed. The prior full build predates this
change; no unchanged-tree release/CI claim is made. All changes remain local,
uncommitted and undeployed; no live or runtime-schema actions were executed.

### September 10, 01:07 JST — legacy activation boundary and completed build

The full-schema build from session 60432 finished with exit 0, all 367 static
pages generated, and remaining Store/program/access-audit rows `0/0/0` in
`weletic_loyalty_it_access_20260909155446695`. This supersedes the pending-build
status below. It predates the following CLI edit, so it is not an unchanged-tree
final release gate. External Redis/QStash were deliberately disabled; their
missing-configuration warnings do not prove operational readiness.

Consumer review found the legacy generation-activation CLI still lacked the
public/native ownership exclusion used by other credential writers. It now calls
the shared legacy connection fence before reading retained credentials and again
inside its final Store-locked transaction, before program locking. It advances
the legacy coordinator revision before provider verification/provisioning, denying
SDK-promoted coordinators and fencing old observations. Local revision changes
roll back with the activation transaction; remote provisioning remains an
explicitly approved maintenance operation, not an atomic external transaction.

The preflight may create an empty coordination anchor even without `--apply`;
dry-run means no credential/generation publication or remote writes, **not zero
database writes**. Native installations must use Shopify Admin authentication.
No activation command was executed against any store in this checkpoint.

Focused activation/shared-fence/coordination suites: **34 tests passed**, including
native preflight denial, ownership appearing before final write, SDK promotion
denial and revision-before-provisioning order. These CLI tests mock database and
provider boundaries; they are not end-to-end activation/rollback acceptance.
Web TypeScript, focused ESLint and diff whitespace checks passed. The draft
remains uncommitted and undeployed; full-cutover review, public runtime gates and
named `yamaxdev` acceptance remain outstanding.

### September 10, 01:03 JST — SDK authentication concurrency

Added two deterministic SDK → signed backend → real MySQL cases. One holds the
first synthetic provider response while a competing authentication must receive
exactly HTTP 409 `lease_busy`; only the first operation publishes, with native
credential/publication revision 1 and a released lease. The other rotates the
Store/admission generation and revokes coordination before the provider returns;
the stale exchange persists neither a session nor a native credential, and fresh
authentication succeeds against the new generation while approval stays pending.
The rotation is an explicit lifecycle fixture, not real uninstall/reinstall
acceptance. Provider responses remain synthetic and transport cannot reach the
network. The first concurrency operation is released and joined in `finally`.

Fresh schema `weletic_loyalty_it_access_20260909160236823` on port 3307:
**32 tests passed**, runner exit 0, remaining pending/coordinator/session rows
`0/0/0`; schema retained. Focused ESLint and web TypeScript checks passed. A
read-only reviewer requested the exact lease-conflict assertion rather than a
generic rejection; this was fixed before the final passing SQL run. No further
concrete defect was reported. The existing full-schema build (session 60432)
has passed compilation and lint/types and is collecting page data; its final
result is still pending. No deployment, runtime migration, live store mutation,
commit, push or merge occurred in this checkpoint.

### September 10, 00:55 JST — actual SDK-to-backend-SQL publication

New integration coverage runs the production Shopify SDK, coordinated session
storage and signing client against the real session/coordination route handlers
and real MySQL transactions. HTTP dispatch is intercepted in-process and Shopify
token/scope responses are synthetic; unexpected destinations cannot fall through
to the network. Backend signing verification, validation, native credential
encryption and persistence are not mocked. Mapping/completed-cleanup preconditions
are fixtures, so this is not actual Shopify install/uninstall acceptance.

This exposed a real local-draft defect that the separate mocked gateway tests
missed: after publication, `sessions/route.ts` passed the whole `nextLease` to
`readShopifySessionSnapshot`. Its token/epoch/revision fields leaked through a
spread into the strict native credential identity. Zod rejected them, returning
HTTP 400 and rolling back valid fresh authentication/reinstall. The route now
passes `publicationScope` (app/shop only); the lease acknowledgement remains
separate with existing checks unchanged. A focused unit assertion prevents the
call-site regression.

Three connected SDK/SQL cases now pass:

1. Fresh mapped authentication publishes encrypted SDK payload and native
   credential revision, with zero generic installer rows; company approval stays
   pending. Release clears lease expiry, deliberately retaining the owner digest
   to prevent replay (the test was corrected to this existing contract).
2. Prepared mapped reinstall survives a synthetic provider failure, then publishes
   under the new generation through fresh SDK authentication; the loyalty program
   remains disabled, kill switch on, company approval pending.
3. A fixture-specific SQL CHECK failure during native publication rolls back the
   SDK payload, native credential and **publication revision** together. Lease
   acquisition/release history is separate, not claimed rolled back. Removing
   the fixture CHECK permits a new SDK operation to authenticate successfully.

The final guarded run passed all 30 tests in 8.00 seconds against
`127.0.0.1:3307/weletic_loyalty_it_access_20260909155245180`. Independent SQL found
zero Store, native credential, generic installation, Project and catalog rows,
and zero remaining failure CHECKs. Runner reconciliation also found zero pending,
coordinator and SDK-session rows. Schemas/principals from successful and failed
diagnostic runs were retained; none was dropped. No runtime migration was applied.

Current focused SDK/publication/coordination verification passed 49 tests; web
typecheck, focused lint and formatting passed. Independent source review confirmed
the fix and these evidence limits, finding no concrete defect. Full regression
session `92871` completed: 393 web files, 5,976 passed tests, 6 skipped; seven
monorepo tasks successful (six cached), 9m23s overall. That run began before the
one-line publication fix, which is covered separately by the current focused and
SQL suites; it is not an unchanged-tree final release gate.

A fresh full-schema/build run is active in terminal session `60432`, using only
`weletic_loyalty_it_access_20260909155446695` on port 3307. Poll the same handle.
Still required: actual SDK/SQL generation-change and competing-operation races,
fresh native currency/scope evidence, full browser/owner/staff journeys, whole
cutover review/public CI and gated live `yamaxdev` acceptance. This is still an
uncommitted local draft, not a deployed or production-ready loyalty product.

### September 10, 00:46 JST — native-aware configuration inventory

The local inventory now discovers Shopify through the authorized workspace's
nonredacted Store and current-app admission/credential metadata, as well as
existing generic installation rows. It selects catalog display fields only:
no ciphertext, tokens, shopper identity, raw shop domain or installer identity.
Pending and retained uninstall mappings stay discoverable for recovery; this
is **configuration presence, not healthy authentication or active loyalty**.
Absent runtime app ID does not produce an unscoped native query; native discovery
is unavailable in that misconfigured environment. Database errors propagate.

The preview and full list share one component and the existing
`withWorkspace`-authorized `/api/integrations` contract with `workspaces.read`
and `private, no-store`. The old full-list RSC queried personal installer data
using a route slug behind a client-only workspace layout; it now fetches only
through the authenticated API. Inventory installer attribution was removed for
all providers; generic provider links and Enabled labels remain, and their detail
pages are unchanged. Shopify is labelled Managed in Shopify, never Enabled.
Its catalog card opens the internal management page rather than a legacy guide.
SWR has no request without workspace identity and cannot retain another
workspace's previous response. Error states hide stale lists.

Verification:

- 12 focused API/query, actual list/page markup and cache tests passed; database,
  auth wrapper, SWR, logo and catalog badge dependencies are mocked as stated in
  the respective tests. This is not a browser authentication test.
- The prior 11 connection-page tests passed again **after formatting**. This
  corrects a gap in the 00:35 checkpoint: the formatter removes unused React
  imports, while Vitest's classic JSX transform depended on them. Vitest now uses
  automatic JSX, matching Next.js. No assertions were weakened, and no CI
  pipeline or runtime configuration was changed.
- The guarded real-MySQL suite passed 27 tests in 10.72 seconds against fresh
  `127.0.0.1:3307/weletic_loyalty_it_access_20260909154426020`, including three new
  actual-query cases: native mapping with zero generic/credential rows; foreign
  workspace/app and redacted-state exclusion; retained uninstall discovery and
  native/legacy deduplication. This uses a minimal isolated schema and synthetic
  fixtures, not a public-app install or a live Shopify transport.
- Independent SQL found zero remaining catalog, generic installation, Store,
  native credential and Project rows. Runner checks found zero pending,
  coordinator and SDK-session rows. The isolated schema/principal are retained.
- Focused lint, formatting and current web typecheck passed. Independent bounded
  source review found no concrete inventory defect; no browser acceptance claimed.
- Full monorepo regression rerun started at 00:44 JST after the JSX/inventory
  edits and remains pending in terminal session `92871`. Poll that same process;
  the earlier 5,959-pass baseline does not validate this newer tree.

Still required: SDK-to-backend-SQL publication/reinstall coverage, fresh native
currency/scope proof, browser EN/JA/VI/mobile/keyboard/recovery evidence, current
full build and whole-cutover review/public CI. Native metadata is not an active
connection/approval display. This remains an uncommitted draft; no public runtime
schema, deployment, install, loyalty activation, order or email was executed.

### September 10, 00:35 JST — regression and Shopify connection presentation

The standard `verify.mjs unit` run begun at 00:21:43 completed with exit 0:
388 web test files, 5,959 passed tests and 6 skipped; all seven monorepo tasks
succeeded (six cached). This run includes the native credential, uninstall and
scope-operator draft, but predates the connection-presentation edits below.
It is local regression evidence, not live Shopify or full SQL lifecycle evidence.

The Shopify integration detail page now takes a separate presentation branch:
no generic install/uninstall action hooks, installer attribution or fabricated
generic installation row. Its server component does not query or serialize the
legacy installer's user data for Shopify. Other providers retain their existing
workspace-scoped installation details. Shopify's old catalog guide URL cannot
redirect merchants away from connection management.

Connection guidance directs authentication/reconnection and uninstall to the
intended store in Shopify Admin. It distinguishes Shopify user permissions from
company approval, without claiming that authentication activates loyalty.
The catalog panel no longer asserts `Installed`, substitutes an obsolete project
alias for the connected store, or claims twelve verified webhook subscriptions.
The existing catalog action remains unchanged; the browser is not authorization.
The session-incident notice no longer requires a Weletic workspace owner.

Focused RSC/presentation tests: 11 passed across three files (mocked Prisma,
mocked SWR and client boundary; actual notice markup). Focused ESLint passed;
web typecheck passed during this edit batch. These do not prove browser layout,
Shopify authentication, staff permissions or live sync. No schema, API contract,
credentials, deployment or runtime state changed in this checkpoint.
Bounded independent source review found no concrete defect in this UI delta;
it explicitly did not perform browser or live acceptance.

Still outstanding: native-aware enabled-integrations inventory; authenticated
connection/approval display rather than installation guesses; actual SDK-to-SQL
publication/reinstall proof; browser EN/JA/VI, keyboard/mobile and recovery
acceptance; whole-draft review, current build and public CI. The native cutover
remains an uncommitted local draft, not a released feature. The 00:03 full-schema
build is an earlier baseline, not validation of these later changes.

### Shopify-native credential refactor (ADR 0025)

Implementation sequence, not completed work:

1. Add a Shopify-specific store/app credential contract and reviewed additive
   schema. Store identity, app identity, installation generation, credential
   revision and encrypted token data must not require a Weletic installer user.
   Keep the existing generic integration schema and other providers unchanged.
2. Reconcile shared lookup paths in `store-resolver.ts`, `get-installation.ts`,
   `session-snapshot.ts`, `loyalty/shopify-discounts.ts` and
   `lib/discounts/discount-provider-shopify.ts`. Define the public/legacy boundary
   explicitly; never silently fall back to another credential source after a
   permission, generation or privacy failure.
3. Reconcile credential publication in the internal sessions route and workspace
   connection callback. Keep signed gateways and coordinated token exchange;
   the workspace callback cannot independently rotate a mapped admission's
   generation or inherit company approval.
4. Reconcile uninstall and compliance-worker erasure, including current key
   dependencies, old-generation credentials, retained mapping and redaction.
   Also inspect generic integration listing/settings/uninstall routes so their
   UI/actions cannot falsely report or override the Shopify-specific lifecycle.
5. Implement mapped reinstall against the real completed-scrub state, not a
   fixture retaining a deleted generic installation. Validate current Shopify
   identity/permissions, cleanup completion, generation/revision races, disabled
   program and pending approval. Staff grants remain generation-bound.
6. Run focused contract/SDK tests, full-schema and isolated MySQL races, actual
   component browser acceptance, builds and public CI. Apply no runtime schema
   or external mutations without the existing explicit execution gates.

No runtime credential-source change is implemented by the ADR or this inventory.
The cross-provider `InstalledIntegration.userId` relation is not being made
nullable merely to bypass the current Shopify dependency.

Local foundation now exists: `WeleticShopifyInstallationCredential`, the additive
`20260909_store_owned_shopify_credentials.sql` draft, and
`store-owned-credential.ts`. An AES-GCM envelope binds app, store, workspace,
canonical shop, installation generation and credential revision. Publication
locks the exact lifecycle/admission and uses revision CAS; plaintext fallback,
cross-identity ciphertext and older-revision ciphertext are rejected. No generic
installer account is required. This primitive is not authorization. Runtime
credential reading/publication has not switched to it; no database received this
new migration. Uninstall and final shop-redaction erasure hooks are now connected
in the local draft, so deployment requires the new table first.

Twenty-one focused tests passed with real encryption and mocked transaction/
lifecycle dependencies. Prisma client generation passed. Bounded review found no
standalone defect and required coordinated Store → coordinator → admission →
credential locking at call sites, a separate frozen cleanup reader, explicit
uninstall/redaction erasure and generation rotation, and an all-consumer cutover
without fallback. Real MySQL publication/privacy races and post-uninstall SDK
recovery remain outstanding. The earlier full build predates this foundation.

The credential foundation and subsequent erasure changes passed the web
typecheck. The final focused rerun passed 95 tests across credential, uninstall
and compliance-worker suites. Uninstall erases only the configured app's exact
store/generation under the existing frozen Store lock; final shop redaction
erases all credentials for the locked store. Tests cover absent generic installer
metadata, deletion failure and stale-generation rejection. Two initial test
failures exposed a missing app-identity environment fixture; explicit setup and
restoration corrected that fixture without weakening production validation.
Bounded independent review found no concrete scope or transaction defect.
These tests use transaction mocks: actual MySQL rollback/privacy races, SDK
reinstallation and the remaining reader/publication cutover are not accepted.

The subsequent isolated MySQL checkpoint passed 14/14 tests in
`weletic_loyalty_it_access_20260909135322063`. The new credential table used its
checked-in draft SQL; supporting Store/privacy tables are minimal test schemas,
not a full production-schema migration acceptance. Real transactions established
one winner for competing create/rotation revisions, rollback of credential
publication and a synthetic exact-generation delete, encrypted persistence, and
rejection after a committed freeze or generation replacement. Independent SQL
reconciliation found zero remaining credential and Store rows; the runner found
zero pending/coordinator/session rows. The fixture schema is retained.

The first expanded run (`weletic_loyalty_it_access_20260909135258544`) passed the
three new credential cases but exposed an older test's database-global zero-Store
assumption. It now asserts unchanged total and zero Stores for its exact shop.
The rerun and web typecheck passed. Independent review found no fixture-safety
defect, but noted that competing calls do not deterministically prove lock
overlap; sequential freeze tests are not publication-versus-privacy races.
Synthetic deletion rollback is not the actual worker transaction. Signed
gateways, coordinated leases, frozen cleanup reads, all-consumer cutover and
post-uninstall SDK recovery remain required. No runtime database was migrated.

### Native session publication checkpoint — September 9, 23:00 JST

The local session snapshot and POST publisher now select the native credential
for stores with public admission records. The SDK payload, native credential
revision and coordinator revision are written in one interactive transaction.
Both the prior token hash and native revision fence publication. A missing
native credential can be created only through the coordinated authenticated
path, not through a generic installer record. Snapshots lock credentials before
SDK sessions and expose no plaintext token in their observation.

Pre-admission custom installations retain their existing path only when no
native credential exists for that Store/app. This is an explicit compatibility
boundary, not fallback after native verification failure. Independent review
found two gaps and both were fixed: new online/tokenless public writes must pass
coordination/admission checks, and missing admission cannot downgrade an existing
native installation to legacy authority. The re-review found no additional
concrete regression in this bounded change.

The expanded session/credential unit run passed 124 tests across ten files;
the web typecheck passed after the review fixes.
Tests cover native publication wiring, stale token rejection, coordinated first
credential creation, public uncoordinated online/offline/tokenless rejection,
no legacy fallback and fixed failure responses. Transactions and signed-request
verification are mocked in route tests; these do not establish real gateway
authentication or atomic end-to-end publication rollback. An initial legacy
fixture incorrectly supplied a Store row for the new admission query; it now
explicitly models no public admission. A test hook accidentally returned a mock
function as cleanup and was corrected before the passing run.

Do not deploy this partial cutover. General store/workspace resolvers, discount
credential consumers, the workspace callback, frozen voucher-cleanup reads and
mapped reinstall still need reconciliation. Full MySQL publication/lifecycle
races, SDK token exchange, current full build/public CI and named live acceptance
remain outstanding. The prior database checkpoint predates these runtime edits.

### Native reader checkpoint — September 9, 23:09 JST

`credential-source.ts` now owns a Store/coordinator/admission/credential-locked
read transaction. Workspace installation, canonical store resolution and local
loyalty discount credential resolution use this selector. Public installations
need no generic installer row or Project shop alias; native canonical resolution
does not inherit unverified legacy aliases. Missing/invalid native authority
never falls back. Pre-admission custom compatibility requires proof that no
native Store/app credential exists.

Review identified and fixed typed-error compatibility: known native
authentication/lifecycle failures become fixed reconnect-required adapter errors
(`bad_request` for workspace access, `AUTH_EXPIRED` for loyalty discounts), while
database failures remain operational failures. The bounded re-review found no
additional concrete defect. Native adapters and legacy compatibility tests are
explicitly separate; mocked source selection is not live credential evidence.

The final focused run passed 157 tests across eight files, and the web typecheck,
format checks and diff whitespace check passed. Initial test scaffolding lacked
the existing server-only mock and explicit legacy source fixture; both were
corrected. A real isolated MySQL run passed 15/15 in
`weletic_loyalty_it_access_20260909140647741`, including transactional native
selection, foreign workspace rejection and missing-admission downgrade rejection.
That DB run predates the typed-error-class refinement. Independent SQL found
zero remaining credential and Store rows; runner reconciliation found zero
pending/coordinator/session rows. The fixture schema is retained.

The cutover is still local and incomplete: generic discount-provider integration,
workspace connection callback, frozen voucher-cleanup credential reader and
mapped reconnect remain. No runtime schema, deployment, live transaction or email
was executed. The full loyalty objective and live acceptance gates are unchanged.

### Generic discount-provider checkpoint — September 9, 23:17 JST

The generic Shopify discount provider now selects native Store/app credentials
before Project aliases, environment overrides or generic installer records.
Its internal helper is named `requireShopifyCredential`; native results contain
no fabricated installer/account identity. `write_discounts` and typed reconnect
errors remain enforced. Legacy pre-admission behavior is explicitly retained.

Review found and fixed two publication risks. First, each native creation-path
GraphQL request now holds the Store lock and rechecks workspace, canonical shop,
installation generation, active privacy lifecycle and active company approval.
This includes requests on collision retries. Deactivation remains separate from
the creation approval gate. Second, native creation and deactivation disable the
shared GraphQL helper's SDK fallback, preventing a second credential source or
ambiguous mutation retry after a direct timeout/401. No transaction retry wraps
provider I/O. Bounded re-review found no additional concrete issue.

The focused run passed 65 tests across five files; the web typecheck, formatting
and diff whitespace checks passed. It covers native provider
creation without installer/Project alias, scope/auth/storage errors, rejection
for pending/suspended/frozen/foreign/new-generation stores, and suspension before
a collision retry. Real provider plus real GraphQL helper tests use mocked fetch
401/timeout responses and establish one fetch with zero SDK calls. Database,
source selection and network are mocked in these provider tests; this is not a
real discount or MySQL suspension race.

The remaining cutover work is the workspace connection callback, frozen
voucher-cleanup credentials and mapped reinstall. In particular,
`handleVoucherPrivacyCleanup` still calls the ordinary active-only credential
resolver and must receive a separately authorized frozen cleanup path before
deployment. No runtime migration, Shopify mutation or email was performed.

### Frozen voucher-cleanup checkpoint — September 9, 23:27 JST

The local draft now supplies a separate frozen credential reader to
`handleVoucherPrivacyCleanup`, superseding the missing-path status above.
It requires an exact frozen Store/app/generation, matching admission, native
encrypted credentials with `write_discounts`, and a currently owned processing
lease bound to the cleanup's redemption, code and source. A linked unfinished
privacy request must authorize the operation; uninstall payloads must match the
shop and generation. Lease freshness is checked again after authorization waits.
The same transaction holds the credential and lifecycle fences through each
bounded lookup or deactivation, reusing the shopper fence without a nested Store
transaction. Missing or invalid authority never falls back to legacy credentials
or SDK sessions. This path cannot issue rewards or refresh credentials.

Verification passed 63 focused tests across the frozen reader, native credential
primitive and cleanup handler, plus the web typecheck. Bounded review found no
concrete authority or lock-order defect before the final post-wait lease check.
The latest isolated MySQL run passed all 16 tests against retained fixture
`weletic_loyalty_it_access_20260909142636655` on port 3307, including actual frozen
credential reads and completed-request/expired-lease rejection. Independent SQL
counts confirmed zero remaining Store, native credential, cleanup, request-link
and compliance-request rows; the runner also reported zero pending, coordinator
and session rows. Supporting tables are minimal fixtures, not full production
schema or real Shopify webhook/discount evidence.

Remaining work includes real handler-level MySQL privacy/lease races, operational
validation of the bounded transaction duration, and explicit legacy frozen-cleanup
compatibility before deployment (the new path deliberately rejects legacy-only
credentials). Workspace callback and mapped reinstall integration remain open.
No runtime schema application, deployment, installation, order, redemption or email
occurred. All changes remain local drafts; the frozen import stream is untouched.

### Legacy callback isolation checkpoint — September 9, 23:38 JST

The workspace pasted-token callback is now fenced before remote verification and
again inside its final write transaction. Any public admission (including pending,
uninstalled or redacted) rejects with guidance to authenticate inside Shopify
Admin. Native credentials without their admission also reject instead of reverting
to generic user-owned storage. This protects the SDK authority already implemented;
it does not make the old callback a public-app authentication mechanism.

Review identified an initial tombstone/coordinator lock-order inversion. The final
implementation consistently locks Store, privacy tombstone, coordinator, admission
and native-credential absence; the callback's later tombstone reads were removed.
Bounded re-review found no additional concrete defect. The callback still preserves
legacy pre-admission behavior; public-runtime exclusion of manual legacy bootstrap
and the legacy/custom cutover need explicit release verification. Webhook provisioning
can precede the final recheck if admission changes during remote work, but no Store,
alias or generic credential publication follows a rejected final fence.

The focused fence/callback suites passed 36 tests. Web typechecking and diff
whitespace checks passed. Fresh isolated MySQL fixture
`weletic_loyalty_it_access_20260909143657228` passed all 17 integration tests,
including an absent-Store race with real SQL: an existing SDK coordinator is held
while the callback completes Store/tombstone reads; SDK admission commits and the
callback then rejects. This is service-transaction evidence, not a real SDK provider
exchange, full callback HTTP race or live installation. The initial run failed only
its final fixture count assertion (using a nonexistent raw-shop field); the corrected
assertion uses the returned admission ID. Independent SQL confirmed zero remaining
Store, native credential, cleanup, request-link and compliance-request rows; runner
pending/coordinator/session counts were also zero. Fixture schemas remain retained.

Mapped reconnect and the native disconnect UX remain unfinished. No new runtime
migration, external publication, deployment, Shopify mutation or email occurred.
These changes remain uncommitted local drafts alongside the coordinated cutover.

### Mapped Shopify-native reconnect checkpoint — September 9, 23:49 JST

Mapped reconnect now has a local implementation in the existing signed gateway.
It preserves the exact retained Store/workspace mapping without selecting a
Weletic User or recreating a generic integration. Its private observation includes
the company-access revision. Preparation verifies a fresh Shopify identity again
after all lock waits, matching frozen Store/admission generations and uninstall
cutoffs, a completed uninstall for that cutoff, no pending uninstall/redaction or
voucher cleanup, zero retained native/generic credentials and a disabled loyalty
program with its kill switch set. Privacy tombstones reject reconnect.

The atomic transition revokes SDK leases and sessions, rotates Store/admission
generation, removes this app's old staff grants, resets company access to pending,
and appends access/admission audit records. It neither enables loyalty nor issues
credentials. The ordinary coordinated SDK publication path must supply fresh
credentials afterward. Operator activation now requires the mapped generation's
actual decryptable native credential; missing admission cannot downgrade an
orphan native installation into legacy approval. Suspension remains independent
of healthy admission. Bounded review found no concrete defect in this slice.

Verification: 76 focused reconnect/gateway/approval tests, 29 Shopify-app tests,
and both web and Shopify-app typechecking passed. Retained isolated fixture
`weletic_loyalty_it_access_20260909144713696`
passed 19 real MySQL service tests, including one winner among competing mapped
reconnects, rollback of generation/approval/grants/audits/coordination, and rejection
of approval before fresh credential publication. The publication in this test is
explicitly synthetic and invokes the real encrypted persistence primitive, not a
Shopify provider exchange. Independent SQL confirmed zero remaining Stores,
credentials, Projects, generic integrations, grants, access/admission audits and
programs; runner pending/coordinator/session counts were also zero. The separate
approval suite passed all nine tests on retained fixture
`weletic_loyalty_it_access_20260909144800434`, with zero remaining Store/program/
access-audit rows. Initial fixture failures (MySQL boolean representation and a
missing synthetic encryption key) were corrected before these passing reruns.

This supersedes earlier statements that mapped reconnect has no implementation,
not the outstanding acceptance gates. Still required: real SDK publication and
provider-failure recovery after mapped preparation, install/reinstall browser
journeys, current store-currency/scope verification, privacy/worker races and
native disconnect UX. Reinstall with unfinished cleanup remains unavailable;
recovery when Shopify has already revoked cleanup credentials still requires
explicit operational/capability validation. No new runtime schema, deployment,
installation, activation, order, redemption or email was performed. The full
cutover remains a local uncommitted draft and import work remains untouched.

### Store-owned disconnect and SDK recovery checkpoint — September 9, 23:57 JST

The existing workspace-authenticated administrative disconnect callback no longer
requires a generic integration row. Its idempotency key is a stable SHA-256 of
the Store/generation identity, so deleting credentials does not change the command
identity and reinstall does. The internal disconnect service requires the observed
generation and checks it under the ingress Store lock before creating a durable
request. A delayed command cannot freeze a replacement installation. Terminal
redaction remains privacy-safe and ordinary signed Shopify webhooks retain their
timestamp-based behavior. Bounded review found no concrete regression. This is
not a new Shopify-owner endpoint or a Shopify uninstall API; merchant uninstall
continues through Shopify Admin and the existing authenticated webhook lifecycle.
The legacy administrative key format changed, so old in-flight manual commands
need rollout compatibility review before this code is used in a legacy runtime.

The focused callback/ingress suites passed 54 tests. The actual SDK suite passed
28 tests, including authenticated offline token exchange from a prepared-generation
snapshot with no session/token, one simulated provider failure, and success on a
fresh request without recreating the generation. SDK/storage/signature code runs
for real; provider and backend HTTP transports are fixtures, not live Shopify or
MySQL in that SDK test. The fixture's missing-session digest was corrected to a
non-null hash to match the actual snapshot contract and deletion acknowledgements.

Fresh retained fixture `weletic_loyalty_it_access_20260909145531280` passed all 20
isolated MySQL tests, adding stale administrative-disconnect rejection after an
actual locked generation replacement, with no request insertion or freeze. This
is a post-replacement fence test, not a fully concurrent HTTP disconnect race.
Independent SQL confirmed zero remaining Store, native credential, Project,
generic integration, staff grant, access/admission audit, program, compliance
request and cleanup rows. The runner confirmed zero pending/coordinator/session
rows. Web typechecking passed. Monorepo lint completed successfully (ten tasks,
nine cached). The broader unit run stopped on September 10 at 00:01 JST with
1,612 tests passed and one archived-discount fixture failure; bail-on-failure
prevented completion of the remaining suite. That legacy fixture lacked the new
credential-source contract. It now explicitly mocks legacy selection, while
separate credential-source contracts retain authority/fail-closed coverage.
The affected archived-discount suite passed all 37 tests afterward. A full
monorepo rerun started at 00:02 JST and remains pending; this is not a green
full-regression result yet. No production authorization was relaxed for the fix.

Still required: full SDK-to-database install/reinstall proof, browser recovery and
settings UX, current scope/currency verification, worker/privacy races, final
cutover build/CI and applicable named live acceptance. No runtime schema,
deployment, Shopify installation/uninstall, order, redemption or email occurred.
All changes remain local drafts; frozen import changes remain untouched.

- Complete signed POST publication integration coverage, including first-install
  response acknowledgement and mapped-store transitions. The connected services
  have local tests, not named live installation acceptance.
- Prove pending reconnect through real MySQL races and SDK recovery after a
  committed preparation followed by provider failure. Local action/loader tests
  do not establish end-to-end recovery or real browser reachability.
- Finish reinstall integration across pending and mapped generations. Reconcile
  retention of the separate legacy store-access operator audit before release;
  admission mapping-audit erasure does not cover that table. Do not route unknown
  installs through a fabricated mapped store. Measure admission cleanup scan/lock cost;
  bounded deletion does not prove bounded rows examined.
- Test the actual MySQL transaction path: first-install races, authentication vs
  uninstall, mapping vs reinstall, audit rollback, key rotation and exact cleanup.
- Browser acceptance of actual components at 375px, EN/JA/VI, keyboard, loading,
  permission/error states, and absence of private identifiers.
- Final full validation, adversarial review, PR/CI. The new migration has only
  run in a fresh isolated test fixture, not a runtime/shared database. This local
  draft has not been published or merged.

## Local verification so far

- 122 focused tests passed across admission, mapping, status gateway, privacy-key
  retirement and existing coordinated online authentication (five files).
- Existing Shopify route bootstrap suite: 27 tests passed.
- Reconnect/status tests: 33 passed after adding private-observation, bootstrap
  failure and browser-controlled-authority rejection coverage. Shopify bootstrap
  tests now pass 29/29, including the static shell's independence from a failing
  normal loader and safe rendering of ordinary bootstrap errors. Review found
  that Shopify's error helper rethrows ordinary errors before the recovery link;
  a typed-response guard now preserves Shopify response handling and renders a
  fixed fallback for ordinary errors. Web and Shopify typechecks passed on the
  initial reconnect draft. Shopify typecheck and the Remix client/SSR build also
  passed after the boundary fix, with sourcemap and future-flag build warnings.
  Bounded re-review found no further defect in that fix; full feature acceptance
  remains outstanding.
  These use mocked transports and are not live installation evidence.
- The real-HMAC reconnect HTTP boundary passed ten tests: signed operation
  dispatch, tampered body, wrong path, stale/absent signatures, strict payload
  validation, size limits and non-sensitive failure responses. Database/service
  execution is mocked in this suite; claim freshness is tested in the service
  suite, not inferred from a valid service signature.
- Expanded isolated MySQL suite passed 11/11 in
  `weletic_loyalty_it_access_20260909125554383`. Competing reconnects yielded one
  successful preparation; ordinary admission publication reused the resulting
  pending generation without mapping or activation. An injected transaction
  failure rolled back generation/revision, coordinator revocation and session
  deletion together. Independent pending/coordinator/session counts were zero
  after fixture cleanup. The schema was retained on port 3307. This models a
  provider failure by leaving preparation committed without a session; it does
  not execute Shopify token exchange or prove SDK recovery. Web typecheck passed
  after the database-test additions.
- A stronger rerun passed 11/11 in
  `weletic_loyalty_it_access_20260909125745062`, asserting the losing concurrent
  reconnect receives the lifecycle-fence error rather than accepting any database
  rejection as success. Independent pending/coordinator/session counts again
  returned zero. Web typecheck also passed after the HTTP-test additions.
- Session/snapshot/tenant tests: 42 passed; privacy/compliance tests: 73 passed.
- Store-access/accounting regression suite: 142 passed. Activation rejects
  unmapped, foreign, stale-generation and privacy-inconsistent admission; status
  also fails closed on contradictory uninstall/redaction timestamps.
- Five real MySQL tests passed in `weletic_loyalty_it_access_20260909121056928`
  using a dedicated schema-scoped non-root principal on port 3307. They cover
  concurrent first admission, lease revocation, post-redaction replay, no raw-shop
  persistence for unknown customer-data requests, and non-extending retention.
  Independent post-run pending/coordinator/session counts were zero. The minimal
  fixture schema was retained; this is not full-schema or live Shopify proof.
- Nine real MySQL store-access tests passed in
  `weletic_loyalty_it_access_20260909121927342`, including rejection before exact
  pending mapping, concurrent approval, audit rollback and suspension fencing.
  Independent post-run store/program/access-audit counts were zero; fixture
  cleanup also deletes the test pending record. The schema remains isolated.
  An earlier run in `weletic_loyalty_it_access_20260909121904379` stopped before
  test setup because of a test-module import/hoisting error; the test import was
  corrected and the successful rerun used a different fresh database.
- Retention integration: 13 focused tests passed. The expanded pending MySQL
  suite passed 7/7 in `weletic_loyalty_it_access_20260909123037276`, with independent
  pending/coordinator/session counts zero after fixture cleanup. A prior run in
  `weletic_loyalty_it_access_20260909122733508` exposed a real secondary-index
  deadlock; primary-key candidate locking fixed that regression. The concurrent
  test holds the lifecycle lock until cleanup returns zero, then releases it in
  `finally`. It uses a synthetic lifecycle update, not the still-unimplemented
  reinstall endpoint. Failed and successful fixture schemas were retained; neither touched
  the runtime database.
- Prisma generation and formatting passed. Only the fresh fixture received the
  draft migration; `weletic_loyalty_dev` and legacy/production were untouched.
- Web and Shopify typechecks passed during development; repeat on final diff.
- Full development unit run completed with 373 web files, 5,759 tests passed and
  six existing skips; Shopify bootstrap tests passed 27/27. Monorepo lint also
  passed. Retention edits overlapped that run and had separate focused/DB checks;
  rerun the full gate on the final feature diff before publication.
- Mapped/pre-mapping privacy: 102 focused tests passed, including ingress-hook
  proof that a stale uninstall cannot freeze newer admission or Store/program
  authority. Expanded real MySQL suite
  passed 9/9 in `weletic_loyalty_it_access_20260909123648552`, including exact mapped
  and provisioned-but-unmapped freeze/erasure, and rollback of admission state and
  operator audit after an injected finalization failure. Independent post-run
  pending/coordinator/session counts were zero; fixture cleanup also deletes its
  exact Store rows. These are service transactions, not live Shopify webhooks.
  Bounded review found and fixed the initially missed pre-mapping interval.
- Review found and fixed mapped-status stale JWT handling. A second finding added
  the immutable target store reference to the mapping audit. Lifecycle integration
  and real transaction behavior remain unproven by these unit mocks.
- Bounded re-review found no remaining regression in replay cleanup, activation
  mapping validation, emergency suspension or contradictory status flags. This
  does not accept the unfinished reinstall lifecycle; mapped privacy has the
  separate transaction evidence recorded above, not live acceptance.

## Execution boundary

### Remaining consumer audit — September 10, 00:05 JST

Read-only inspection found these remaining cutover tasks; none is live acceptance:

- `apps/web/scripts/connect-shopify-store.ts` still chooses the first workspace
  member, writes the Project alias and generic credentials directly, then starts
  catalog sync. It does not use the callback's public-admission fence. Do not use
  this script to bootstrap the public app. Reconcile its write transaction with
  the shared legacy fence, reject admitted/native identities before any write or
  sync, and test admission races plus unchanged unrelated provider behavior.
- `apps/web/scripts/loyalty/reconcile-shopify-installation-scopes.ts` reads and
  updates only generic credentials. Zero generic rows make a native installation
  fail; leftover rows could cause it to query the wrong credential authority.
  The replacement must resolve the current Store/app/generation, verify scopes
  against that credential and fence publication against token/revision changes.
  It must not copy a legacy credential into native storage or accept cached scope
  metadata as live verification. Existing staging guards remain required.
- `apps/web/app/api/integrations/route.ts` and the generic integration settings
  page determine installation presence from generic rows. Native-only stores can
  consequently appear disconnected there. Expose Shopify lifecycle status using
  the existing authenticated boundary without fabricating installer ownership;
  verify empty, pending, active, uninstalled and stale-auth rendering.
- `apps/web/app/api/integrations/uninstall/route.ts` deletes generic rows and
  requires their installing Weletic user. This is not a native Shopify uninstall
  path. Do not route the new merchant experience through it. Verify Shopify Admin
  uninstall/webhook handling and ensure stale generic actions cannot misrepresent
  native credential revocation; retain other providers' existing contracts.
- Bounded independent review confirmed that the generic uninstall endpoint also
  bypasses the legacy Shopify freeze/voucher-cleanup lifecycle, not merely native
  presentation. Reject Shopify deletion through this generic endpoint and direct
  workspace callers to the existing generation-fenced disconnect path. Test zero
  deletion for Shopify, exact workspace ownership, and unchanged permitted
  uninstall behavior for non-Shopify integrations. The old scope script should
  be explicitly legacy-only and fenced; native scope refresh belongs to the
  coordinated credential path, not a second operator credential writer.
- Native publication in `apps/web/app/api/internal/shopify/sessions/route.ts`
  persists SDK token/scope material but currently does not refresh Store currency.
  The remote shop-currency verification in that file belongs to legacy activation.
  Current currency and scopes after fresh native authentication remain explicit
  release tests, not something established by the synthetic publication fixtures.

Full current Prisma schema application passed in fresh isolated
`weletic_loyalty_it_access_20260909150336886` on port 3307 (10.75 seconds).
Its production web build and the separate full-unit rerun are still running.
No runtime schema migration, external call or live-store action was performed
for this audit. This fixture is retained and does not replace runtime migration
approval or named install/reinstall evidence.

### Generic uninstall boundary — September 10, 00:10 JST

The generic integration uninstall handler now rejects Shopify before generic
deletion or provider effects. Existing workspace permission and installer checks
remain unchanged; merchant app removal stays in Shopify Admin, while the existing
workspace disconnect handler retains lifecycle/generation fencing. Seven focused
handler tests passed for Shopify rejection, exact workspace lookup, missing rows,
ownership denial and unchanged Slack/Google Ads/other-provider success. Auth is
mocked at the wrapper boundary; these are not authenticated browser acceptance.
Independent bounded review found no concrete regression.

The previous full-unit rerun terminated with 2,032 passing tests and one failing
legacy two-way-sync fixture; bail-on-failure left the remaining suite unexecuted.
Like the archived-code fixture, that in-memory simulation lacked the new
credential-source contract. It now explicitly models legacy selection, without
changing production auth. Its 19 tests plus the seven uninstall tests passed.
A sanitized full web-unit diagnostic run now uses bail=0 to collect all remaining
failures in one run; repository scripts and CI were not changed. This run remains
pending. Web typechecking completed successfully after this delta; formatting
and `git diff --check` also passed.

The ongoing full-schema production build compiled successfully in 4.1 minutes
and reached lint/types. It started before this uninstall delta and cannot serve
as the final unchanged-tree release build, regardless of its eventual result.
No new PR, runtime migration, deployment or live mutation occurred.

### Retired direct bootstrap — September 10, 00:13 JST

`apps/web/scripts/connect-shopify-store.ts` no longer selects the first workspace
member, writes unverified/plaintext credentials or starts catalog synchronization.
The compatibility module function rejects with fixed guidance, and direct CLI
invocation exits with status one, with or without the old positional arguments.
It imports only Node path/URL utilities, not runtime configuration or database
clients. Managed installation goes through Shopify Admin; legacy callers must
use the existing authenticated/fenced connection settings. Repository search
found no internal caller beyond the script itself and this implementation record.
This intentionally retires the unsafe shortcut, not the supported legacy workflow.

Three tests passed, including actual `node --import=tsx` child processes with
sanitized environments, fixed output and no echoed synthetic credentials/shop.
Independent bounded review found no concrete issue. Focused lint passed. The
first typecheck caught the fixture's required `NODE_ENV` declaration; its child
environment now explicitly sets `NODE_ENV=test`. All three tests passed again;
the typecheck rerun remains pending. Formatting and diff whitespace checks passed.

The retained full-schema fixture
`weletic_loyalty_it_access_20260909150336886` completed the production web build
with exit zero, all 367 static pages, optimization and traces. Post-build SQL
counts for Store/program/access-audit were all zero. The run began before the
generic-uninstall and retired-bootstrap changes; it is successful native-cutover
baseline evidence, not the final unchanged-tree build. The full web-unit
diagnostic remains running. No runtime migration, live installation, remote
Shopify action, order, email, merge or deployment occurred.

### Legacy scope writer fence — September 10, 00:19 JST

The staging scope-reconciliation script now runs its read/publication under
Store/privacy, legacy-admission/coordinator and credential-row locks. Public
admissions or orphan native credentials reject before legacy token access. It
requires the credential's exact current installation generation. The remote
scope query has zero retries and a five-second timeout within a fifteen-second
transaction; this is a read, not subscription/scope authorization in Shopify.

Review identified two gaps in the first implementation, both fixed: credentials
now come directly from the locking SQL query rather than a potentially stale
repeatable-read snapshot; scope apply uses `advanceLegacyShopifySessionRevision`
atomically with publication. SDK-promoted coordinators reject legacy scope apply,
so delayed SDK observations cannot overwrite an operator's scope update. Native
refresh remains the coordinated SDK path, not a new operator credential writer.
CLI parsing now also occurs inside the fixed safe-error handler.

The focused legacy-scope, legacy-fence and coordinator input suites passed 34
tests. Their services/transactions are mocked; actual SQL scope-write concurrency
and rollback remain required. Preview does not update credential scopes or
advance revisions, but the shared fence may establish a missing coordinator
anchor; do not describe it as entirely mutation-free. Final typecheck and
focused lint/format passed. The previous retired-bootstrap typecheck passed.
The full web diagnostic completed: 381 files passed, five failed; 5,922 tests
passed, 25 failed and six skipped. It predates these new scope-script tests.
Remaining failing files are `performance-e2e.test.ts`,
`adversarial-stress-shopify-sync.test.ts`,
`challenger-discounts-rewards-stress.test.ts`,
`test-store-validation-harness.test.ts` and
`challenger-2-adversarial-ui-api.test.ts`. A focused diagnostic rerun of these
five files is underway; causes are not yet established. This is a red regression
gate, not completion. No live script execution or runtime change occurred.

### Regression fixture reconciliation — September 10, 00:22 JST

The focused rerun reproduced 24 failures across four suites; the performance
suite passed unchanged. Stack traces traced those failures to the new credential
source being invoked by old in-memory legacy fixtures lacking lifecycle and
transaction records. These suites now explicitly mock legacy source selection,
retaining their discount/scope errors, webhook signatures/idempotency and
validator assertions. Native source authorization is still exercised separately
by the dedicated native/credential-source suites; these legacy mocks are not
native authentication acceptance.

All five diagnostic suites then passed: 157 tests. No runtime guard, assertion,
performance threshold or test selection was weakened. The earlier performance
failure is not reproduced and is not claimed fixed. The standard monorepo unit
command has been restarted after the terminal diagnostic, with the original
repository bail-on-failure setting. Its result remains pending. Latest web
typechecking and focused lint passed. This does not supersede the previous red full-run receipt
until the new run completes. No external mutation or release occurred.

### Scope writer SQL evidence — September 10, 00:26 JST

Fresh isolated fixture `weletic_loyalty_it_access_20260909152534524` passed all
24 MySQL tests. Four additions invoke the real legacy scope operator, lifecycle
fences, encrypted credential reads and SQL publication. Shopify GraphQL transport
is synthetic: no real token validation or remote scope change is claimed.

The additions prove successful scope/revision publication, rejection of an older
SDK acquisition observation afterward, unchanged credentials/revision when SDK
promotion rejects legacy apply, and public-admission rejection before transport.
An injected SQL CHECK failure at the credential update also proves the preceding
coordinator increment rolls back. The exact temporary constraint was removed in
`finally`; independent SQL found zero remaining constraints, Store, generic/native
credential and Project rows. Runner counts for pending/coordinator/session were
also zero. The fresh schema and its non-root principal are retained.

An initial trigger-based failure fixture was unsupported by Prisma's prepared
statement protocol; it was replaced with the scoped CHECK constraint. No runtime
schema or server configuration was changed. Typechecking exposed unsupported
BigInt literal syntax in the test; equivalent `BigInt(...)` assertions fixed it,
and typechecking passed. The full monorepo unit run is still in progress. No
deployment, installation, order, email or release occurred.

### Full-schema checkpoint — September 9

The complete current Prisma schema applied successfully to fresh isolated
`weletic_loyalty_it_access_20260909130447218` on port 3307 with a dedicated non-root
principal. This uses `prisma db push` on an empty fixture, not the reviewed SQL
migration against a populated runtime database. Repository lint passed all ten
tasks (nine cached) after the reconnect changes. The production web build then
completed with exit code zero: compilation, lint/types, all 367 static pages,
optimization and build traces finished. Independent post-build Store, loyalty
program and store-access audit counts were zero. The fixture schema is retained.
Warnings included disabled Redis/QStash configuration, an existing re-exported
`revalidate` setting and edge-runtime static-generation limits. This is a local
build with external transports disabled, not runtime worker/delivery validation,
live installation evidence or a public CI pass.

### Mapped reconnect ownership decision — September 9, 22:04 JST

**Resolved by [ADR 0025](../adr/0025-shopify-native-store-installation-identity.md):**
Hiro selected Shopify-native installation and store-scoped authority, not the
mandatory operator-owner bootstrap proposed below. Preserve the following as
investigation history, not an outstanding approval request. Implementation must
remove the generic integration's user-ownership dependency and honor ADR 0018;
the Shopify owner does not need a separate Weletic account for store administration.

Tracing the actual `app-uninstalled.ts` credential-scrub transaction established
that completed uninstall deletes the generation's `InstalledIntegration` rows
and clears `Project.shopifyStoreId`. A reconnect implementation that requires a
retained installation is therefore incompatible with the normal post-cleanup
state. Bounded review independently confirmed this. That attempted wiring and
its synthetic retained-credential tests were removed before publication; mapped
reconnect still fails closed. Their passing unit tests are not acceptance.

Restoring the installation requires an existing Weletic user owner, which is not
the Shopify staff ID in a verified App Bridge token. Do not fabricate that owner,
select an arbitrary workspace member, or weaken credential erasure. Proposed
decision for Hiro: add audited operator bootstrap requiring an explicitly
selected existing authorized workspace user, exact store/app identity and current
generation/revisions. It recreates only tokenless installation metadata after
completed cleanup, resets store approval, keeps loyalty disabled, and leaves
fresh SDK authentication and subsequent company approval as separate steps.
An alternative is redesigning uninstall to retain a tokenless owner binding;
that changes the privacy contract and is not assumed approved.

Required tests after the decision: use actual post-scrub state with zero
installations; reject foreign/removed users, stale revisions/generations,
uncompleted cleanup and redaction; verify atomic ownership/audit rollback,
credential publication and stale-worker rejection. Reconcile the existing
workspace connection callback with admission generation updates as well.

Keep the new schema application, public exposure, installations, operator
activation, real orders/redemptions/email and deployment behind their existing
explicit gates. The earlier PR #5 migration receipt applies only to that previous
reviewed migration. Import PR #13 and its working tree remain untouched.
