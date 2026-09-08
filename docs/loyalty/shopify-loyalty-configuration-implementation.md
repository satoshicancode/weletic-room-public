# Embedded Loyalty configuration implementation

Status: in progress. The embedded configuration page is implemented locally;
live acceptance is not claimed. This increment implements part of package 8 of the
approved unified completion plan; it does not replace the remaining Loyalty work.

## Scope and sequence

1. Share settings validation with the existing workspace API, retaining its
   numeric-string compatibility and error responses.
2. Add explicit browser-safe read/update contracts and a minimal configuration
   projection. Preserve exact decimal strings; do not serialize Prisma objects
   or financial integers through JavaScript numbers.
3. Add a signed Shopify gateway with fresh staff authorization and installation
   fencing in the same transaction as the existing settings writer. Reads must
   not silently initialize or activate a program.
4. Add the shared configuration editor and thin workspace/Shopify adapters, with
   English, Japanese, and Vietnamese copy. Keep existing links working.
5. Verify permissions, stale state, validation, policy snapshots, and financial
   invariants before opening the implementation PR.

Expected boundaries: `apps/web/lib/weletic/loyalty`, the existing workspace
settings route, `apps/web/lib/weletic/shopify`, the internal signed route,
`apps/web/ui/weletic`, and `packages/shopify-app/app`. No schema migration is
planned for this configuration increment.

## Contracts and safety

- Workspace numeric input compatibility remains intact during the transition.
  Strict new Shopify request contracts must not silently narrow old requests.
- Ordinary configuration requires the matching staff permission. Financial
  valuation and emergency controls retain owner-only authorization; installation
  alone is never authority. Module transitions retain their separately approved
  permissions and do not imply access to every configuration operation.
- Validate generation and stale configuration before writing. A lost response
  does not authorize retry; require a fresh read before another submission.
  The configuration token fingerprints selected state, update time, and earning
  policy version; it is not an unconditional write counter. An identical save
  within the same timestamp may retain the token. Fresh actor nonce/replay
  checks and no-automatic-retry behavior remain independently required.
- Reuse the existing settings writer, expiry calculations, and immutable earning
  policy publication. Do not create another points or configuration writer.
- Liability valuation stays unavailable until explicitly configured. Backfill
  commits remain gated. This UI work does not authorize historical repair,
  migration, automatic activation, or live configuration changes.
- Preserve exact input until persistence; numeric parser tests alone do not
  establish database precision, liability calculations, or accounting-currency
  correctness.

## Verification plan

- Numeric and contract tests: omitted/null values, exact decimal input, positive
  signed-64-bit valuation bounds, invalid and oversized inputs, expiry limits,
  all-or-none valuation updates, and old workspace compatibility.
- Production-service and isolated MySQL tests: unauthorized staff, owner-only
  controls, cross-store attempts, revoked grants, reinstall, stale reads,
  rollback, and immutable policy/expiry state preservation.
- Shared UI/client tests: permission-specific controls, stale visits, concurrent
  saves, uncertain responses, explicit recovery, and all three locales.
- Type-check, lint, formatting, full tests, builds, and adversarial review.
- Live `yamaxdev` evidence remains a separate acceptance step; local mocks do not
  prove App Bridge authentication or merchant configuration persistence there.

## Current evidence

2026-09-07: extracted the three existing numeric validators into a
transport-neutral module. The workspace route maps validation errors back to its
existing `bad_request` contract. All 178 focused numeric, API, RBAC, and dashboard
regression tests pass, including 42 new numeric cases. Focused lint, formatting,
and the web TypeScript check pass.
Read-only adversarial review found no actionable behavioral differences in the extraction.
These initial extraction checks did not prove the gateway, UI, or database path.

The new browser-safe configuration contract and transaction adapter are also
implemented locally. Fifty focused contract/adapter tests pass with mocked
authorization and persistence boundaries; web types and focused lint pass.
They cover owner-only controls, currency mismatch, generation mismatch, state
fingerprints, exact normalization, and no automatic writer retry. These are not
MySQL concurrency or authenticated HTTP evidence. Review corrected an overly
strong write-counter claim: unchanged earning policies need not publish a new
revision.

The signed HTTP endpoint, Remix adapter, and strict browser client are now
implemented locally. Thirty-one transport/client tests pass. The guarded
`127.0.0.1:3307/weletic_loyalty_dev` staff suite passes all 32 cases, including
five new configuration cases through production services/transactions:

- Read-only discovery, explicit draft initialization, separated staff/owner
  permissions, exact persisted decimal and `1/100` JPY valuation, and revocation.
- Competing signed updates: one commits; the changed-state loser conflicts.
  Replaying the actual winner returns `request_replayed`.
- A second worker starts while the first writer retains its transaction lock;
  after the first commits, the second conflicts without a policy/action write.
- A forced post-write failure rolls back the program, earning revision, and
  action receipt together.
- Invalid precision, accounting-currency mismatch, stale generation, and body
  tampering produce no configuration or action writes.

Fixture cleanup uses parameterized deletes for exact generated commerce Program
IDs because the isolated database intentionally lacks unrelated affiliate
enrollment columns used by Prisma's emulated cascade. Four leftover synthetic
Program rows from the initial teardown failure were inspected and removed;
the complete rerun, including cleanup, passed. No schema was altered.

Web and Shopify type-checks and the Shopify build pass. Review found no
production blocker and led to the stronger winning-nonce replay assertion.
Workspace editor consolidation, additional policy preservation cases,
full release verification, and live acceptance remain incomplete. No deployment,
real email, live store setting, or historical repair was performed.

## Shared UI evidence (2026-09-07)

The framework-neutral configuration editor and embedded `/loyalty` page now
cover points, expiry warnings, VIP qualification, valuation, and lifecycle
controls. Fifteen React tests cover changed-only writes, exact/invalid numeric
input, valuation clearing, owner/read-only controls, explicit draft creation,
three locales, pending-write revalidation, uncertain-save recovery, and scope
navigation. Eighteen embedded bootstrap tests pass. Web/Shopify types, focused
lint, formatting, and the Shopify build pass.

Review found and fixed two issues before committing: A→B→A navigation now gets a
fresh cache key, and draft creation sends displayed editable initialization
values instead of silently substituting English point labels. Lifecycle controls
remain omitted from draft creation. Recovery clears the old error notice only
when the same scope visit receives a successful fresh read.

Local Chromium used the production shared editor and browser client with
synthetic HTTP responses; every nonlocal request was blocked. Evidence under
ignored `output/playwright/loyalty-ui/.playwright-cli/`:

- English save retained `Controlled Loyalty` (`page-2026-09-07T12-30-59-778Z.yml`).
- Japanese mobile screenshot `page-2026-09-07T12-32-52-958Z.png`; Vietnamese
  screenshot `page-2026-09-07T12-35-08-591Z.png`. Viewport and document width both
  measured 375 px. A cramped language label was fixed after visual inspection.
- Synthetic HTTP 403 removed the entire editor
  (`page-2026-09-07T12-36-25-432Z.yml`). Keyboard navigation reached Reload with
  a visible 2 px outline; Enter restored `Controlled Loyalty`, not the rejected
  change (`page-2026-09-07T12-37-45-591Z.yml`).

The browser and local server were closed. This does not prove live App Bridge
authorization, real store persistence, complete accessibility, or workspace UI
consolidation. The final error-notice clearing refinement is covered by the React
regression test, not a repeated live-browser run.

## Workspace consolidation preparation (2026-09-07)

Moved the unchanged configuration selector, state fingerprint, and numeric
normalization into `lib/weletic/loyalty/configuration-state.ts`. The Shopify
adapter retains authorization, owner checks, installation and transaction
fences, currency validation, and stale-state rejection. This shared server
module grants no authority and does not perform database writes itself.

Four direct representation tests cover minimal selection, exact decimal and
signed-64-bit values, omitted versus cleared valuation, and explicit zero/false
controls. Together with existing contract, Shopify adapter, and shared UI tests,
69 focused tests pass. Web type-check and focused lint pass; test BigInt literals
were replaced with string constructors to support the repository's TS target.
Read-only review found no behavioral change or blocker.
The workspace endpoint/editor migration and preservation of its backfill tools
remain pending; this extraction does not claim workspace consolidation.

## Workspace configuration gateway (2026-09-07)

Added additive `GET/PATCH /api/weletic/loyalty-configuration`. The boundary uses
`withWorkspace` read/write permissions and forwards authenticated membership
role plus scope-restricted permissions, never body-supplied authority. Owner
membership alone cannot bypass a read-only token. Sensitive lifecycle and
valuation fields require owner authority in addition to write permission.

Workspace and signed Shopify gateways now use one transaction-local strict
configuration reader/writer. Workspace reads do not initialize a program;
updates check installation generation, acquire the existing operational fence,
recheck workspace/store binding, compare the shared fingerprint, and publish
through the existing policy writer. No schema changes, nested transactions,
automatic retries, or changes to the legacy workspace API were introduced.
Responses are private/no-store; invalid stored projections fail unavailable
rather than being reported as invalid client input.

Verification: 76 focused contract/state/service/HTTP tests pass. The complete
guarded staff MySQL suite passes 34 tests, including new workspace-versus-signed
Shopify overlap (one accepted update and one policy revision), read-without-
initialization, permission rejection, and workspace post-write rollback. HTTP
authentication itself is mocked in the new route tests; DB cases call the
workspace service with controlled authority and do not prove real workspace
login or token middleware. Fixture cleanup passed on isolated
`127.0.0.1:3307/weletic_loyalty_dev`; no schema or live-store changes occurred.
The cross-interface overlap starts requests together but does not observe actual
lock contention; the existing held-lock Shopify test is a separate proof. The
overlap also checks the persisted winning rate. Web types, focused lint,
formatting, and read-only review pass.

The duplicate workspace settings form and VIP policy controls still need to
move to the shared editor while retaining backfill previews/audits. Full release
verification, PR creation, and live acceptance remain pending.

## Workspace editor consolidation (2026-09-07)

The workspace Settings tab now mounts the same three-locale configuration editor
as Shopify through a workspace-scoped, validated browser client. It no longer
maintains separate general, valuation, status or kill-switch forms. VIP tier
management remains in the VIP tab; its duplicate policy form now navigates to
the shared Settings tab and updates the tab URL. Existing Settings links remain.

Backfill preview controls, history and the existing preview modal are retained;
the commit gate is unchanged and disabled. The rate label reflects the saved
rate, and projected credits are no longer substituted into committed totals.
Legacy backfill inputs and its API remain otherwise unchanged.

The new client validates exact changed-field acknowledgements, uses an explicit
workspace URL and same-origin credentials, and never retries mutations. Review
found and fixed a missing request deadline and an obsolete refresh callback:
an eight-second deadline now covers fetch plus body parsing, and visit identity
and unmount cleanup prevent late saves from refreshing a different workspace.

Focused tests exercise the client, shared editor and mounted workspace tab,
including retained preview generation, committed-total labeling, shared saves,
uncertain recovery, late workspace-A completion after switching to B, and VIP
policy navigation with tier creation retained. Modals and backfill API calls are
mocked in these UI tests. This is not a live workspace/Shopify browser proof;
full release checks and live acceptance remain pending. All 35 focused client,
shared-editor and workspace UI tests pass, together with focused lint and web
type-checking. The final review found no remaining blocker.

## Whole-branch preflight (2026-09-07)

Root formatting and lint, Prisma validation, Shopify type-check/build, 18
Shopify bootstrap tests and 10 discount-extension tests pass. Whole-branch
adversarial review found no actionable blocker. The seven local Loyalty
validators (expiry, referrals, VIP, earning actions, Flow, Gift Card/Store Credit,
bonus campaigns) pass in mock/static mode only. The standalone referral run
first failed for a missing privacy key; rerunning in test mode used the existing
deterministic test key and passed. None of these runs proves live delivery,
checkout or workflow behavior.

Web compilation succeeded. The subsequent full-build page-data phase failed
because the existing partner-login `generateStaticParams` queries commerce
programs and the deliberately dummy database at `127.0.0.1:9` was unavailable.
No merchant database was substituted. Service-backed generation and Playwright
remain required in the Full Release Gate; local compilation is not a full-build
pass. The complete web unit run passed 319 files: 4,944 tests passed and six
skipped (4,950 total). The skipped tests are not counted as acceptance proof.
