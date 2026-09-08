# Shopify staff authorization — implementation in progress

Date: 2026-09-07. Implements the accepted policy in
[ADR 0018](../adr/0018-shopify-owner-and-store-scoped-staff-access.md).
This draft is not deployed. Its new merchant endpoint explicitly requests online
authentication when called; existing `authenticate.admin` remains offline-configured.
No live store access has been granted.

Final local verification on 2026-09-07: the complete web unit suite passed
4,597 tests in 300 files, with six skipped. The separate isolated MySQL staff
suite passed 18 tests and the Shopify route suite passed three. Repository-wide
Prettier, web lint, web/Shopify type-checks, Prisma validation, Shopify build and
the guarded web compile-mode build passed. The latter is compilation evidence,
not a live runtime acceptance or full production deployment. Final independent
read-only adversarial review found no blocking issue. CI and shared-schema
merge confirmation remain separate gates.

## Operational retention boundary

Routine age-based deletion is not implemented or enabled in this draft. No
production retention duration has been selected. Approval to continue development
does not supply a number of retention days.

Any later retention implementation must preserve current-installation grant
rows, including empty/revoked grants: their revisions prevent stale create
requests from restoring access. It must distinguish obsolete installation grants
from current grants using verified lifecycle identity, not an assumed store alias.
Financially relevant action evidence must not inherit a generic access-log TTL.
Unknown action classifications must be retained rather than guessed nonfinancial.
Deleting nonce receipts must never reopen the accepted actor replay window.

Shop-erasure processing is a separate, explicit privacy workflow, not this
unconfigured operational TTL. Its bounded cleanup and lifecycle locking are
covered below. Before routine retention can be activated, an explicit policy,
bounded audit-first candidate selection, replay/financial safeguards and database
tests are still required. No ordinary-retention cleanup has run.

## Scope and contracts

- Framework-neutral actor and permission contracts live in
  `apps/web/lib/weletic/shopify/staff-contract.ts`. The signed actor carries
  canonical app/store/installation/user/session identity, ciphertext digest,
  fresh exchange time and a one-request nonce. It carries no owner or grant flags.
- Staff permissions are exact allowlisted operations. Access management is
  owner-only. No permission implies affiliate, billing, payout, workspace or
  release authority. Business eligibility and financial gates remain separate.
- Transactional resolution in `staff-authorization.ts` locks the store lifecycle,
  current installation/offline coordination and online row before checking the
  database clock, encrypted identity and current staff grant. It writes a nonce
  receipt/audit in the same transaction as the caller's business operation.
- `staff-grants.ts` performs owner-only grant replacement with an expected
  revision. Empty permissions revoke; old installation grants are not adopted.
  At the maximum revision only revocation remains possible, never regranting.
- Additive `WeleticShopifyStaffGrant` and `WeleticShopifyMerchantAction` schema
  contains no raw tokens, email addresses or arbitrary request payloads.

## Required remaining implementation

1. Finish merchant-screen integration with the new browser authenticator.
   `withAuthenticatedMerchant` now verifies the bearer JWT through the SDK,
   requires canonical issuer/destination/subject and time claims, performs an
   online-only exchange, and compares the returned shop/user before saving.
   Minting requires the original operation, exact saved properties and ciphertext
   digest, and consumes one mint per exchange. Cached sessions cannot mint actors.
2. Extend merchant gateways beyond the new signed staff-grant POST route and
   keep workers/webhooks separate. The grant route signs the entire actor and
   input, rejects unsigned actor headers, and resolves authority inside the
   actual grant transaction. The Shopify `/api/merchant/staff-grants` action now
   connects the fresh browser authenticator to this signed backend route. No
   cookie/query token or offline fallback is provided.
   The owner-only list route and `/api/merchant/staff-grant-list` adapter now use
   this same boundary. Each page checks current authority, and its opaque keyset
   cursor is scoped to the app/store/installation. Revoked and invalid grants
   remain visible with explicit status, never implied active permissions.
3. Wire permissions into existing dashboard/catalog and new loyalty/reviews
   services. Keep affiliate data separate, enforce effective online scopes for
   Shopify calls and never fall back to an offline token after a staff denial.
   The new `/api/merchant/overview` adapter now forwards a fresh actor to the
   signed `/api/internal/shopify/merchant/overview` POST. Its native catalog
   status projection requires `overview.read` in the same transaction as the
   read and nonce audit. It contains no affiliate/customer/financial records;
   the owner-only staff-management affordance is derived from verified evidence.
   It does not invoke Shopify or borrow offline credentials. The homepage now
   reads this endpoint using a fresh App Bridge token. Its installation-only
   loader preserves `authenticate.admin` bootstrap but returns private `null`,
   never merchant/session data. It no longer reads affiliate stats/review health
   through service-only routes or dispatches catalog sync. Legacy form POSTs
   return 405. Three-locale copy labels catalog sync unavailable on this screen;
   a properly scoped merchant sync path remains required before activation.
   Owner-only staff navigation is a UI hint, not authority; its destination
   independently authenticates every request. Internal legacy service routes
   still require compatibility/retirement review, and full merchant management
   screens remain incomplete.
4. Complete browser acceptance of the new `/staff-access` grant/denial UI and
   add privacy export, redaction and retention handling. The draft UI includes
   English, Japanese and Vietnamese copy, current-revision edits, explicit
   revocation, and reload-required handling after conflicts or uncertain saves.
   The browser client requests a fresh token per operation, never stores tokens
   or retries mutations, and bounds authentication plus response consumption.
   Shop erasure now drains staff grants and merchant action records under the
   finalizer's exact store lifecycle lock, at most 100 rows per table per step.
   A subsequent empty read is required before completion; financial records are
   untouched. Customer erasure does not equate customer IDs with staff IDs.
   Owner-only staff JSON export now has a paginated service and Shopify adapter;
   the staff page now offers bounded JSON-page downloads. Ordinary operational
   retention and live export acceptance remain open.
5. Retain the separate shared-schema merge confirmation before merging schema
   changes. The two additive tables have been staged only in isolated MySQL.

## Verification status and next tests

Contract tests pass locally (34 cases). Prisma formatting/client generation,
focused lint and changed-file formatting passed. Initial default-heap web
type-check exhausted memory; the 8 GB retry passed. The additive SQL is under
`infra/shopify-development/migrations/20260907_shopify_staff_authorization.sql`.
The guarded staging runner created only the two new tables in
`127.0.0.1:3307/weletic_loyalty_dev`, validated their Prisma diff, and repeated
with zero changes. Existing tables and merchant rows were not modified.
MySQL DDL is not atomic; a failure reports the number of completed CREATEs.

Fifteen actual MySQL tests now cover the signed grant/list gateways and nonce races,
rollback after business failure,
competing expected-revision grant replacements, revoke versus staff mutation,
expired actor after a lock wait, replaced online ciphertext, consistent reinstall,
cross-store grants, malformed grant JSON, terminal-revision revocation and exact
audit content. Competing transaction tests hold the first transaction and wait for
the second to invoke authorization before releasing it. They call production
services with real encrypted fixture sessions and transactions. Gateway tests
also exercise actual HMAC verification, private responses, tampered actor data,
forbidden actor flags, ignored unsigned actor headers, staff denial and replay.
List tests additionally cover stable pagination, cross-store cursor rejection,
older-generation/other-app exclusion, staff denial, revoked/invalid status
(including corrupt user/grant identity) and rollback on malformed cursors.
Pagination is keyset navigation rather than a frozen cross-page snapshot; a
new lower-sorting grant requires restarting the list to appear.
Generated fixture rows are cleaned up.

The 89 combined contract/client tests include actual SDK JWT validation with
synthetic provider HTTP, fresh actor minting, cached-session denial, changed
persistence, duplicate mint denial and closed-operation denial. These are not
live Shopify identity evidence. Browser-binding cases cover wrong issuer,
destination paths, unsafe subjects, wrong signature/audience, missing/future time
claims, expired JWTs, provider-user mismatch and raw non-boolean provider flags.
The action tests verify signed forwarding, a backend 403 with no fallback, and
a stalled response body reaching the bounded deadline with lease cleanup and no
automatic retry after a potentially committed mutation;
backend transport is intercepted there, while separate SQL tests use the real
backend route. Operation-specific effective scopes for future Shopify calls and
live owner/staff acceptance remain open.

Full verification, final adversarial review, shared schema approval and live owner,
granted-staff and denied-user acceptance on `yamaxdev` remain open. Neither
`yamaxdev` nor the competitor-reference store `n0pvef-cs` has been changed here.

The new browser client adds 14 passing local tests for fresh bearer requests,
cookie omission, sanitized errors, acknowledgement identity/revision matching,
invalid contracts, late authentication, and stalled response bodies. The 34
contract tests also pass with the new response schemas. Web type-check and
Shopify type-check/build pass after the UI addition. Read-only adversarial review
found no blocker in the client/UI; complete keyboard and live mobile acceptance
remain open.
Initial local browser inspection identified missing UTF-8 and viewport metadata
in the shared document shell; both are now explicit. Synthetic browser rendering
is not evidence of live owner/staff authorization.

Local synthetic browser checks confirmed grant editing, the revoke label after
clearing permissions, Japanese text rendering, and a simulated 409 disabling
further edits until reload. At a 390 px viewport, document width was also 390 px.
The conflict notice now receives focus (confirmed through the active element)
so it remains visible after a save near the bottom of the mobile form. Local
screenshots were visually inspected. App Bridge and merchant APIs were mocked;
no live grant or Shopify acceptance is claimed. Successful save, denial,
pagination, Vietnamese form rendering and complete keyboard journeys still
require browser coverage.

Staff erasure coverage includes actual MySQL batches exceeding 100 rows,
transaction rollback and another store's retained rows. Worker-level tests cover
active-store rejection, already-redacted retry and the nonterminal batch drain.
These invoke the production worker with mocked persistence; the separate MySQL
test invokes the production batch helper with actual Prisma transactions.

Rollout must drain old worker versions before enabling staff writes. An old
finalizer already executing does not gain the new cleanup checks. Do not enable
staff writes or resume mixed-version erasure workers merely because the additive
tables exist. No shared database or live erasure was run for this implementation.

The overview increment passes 17 actual MySQL tests (including owner/staff
overview, exact permission, replay, revocation, unsigned request and unexpected
input rejection) and 56 coordinated-client cases including the fresh online
overview adapter. The adapter shares the bounded request/error transport in
`merchant-action.server.ts` with staff list/replacement. These are local service
and SDK-fixture checks, not live Shopify acceptance or a completed homepage.
After moving the empty overview-input schema into the existing shared contract,
the combined client/contract suite passes 104 cases. Web and Shopify type-check,
Shopify build, focused web lint and diff whitespace checks pass for this
increment. No dependency was added.

Homepage cutover adds ten overview-client cases (strict projections, fresh
tokens, denied responses and no fallback), bringing that combined suite to 114.
Three additional tests call the actual homepage loader/action with mocked
installation authentication: no data serialization, redirect propagation and
retired catalog POST. The shared browser transport retains deadline coverage.
Read-only review identified the missing install bootstrap, which was restored
without merchant data access. A credential-free local browser stops at that
bootstrap; it does not prove authenticated rendering, install or reinstall.
Authenticated three-locale/mobile/denial browser acceptance remains open.

Shopify route tests live in their owning package and run with
`pnpm --filter @weletic/shopify-app test:unit`. Importing a Polaris route from
the web test tree mixed UI type environments; moving the route test restored
separate type-check boundaries without suppressions. Shopify now declares the
same Vitest 4.0.8 development dependency already used by web. The lockfile change
is limited to that importer and its peer-context snapshots; unrelated resolver
churn was removed. Both package type-checks, the Shopify build, three Shopify
route tests and focused web lint pass after this separation. Runtime
dependencies and CI pipelines are unchanged.

The Shopify package also exposes `test` as an alias for `test:unit`, so the
existing root `turbo run test` workflow discovers these route tests. A Turbo
dry-run confirms `@weletic/shopify-app#test` executes `pnpm test:unit`; the alias
itself passes all three route tests. No workflow file change is required.

## Staff export contract

`POST /api/merchant/staff-export` forwards a fresh actor and strict input to
`POST /api/internal/shopify/merchant/staff/export`. Input selects `grants` or
`actions`, a limit of 1–100 (default 50), and an optional opaque cursor. Each page
requires current verified owner authority (`staff.manage`) inside the export
transaction. Cursors are scoped to store, app, current installation generation
and export kind. Retained rows from earlier generations of that same store/app
are included and labeled by generation; they do not imply current permissions.

The first export receipt supplies a strict `createdBefore` boundary, excluding
itself and subsequent export receipts from the pagination. Rows sharing that
boundary millisecond are excluded. Grant edits can change between pages; the
response explicitly identifies this as a bounded observational export, not a
complete point-in-time database snapshot. JSON avoids spreadsheet formula
interpretation. Selected fields omit tokens, session data, request nonces and
arbitrary request bodies; malformed permission values become `null` rather than
unbounded raw JSON. Every response remains private/no-store.

The 18-case MySQL suite passes with retained-generation export, store/app
isolation, cursor kind/store rejection, staff denial, replay rejection, and a
multi-page audit export that terminates without including its own new receipts.
The combined client/contract suite passes 115 cases, including actual SDK fixture
authentication and signed export forwarding. No live export has run. Download
UX acceptance, operational retention, final full verification and live acceptance remain
required before declaring this feature complete.

The staff-access screen now prepares and downloads export pages, with three-locale
copy explaining pagination, historical grants, private handling and non-snapshot
consistency. Its strict response schema validates every field before Blob
creation; the client rejects kind, limit, boundary, installation or cursor
mismatches. Replacing a page or losing owner access revokes the old Blob URL.
Downloads are user-initiated, never automatic or uploaded to a provider.

Local evidence: 126 client/contract tests pass, including 11 new export-client
cases; Shopify route tests, both type-checks, Shopify build and focused lint pass.
A synthetic browser downloaded and inspected the expected JSON, rendered the
Vietnamese screen at 390 px with no horizontal overflow, then received a mocked
403 on the next page. The parent cleared access/export controls, focused its
denial notice, and the previously readable Blob became unreadable with zero
remaining download links. The initial Vite dependency-reload error disappeared
after a full reload. This is local UI evidence, not live Shopify identity proof.
