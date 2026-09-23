# Store-review completion slice

## Baseline — September 22, 2026

Implementation workspace: `codex/store-review-core`, based on public main
`956bd0a7b02ff2cb3bc3acf425eeb34f1e5d882e` after a preserving fast-forward.
This is the approved R07 workstream under ADR 0040, not accepted functionality.
PR #100's account product-review UI is merged and its post-merge CI passed
(`35519140929`); installed-account acceptance remains open.

Read-only inspection found no store-review model or writer. Existing disclosure
already promises one reward per order across product and store feedback, but
that promise alone does not implement store feedback. Do not create product
placeholder rows to simulate store reviews.

## Source-grounded integration map

- `prisma/schema/weletic-reviews.prisma`: `WeleticReviewIncentiveClaim` already
  has an order-wide unique key `(storeId, orderId)` and a `subjectType` field.
  Reuse that claim; never introduce a second store-review reward namespace.
- `reviews/incentive-claims.ts`: product reservation reads product requests,
  validates purchase/media and snapshots the policy before taking that slot.
  Store reservation needs equivalent trusted order/owner evidence, not a call
  with a fabricated product request.
- `reviews/incentive-points.ts`: explicitly rejects non-product claims and reads
  or updates product rows. Extend evidence loading and marker updates together;
  changing the discriminator alone would be incorrect.
- `reviews/incentive-evidence.ts`: the existing product content digest is a
  historical contract. Preserve its bytes. New store evidence needs an explicit
  subject/version binding rather than silently changing historical hashes.
- `reviews/content-privacy.ts` and `reviews/privacy.ts`: current content cleanup
  and source discovery enumerate product reviews. Store content, request
  identity, replies, audit text, media and translations must join export,
  redaction, discovery and uninstall paths before any writer is enabled.
- `reviews/privacy-owner-contract.ts`: reuse current owner projections and
  retained-key readiness; no separate identity authority or email-only lookup.

## Implementation sequence and contracts

1. Add separate store-review and invitation/provenance records with same-store
   ownership, revision fields and immutable order/policy identity. Open/imported
   content must not manufacture an invitation or purchase proof. Existing
   product rows and product participation hashes remain unchanged.
2. Complete source-aware read/privacy/reward consumers before writer rollout.
   Unknown subjects fail closed. Additive DDL must be reviewed and rehearsed in
   an isolated database; no shared or production schema application is included.
3. Add signed merchant settings and moderation, scoped shopper submission,
   request scheduling/delivery history and public store-summary/widget reads.
   Reuse the active-store and installation-generation fences. Reviews remain
   independent of Loyalty enrollment; store collection starts disabled.
4. Reserve the existing order-wide claim from trusted store participation.
   Implement both points and coupon fulfillment/recovery with immutable saved
   promises and rating-independent eligibility. Ordinary hiding, low ratings,
   refunds and privacy requests do not become invalidity decisions.
5. Complete EN/JA/VI merchant and shopper surfaces, moderation/replies,
   disclosure, aggregate counts and privacy-safe rendering. R08 video and R09
   extended translations remain coordinated dependencies, not simulated fields.

## Required evidence before declaring this slice complete

- Real isolated SQL: product/store simultaneous submission in both arrival
  orders, one claim and one points-or-coupon award; lost replies and killed
  workers recover without a second reward or altered promise.
- Same-store, generation, revision, expired invitation and owner checks;
  duplicate/open/imported requests cannot claim incentives. No reward from
  rendering, moderation status or positive-rating thresholds.
- Merchant edit/reply/moderation concurrency, immutable original source,
  aggregate matching, hostile content and cursor tenancy.
- Erasure/export racing with submission, claims, replies and publication;
  independent SQL/object reconciliation and exact fixture cleanup.
- Actual EN/JA/VI components at 375px with keyboard/error/loading/permission
  states; then named authenticated `yamaxdev` request → delivery → submission →
  moderation → display → optional incentive evidence under a scoped live bundle.
- Full relevant checks, adversarial review, CI, reviewed schema rollout and
  module-specific release gate. Unit tests and green CI alone do not close R07.

## Current disposition

Added a draft `store-purchase.ts` guard for persisted store-review order
evidence. It checks exact order/shopper/store/generation bindings, rejects linked
privacy tombstones, duplicate/foreign lines and invalid purchased quantities,
and separates initial refund qualification from retained purchase identity.
All 28 purchase tests pass, including multi-line partial/full refunds, corrupt
refund quantities/amounts and forged bindings. Independent review found no
blocker in the standalone guard; it required authenticated-store binding,
relation-backed line loading and independent privacy checks at integration.
The submission entry point now checks the authenticated store and awaits the
existing independent identity-tombstone query on the caller transaction. Its
three additional tests cover foreign store authority, unlinked tombstones and
privacy-query failure. The existing product helper's input type was narrowed
to fields it already reads; its runtime suppression behavior is unchanged.
Independent follow-up review found no blocker. Writer integration remains open.

Added five draft Prisma models and matching additive SQL for store settings,
invitations, purchased-line snapshots, content and moderation audits. Prisma
validation passes. Three offline schema tests pass, including exact comparison
with Prisma-generated DDL, disabled defaults and order/version uniqueness.
Together with purchase tests, **31 tests pass**. The initial DDL test incorrectly
resolved Prisma's package main; using its declared CLI entry corrected the test.
Web typechecking with the CI-equivalent 8 GiB heap and focused ESLint both pass
on this draft; formatting and `git diff --check` pass. Prisma validation reports
relation-mode index warnings elsewhere in the combined schema; it is not SQL
performance or migration-rehearsal evidence. The generated shared client was
not updated, and no application code uses the new models yet.

Independent schema review found no blocker for the disabled invitation-backed
draft. Open/imported provenance records, transaction-backed ownership and all
privacy consumers must ship before activation. Nullable imported-review shoppers
avoid fabricated Shopify identities; that does not make imported content ready.
Relations use `relationMode=prisma`, so SQL foreign keys do not enforce ownership.
Service fences and independent SQL acceptance remain mandatory.

No database schema was applied, no writer or setting enabled, and no invitation,
send, incentive or deployment created. No external resources were provisioned.
Dependencies reuse the existing local tree; no dependency versions were changed.
Drafts remain unpublished.

## September 22 — store-review source privacy foundation

Added typed content, invitation and moderation-audit erasure predicates/patches,
plus transaction-scoped source redaction and frozen-store purge helpers. Explicit
customer versus frozen-store scope prevents missing customer IDs from widening
the operation. Padded and oversized identities fail before querying. Erasure
repairs residual text, token hashes, encrypted delivery snapshots, leases and
moderation notes even if a prior attempt already marked the row redacted.
Financial markers, original source links and shared order-wide incentive claims
are not modified or reversed.

Batches lock the exact store and process at most 20 rows per source. Content
updates include the observed version and fail on update loss. Frozen-store purge
requires clean source records and drains audits, content, invitation lines and
invitations before settings. Residue checks use bounded existence reads rather
than full counts. These are source-table helpers, not a completed compliance
workflow: provider/projection cleanup, export, owner discovery, orchestration and
real SQL privacy/concurrency evidence remain required before enabling writers.

The worktree's web dependency symlink was replaced with a shallow dependency-link
directory and a private copy of the Prisma client package. Prisma 6.19.1 generated
the draft client locally with an unused loopback database URL; no database
connection or schema application occurred and the shared client was not changed.
The new builders are checked against the actual generated Prisma input types.

All **66 focused tests pass**: 28 purchase guards, 3 offline DDL checks, 16 privacy
contract tests and 19 mocked database-batch tests. Web typechecking and focused
ESLint pass.
Independent review found no standalone blocker; its scope-hardening and bounded
existence-read suggestions were applied. Mocks do not prove rollback, lock
behavior or SQL erasure. No invitation, email, live order, deployment or store
setting was changed. R07 remains an unpublished, disabled draft.

## September 22 — compliance integration and export recovery

Connected store-review source redaction and child-first purge to the existing
native-review privacy transaction. Store-review residues keep completion open;
missing tables and failed mutations propagate instead of silently certifying
erasure. Empty customer identifiers are not interpreted as whole-store scope.

Added private `export_store_reviews` and `export_store_review_requests` phases
after the existing import-export phases. Scalar projections omit bearer hashes,
encrypted delivery envelopes, leases, staff identities and content digests.
Shared incentive promises remain in the existing order-wide claim export.

Independent review identified an unsafe first draft: immutable artifact reuse
could be paired with a cursor derived from refetched, changed rows after a lost
checkpoint. Replaced it with encrypted winning-artifact recovery, bounded 20-row
pages and keyset continuation. Tests cover lost publication acknowledgement,
deleted/inserted boundary rows, competing publication, mismatched owner/phase/
sequence, unresolved publication and duplicate/non-advancing checkpoint rows.
Sequence numbers are bounded by the database signed Int. Independent follow-up
review found the recovery blocker resolved; real SQL evidence is still needed.

The first full web-suite attempt stopped at an older financial-privacy fixture
that lacked new table delegates (1 failed, 1,169 passed). Added explicit empty
store-review delegates to that fixture; did not weaken production error handling.
Five focused suites then passed 203 tests, including artifact lease/integrity,
worker routing, source orchestration, recovery and that legacy fixture. Two
additional duplicate/non-advancing checkpoint tests were added afterward.
A fresh complete web-suite run was started against the updated draft; its result
is pending, not accepted. No SQL instance was started or schema applied.

Release dependencies: rehearse and apply all five additive tables before these
unconditional privacy readers are deployed, even with collection disabled.
Rollback must retain a compatible worker for requests already saved in the new
phase names; an older worker cannot resume them. Store-review writer activation
still waits for owner discovery, projection/provider integration, isolated SQL
acceptance and the complete merchant/shopper journey. This draft is not merged.

## September 22 — approved completion plan: privacy and read integration

Hiro approved the completion plan with the active store-review slice first, then
Loyalty acceptance. Public main remains PR #100 at
`956bd0a7b02ff2cb3bc3acf425eeb34f1e5d882e`; unfinished import, reminder and
storefront-loading worktrees are preserved.

Independent review found store-only owners missing from projection maintenance
and reconciliation, and store sources missing from the direct customer export.
Shared discovery now includes product/store content and invitations. Independent
source reconciliation counts orphan content and invitations separately, including
missing/cross-store owners; its private CLI fails on either count. It does not
certify a multi-page concurrent scan as one atomic snapshot.

Both direct and durable exports include store content, invitations and moderation
history. Projections exclude staff identities, bearer hashes, delivery envelopes
and lease material. The additional `export_store_review_audits` phase uses the
same encrypted winning-artifact recovery and bounded keyset pagination. Worker
rollback compatibility now applies to all three new export phases.

Added an internal public store-review reader with no route or writer activation.
Rows, distribution, totals and pagination use the same retained-key privacy
predicate in one repeatable-read transaction. Both review module and store-review
settings must be enabled. Unknown owner coverage rejects the read; authoritative
erasure suppresses content and totals together. Newest pagination binds store,
installation and rating; public objects exclude owner/request/digest fields and
open/imported feedback cannot acquire verified/incentive labels. Store summaries
are live SQL projections, not externally cached aggregates.

The exact five-table migration was rehearsed in a newly created disposable MySQL
database. Four production-service SQL cases pass: store-only projection/backfill
and unlinked email tombstones; orphan invitations; tied-timestamp pagination and
rating filters; and transaction rollback after a real duplicate-key failure,
followed by 20-row bounded erasure, retry and active-store purge denial. Each run
removed its exact database/account and independently confirmed the retained dev
ledger remained 16 entries. No retained/shared schema was changed. These tests
do not prove writer-vs-erasure races or a live merchant journey.

The export/owner/compliance focused selection passes 133 tests. Public privacy
and reader suites pass 15 tests. The full-suite attempt stopped after 2,940
passing tests because the artifact mock omitted the new audit kind; the mock was
corrected without weakening production checks. A fresh full run is pending.
Typechecks/builds and CI must be recorded at the final source revision.

Next: complete request scheduling/submission, shared points/coupon fulfillment
and invalidation consumers, merchant/UI and signed gateways. No invitation,
incentive, provider delivery, route exposure or live activation is authorized
by these local read/privacy checks alone.

## September 22 — shared financial consumers and authenticated internal services

Extended the existing order-wide claim through store points fulfillment,
unenrolled-account recovery, coupon provisioning, explicit invalidation,
append-only points reversal and provider cleanup completion. Product participation
hashes and product invalidation snapshot bytes remain unchanged. Store content
uses a distinct digest domain and invalidation revision. Text-only store reviews
cannot claim photo/video bonuses. Unknown subjects remain ineligible.

Adversarial review found a MySQL JSON-ordering defect in the first coupon evidence
comparison. Both saved and selected awards now pass through the same schema
normalization before comparison. The SQL coupon test reloads the persisted claim,
rejects edited content before credentials/I/O, simulates a lost create response,
and adopts the original remote coupon without a second create. Provider calls
are mocked; this is not actual Shopify issuance evidence.

Added internal authenticated submission and audited moderation services. The
future signed gateway must derive shopper identity from the verified customer
session. Submission atomically consumes an owned sent invitation, writes its
privacy projection/content and reserves the shared incentive. Exact retries are
accepted after expiry without accepting changed content; foreign shoppers and
stale installations fail. Display moderation uses optimistic versions and an
atomic audit, without invalidating awards for criticism, hiding or replies.
No HTTP route, settings UI, collector, reminder or live send is activated here.

Verification at this checkpoint:

- All 170 tests in the isolated shopper SQL suite passed, including existing
  product/coupon/privacy/recovery regressions and new store competition,
  exact-BIGINT reversal, identity suppression, EN/JA/VI submission/replay,
  transaction rollback and audit-constraint rollback cases.
- A subsequently added concurrent store submission/erasure SQL test passed:
  no content survives erasure and earned points are not fraud-reversed.
- Expanded native review privacy SQL selection: 19 passed, 77 unrelated skipped.
  Includes store-only discovery, orphan invitation detection, tied-timestamp
  public pagination, bounded erasure rollback, existing privacy source
  reconciliation and multi-tenant query-plan/load checks.
- Recovery/coupon contract selection: 67 passed in five suites.
- Root lint passed all ten tasks. Final full-suite, typecheck and build results
  must be recorded below before a PR can be described as verified.

Every SQL run used a newly generated database and matching restricted principal,
rehearsed the exact checked-in five-table DDL, and independently verified removal
of that exact database/principal. The retained development ledger remained 16.
Early test fixture errors (required fields, duplicate synthetic token hashes and
an incorrect ledger ordering field) were fixed without weakening assertions.

The collection draft in `codex/review-collection-reminders` remains preserved.
Its September 20 worklog explicitly leaves shared versus per-module quiet-hours
and frequency limits unresolved. That architectural choice was surfaced to Hiro;
no default was silently activated. Store collection also still needs a
prospective activation boundary, owner-authorized settings, immutable delivery
snapshots, provider recovery/cleanup, and integration with those reminder rules.

Milestone 1 is not complete: signed gateways, merchant/shopper/storefront UI,
collection/reminder integration, CI and authenticated yamaxdev acceptance remain.
Milestones 2–4 are not certified by this implementation. No shared migration,
provider send, production activation, spending or publication occurred.

## September 22 — broad local gate results

The complete web unit suite passed **9,984 tests in 616 files**, with six existing
skips (9,990 total). This successful rerun supersedes the earlier interrupted
full-suite attempt, which stalled and was terminated; it was never counted as a
pass. The isolated open-review-form diagnostic also passed all 18 tests.

Web `tsc --noEmit` exited zero with the normal 8 GB heap. Changed TypeScript and
Markdown files passed Prettier; Prisma schema validation passed with existing
relation-mode index warnings. Root lint passed with zero lint warnings.
The normal production web build subsequently passed end to end, including its
lint/type validation and static generation. It used a fresh restricted disposable
SQL database and loopback-only provider placeholders, with no guard bypasses.
The exact fixture database/account were removed and the retained ledger remained 16. These host build artifacts are verification output, not deployment artifacts.

Independent final review found no additional blocker. Five-table schema ordering
and compatible compliance-worker rollout/recovery remain mandatory. The scoped
foundation is ready for draft PR/CI; it does not complete the store-review slice.

## September 22 — delivery policy approved

Hiro selected the shared per-store Loyalty + Reviews delivery policy (Option A).
[ADR 0042](../adr/0042-shared-shopper-delivery-policy.md) records this approval and
supersedes the unresolved decision noted above. Implementation and verification
continue; no migration or send is authorized by this architectural choice alone.

## September 23 — shared delivery scheduling foundation

Implemented the internal versioned shared-policy contract and scheduling
evaluator, with strict timezone validation, DST-safe quiet hours, combined rolling
capacity calculations and original expiry containment. The evaluator is not wired
to settings or senders and does not reserve capacity. No policy became active.

Scheduling plus existing merchant-settings contract tests passed 74 cases in two
files. Independent review identified date overflow near JavaScript's maximum
timestamp; a finite-date guard and regression test now cover it. Web typecheck,
targeted lint and formatting passed. The [integration checklist](shared-shopper-delivery-policy.md) records
producer boundaries and the remaining identity decision for anonymous referral
confirmations. ADR 0042 remains accepted; anonymous identity semantics are a
separate newly discovered choice, not a reopening of shared versus module policy.

## September 23 — shared anonymous and authenticated delivery budget

Hiro approved [ADR 0043](../adr/0043-shared-email-delivery-budget.md): anonymous
confirmations share the store/email rolling budget with later authenticated
messages while retaining independent customer limits. There is no outstanding
identity decision for this behavior.

The draft now includes two HMAC reservation/identity tables, additive settings JSON
and an appended anonymous-confirmation outbox type. Existing Loyalty, expiry,
anonymous confirmation and product-review producers reserve under the store lock
and preserve original source/provider evidence. Deferred anonymous confirmations
have a source-only queue job and encrypted immutable bytes; only proven-unsent,
explicitly queued preparation can wait beyond a provider retry window. Uncertain
attempts never receive a new deadline. Paused jobs do not starve financial work.

Privacy includes owned projections, checkpointed encrypted exports, bounded
customer/store erasure and key-retirement audit. Sharing a mailbox shares capacity,
not another identified customer's exported history. ID-only requests retain the
resolved shopper mailbox before pseudonymization. Old exports without delivery
identities require draining or explicit reconciliation before writer rollout.

Independent review and SQL testing found and fixed: shared-mailbox erasure losing
another customer's capacity; anonymous retries gaining a new customer identity;
RepeatableRead identity subqueries missing a concurrent winner; paused anonymous
jobs occupying the bounded poll; ID-only privacy requests missing anonymous email
history; and stale admission clocks across quiet-hours/expiry boundaries. Review
invitations also check their expiry in the final transport authorization query.

Local evidence (mocked providers; no customer sends):

- Full web unit suite: **10,044 passed**, six existing skips, 618 files. The first
  broad run lacked the synthetic Shopify app ID and exposed outdated producer
  mocks; corrected fixtures and the configured rerun passed without weaker
  assertions or runtime guard bypasses.
- Complete shopper SQL suite: **187 passed**, including all **16 shared admission**
  cases and three lock-wait clock boundaries.
- Anonymous confirmation SQL: **21 passed**, including 25-hour never-attempted
  recovery and the later authenticated mailbox budget.
- Communication retention SQL: **59 passed**; separate SQL regressions pass for
  paused-backlog fairness and exact-claim deferral without attempt consumption.
- Expiry retention SQL: **five passed**, including delayed-render quiet hours.
- Native review delivery/privacy SQL selection: **29 passed**, 67 unrelated cases
  not selected. This is a focused run, not the entire native review suite.
- Web typecheck and root lint passed. Each SQL harness removed its disposable
  database/principal and verified retained ledger count 16 unchanged. Exact new
  delivery DDL, including prior-to-new enum ordering, was rehearsed in the shared
  delivery/producer harnesses.

The normal production web build passed with disposable SQL and loopback provider
placeholders; cleanup again left the retained ledger unchanged. The final small
maintenance-deferral propagation fix subsequently passed its 37-case anonymous
unit suite and web typecheck. A final retention correction removes queued encrypted
payloads when privacy ownership is removed or expired, including coupons without
an expiry. Both new SQL regressions passed, as did 45 focused retention/anonymous
unit tests, targeted lint and web typecheck; adversarial review found no blocker.
Updated-head CI remains pending until push.
Merchant settings controls, retained collection/reminder reconciliation, store
review gateways/UI and installed yamaxdev acceptance remain open. PR #101 remains
**draft, unmerged and undeployed**. No shared schema application, live sends/orders,
spending, publication or module activation occurred.

## September 23 — merchant delivery-policy controls

The approved shared policy now has revision-fenced merchant settings and signed
EN/JA/VI controls. The existing `settings.configure` grant governs Shopify staff;
appearance-only operations cannot expose or change delivery policy. Workspace
writes retain owner authorization. No new schema is introduced by this increment.

A configured policy requires an explicit IANA timezone. Effective-state validation
prevents clearing a timezone while retaining a policy, including concurrent edits.
The UI supports optional overnight quiet hours and a 1–100 rolling cap without
invented defaults; clearing the policy preserves the separate email pause.
Settings edits retain existing delivery capacity and do not create historical
invitations, activate modules or extend immutable message deadlines.

Self-review and independent adversarial review resolved malformed-policy repair:
strict browser projections still reject corrupt stored JSON, while an authorized,
revision-fenced API replacement/clear can repair it and pause email atomically.
An operator must establish the current revision when the screen cannot load.
The signed route maps invalid effective settings to HTTP 400 and rolls back the
authorization receipt. Browser acknowledgments compare validated JSON values,
not object references; failed/uncertain saves require explicit reload.

Verification with synthetic configuration and no provider sends:

- Full web unit suite: **10,054 passed**, six existing skips, 618 files. The final
  validation/error-mapping focus passed **109 tests in five files**. The controls
  and browser-client selection passed **41 tests**, including all three locales.
- Real MySQL merchant settings: **23 passed**. Includes concurrent timezone-clear
  versus policy activation, caller rollback, SQL NULL clearing, retained capacity,
  malformed-policy repair and ownership/installation fences.
- Signed staff/settings MySQL selection: **five passed**, 56 unrelated cases not
  selected. Covers grants, failed-write receipt rollback, replay, revocation,
  appearance isolation and competing revisions. The initial new test exposed a
  missing HTTP validation mapping; the corrected rerun passed.
- Both SQL harnesses rehearsed exact store-review/shared-delivery migrations in
  fresh restricted databases. Exact cleanup passed; retained ledger count stayed 16. This is a containment count guard, not financial reconciliation evidence.
- Root lint, web and Shopify typechecks, Shopify production build and diff checks
  passed. Independent reviewer found no remaining blocker in this increment.
- Chromium on loopback used the real editor and Shopify CSS with a synthetic
  transport. EN/JA/VI at 375px had no horizontal overflow; keyboard save and the
  uncertain-save/reload path passed. Screenshots are local under
  `output/playwright/delivery-controls-*.png`. Only a missing fixture favicon was
  reported; this does not establish installed Shopify authentication.

The normal full web production build passed with disposable SQL and loopback
provider placeholders; exact database/account cleanup left retained ledger count
16 unchanged. Updated-head CI is tracked in PR #101 after push.
PR #101 remains draft. Next: reconcile the retained prospective collection and
reminder implementation with current privacy, recovery and shared admission;
then complete store-review gateways/UI and the named installed acceptance packet.
No shared migration, live settings, sends/orders, spending, deployment or module
activation occurred.

## September 23: retained collection/reminder reconciliation

Integrated the retained collection/reminder draft without modifying its source
worktree. Signed collection settings and EN/JA/VI delivery history now accompany
prospective reminder scheduling, immutable provider retries and cancellation.
Reminders share the approved email/customer delivery budget. Source evidence and
budget admission commit atomically; known terminal failures settle source state
and erase the last parent invitation token. Re-enabling collection advances the
invitation cutoff, excluding delayed pre-enable fulfillment events.

Customer exports include private reminder history with durable page recovery.
Whole-store erasure drains orphaned reminders independently of parent pointers.
The additive collection migration is a reader prerequisite; retain compatible
workers for the appended `export_review_reminders` phase and drain old exports
before writer activation.

Evidence: full web units 10,261 passed / six skipped / 632 files; full native
Reviews SQL 107 passed plus two additional focused SQL regressions for shared
anonymous/authenticated capacity and collection activation cutoff. Exact migration
rehearsal and disposable cleanup passed with retained ledger count 16 unchanged.
EN/JA/VI 375px local browser controls, keyboard save and failed-save/reload passed.
See `review-collection-reminders-worklog.md` for recovery and privacy details.

PR #101 remains draft. Collection/reminder implementation is now reconciled;
remaining M1 work is signed store-review gateways, merchant/shopper/storefront
surfaces and the installed yamaxdev invitation/acceptance journey. The separate
collection acceptance packet is updated for the approved shared budget and remains
unexecuted. No shared migration, real provider sends/orders, spending, deployment,
publication or module activation occurred.

## September 23: signed merchant store-review inbox

The merchant Reviews page now has a separate EN/JA/VI store-review inbox. Its
signed list gateway derives store, app and installation authority from the
authenticated Shopify staff actor, requires `reviews.read`, and returns only
bounded moderation fields. Pagination cursors bind store, app, installation and
filters. The SQL list uses the complete owner-privacy readiness and tombstone
predicate shared with public store-review reads; uncertain coverage fails closed.
Signed moderation requires `reviews.moderate` and uses the existing audited,
version-checked store-review mutation. The editor clears old data when its
authenticated client changes, rejects mismatched write acknowledgments and
requires explicit reload after an uncertain result. Disabled store-review
settings still prevent moderation.

The authenticated Shopify App Proxy now forwards a public `store-list` GET
through the signed core gateway. The core resolves the verified shop to its
store ID and admits only rating, limit and cursor into the existing privacy
checked live summary reader; caller-supplied store/product IDs are ignored.
The gateway regression passed alongside 28 existing native gateway cases.
Authenticated customer-account sessions can now submit an owned store-review
invitation through a separate signed `store-submit` route. The Shopify SDK
supplies shop and numeric customer ID; the core resolves only that store's
numeric/GID shopper mapping, rejects ambiguous mappings and body identity
fields, rate-limits by a hashed store/customer key, and passes the current
installation generation into the existing transactional writer. The App Proxy
cannot call this account-only action. Focused routing tests covered forged
query/body identity, ambiguous mappings and duplicate signed context keys.

Focused service, browser-client and panel regressions passed (five cases),
including authority denial, privacy uncertainty, scoped cursors, acknowledgment
version/status and old-client response races. Web and Shopify typechecks passed.
This local UI test does not establish installed Shopify acceptance. Storefront
rendering now has a separate theme section block using the signed `store-list`
route, with EN/JA/VI text and no cached review state across failed page reads.
Four local jsdom cases passed, including safe text rendering and clearing
previously visible content after a later privacy/unavailability failure.
Shopify CLI configuration validation passed for both the default and
`loyalty-public` app configurations. The new theme JavaScript is 7,259 bytes
and Theme Check raised no finding for it. A full `shopify app build` remains
blocked by the existing product-review JavaScript at 11,344 bytes versus the
10,000-byte threshold and by the free-product function's unavailable
`graphql-code-generator` executable. The CLI inserted four unrelated Flow UIDs
locally; these generated changes were reverted before staging.
Account submission UI and invitation discovery, prospective invitation
writer/settings and live merchant/shopper journey remain open; PR #101 stays draft.

## September 23: prospective store-review controls

The still-unapplied five-table draft now includes nullable
`WeleticStoreReviewSettings.activatedAt`; its exact Prisma-generated DDL matches
the draft SQL. Signed merchant settings require `reviews.configure`, current
store/installation authority and revision compare-and-swap. Both the store
module and invitation email start disabled. Enabling email records the cutoff;
ordinary edits preserve it, while disabling and re-enabling advances it. The
future invitation collector must require fulfillment at or after this cutoff
and the parent Reviews activation cutoff. An EN/JA/VI editor requires explicit
confirmation, validates bounded delays, rejects mismatched acknowledgments,
clears stale authenticated-client data, and forces reload after an uncertain
save. Parent Reviews must be active to enable store reviews, while the merchant
can always turn an already-enabled store policy off.

The schema test and focused settings tests passed. The exact five-table and
collection/reminder SQL migrations were rehearsed again in a disposable MySQL
database, with four selected store-review privacy cases passing. Exact fixture
database and principal cleanup left the retained ledger count at 16. No shared
schema or live settings were changed. Invitation production/delivery and
installed activation are still missing, so PR #101 remains draft.
