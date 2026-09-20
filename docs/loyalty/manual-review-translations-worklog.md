# Manual review translations — R09 implementation

Base public main `a6965d65079cd57fc15f558d977bace14790f4c0`.
Approved scope: manual EN/JA/VI translations linked to original content;
no AI translation, incentives or external syndication. This is an uncommitted
implementation draft, not a completed feature or an enabled API.

## Vertical-slice plan

1. Shared strict merchant contract: save/remove with explicit locale, expected
   installation generation, current review version and independent translation
   revision. Store/staff authority comes from the existing signed gateway.
2. Add a separate product-review translation model with tenant-scoped original
   relation, locale uniqueness, revision, source review version/content digest,
   original locale when known, text, removal/redaction state and audited action
   linkage. Do not repurpose historical product-review records. Preserve removal
   revision tombstones to prevent stale save/remove requests from becoming new.
3. Signed merchant read/write gateway and EN/JA/VI editor: reuse moderation
   permission, authoritative lifecycle locks, expected revisions and current
   installation. A translation is never authority to publish its source, change
   rating/verified-purchase status, enroll a shopper or issue an incentive.
4. Under the original review's publication/privacy/ownership checks, project only
   a current active translation for the requested locale. Fall back to original
   content otherwise; label manual translations and allow original display.
   Treat all text as plain text, not HTML. No source digest/actor/internal IDs in
   public projection. Hidden/deleted/redacted originals expose no translation.
5. On source-text edit, mark existing translations stale under the same lock.
   Never rewrite translations automatically. Source digest distinguishes exact
   title/body and store/review ownership; keep original version as audit evidence.
   Current review version also advances for moderation/replies, so that version
   alone is not content freshness. Unknown source language stays null, not guessed
   from the invitation or current shopper UI locale.
6. Integrate shopper/shop privacy export/erasure, staff-actor retention and
   store purge. Do not retain original-text copies in audit fields. Regenerate
   projections when translations change; ensure delayed jobs cannot republish
   erased content. Reviews for stores/open submissions and Q&A still require
   their own compatible models; product-only work cannot close all of R09.
7. Rehearse additive schema before readers/writers on an isolated database.
   Test concurrent edits/removal, source edits, stale generation, foreign review,
   privacy races, HTML injection, locale fallback, UI at 375px/keyboard and exact
   SQL/projection reconciliation. Then full checks, independent review and CI.
   Named installed-theme/admin acceptance remains separately gated.

## Contract checkpoint

Added strict save/remove contracts and a server-side source digest. The shared
contract has no Node crypto import, so merchant UI can reuse it safely. The
server computes the digest from locked original content; caller-provided digest,
actor, store, rating, publication and incentive properties are rejected.
Translated text can be shorter than the original submission minimum; it remains
nonempty and bounded. The original is not overwritten.

32 pure tests pass for locales, unknown source language, integer revision bounds,
field limits, forbidden authority and ownership/content digest separation.
These tests do not establish signed authorization, persistence, privacy cleanup,
shopper projection, installed UI or live acceptance. No schema was applied, no
writer/route enabled and no external translation service contacted.

## Persistence and projection draft

Added separate translation/audit models and matching draft DDL. A tenant-scoped
review/locale unique key retains removal revision identity. Audit revisions are
unique per translation and action receipts unique per merchant action. Audit
rows contain no original/translated text or source digest. Staff actor IDs are
nullable for privacy cleanup. Translation content and source digest are nullable
for erasure; restrict relations require explicit bounded cleanup before the
final original-review purge. Runtime ownership checks remain mandatory under
Prisma relation mode, which does not create SQL foreign keys.

The server-side projection falls back to original text for absent, stale,
removed, redacted, foreign, malformed or wrong-locale translations. A hidden or
redacted original returns no content. Only title/body and a translated flag are
returned: no source hash, IDs or actor data. The caller still must establish
current store/module/shopper privacy authority; this helper cannot do that.

62 focused tests pass and Prisma schema validation passes. Migration application,
schema-vs-DDL rehearsal, generated-client types, real SQL races, signed gateways,
merchant UI, privacy export/erasure, worker projection and live acceptance remain
open. No generated Prisma client or database was modified for this draft.

Independent review found no concrete contract/projection/relation defect and
confirmed mandatory wiring gates: redaction must discover leftover translated
text/digests even when the parent is already redacted; final shop purge must drain
audits → translations → reviews; staff erasure scrubs audit actors; source edits
must mark translations stale atomically so changing original text back cannot
revive them. The original-view toggle requires the same privacy checks as the
translation, locale-aware cache keys and escaped text rendering. Scoped typecheck,
lint, formatting and diff checks pass; these do not establish runtime wiring.

## Privacy integration checkpoint

Translation content erasure now runs inside the existing review privacy store
transaction. Its separate selector follows exact store/shopper ownership without
requiring the original review to remain unredacted. It finds leftover title,
body, source digest or source locale even if an earlier attempt already changed
the original's status. The final pending query includes that selector, so privacy
cannot finish while translation content remains. Revision identity and the
content-free audit rows remain; customer erasure does not delete staff authority.

Frozen-shop final purge drains bounded audit pages, then translation pages,
before original review deletion. The existing frozen/redacted-store check runs
before these deletions. Frozen-shop staff cleanup separately nulls translation
audit actor IDs and sets its erasure marker while retaining revision/action IDs.
Errors propagate rather than converting unavailable storage to empty success.

161 focused translation, moderation-privacy, compliance-worker and loyalty-privacy
tests pass with mocked persistence/providers. Prisma client was regenerated from
this draft locally; this updates the shared generated client used by sibling
worktrees, which must regenerate their own schema before verification. No database
was started, connected or migrated. Scoped generated-client helper typechecking,
lint and diff checks are separate from the still-required full web build/types.

**Rollout gate:** apply the additive translation tables and generate the matching
client before deploying these privacy readers, even if editing remains disabled.
Real SQL tenant isolation, transactional rollback, source-edit/privacy races and
schema-vs-DDL rehearsal remain unproven. Shopper data export, signed merchant
write/read, editor and actual storefront integration remain open. No translation
route or writer has been enabled by this checkpoint.

## Private shopper export checkpoint

Both existing shopper export paths now select translations beneath the owned
original review. The nested relation repeats the store predicate, selects only
supported EN/JA/VI locales in deterministic order, and is bounded to three rows
by the existing unique review/locale constraint. Retained removed/stale/redacted
states are not hidden from the private data export. Content, locale, revision,
source review version and timestamps are included; staff identifiers, source
hashes, internal translation IDs and action/audit receipts are not.

163 tests across seven translation/privacy/compliance files pass with mocked
persistence/providers, including selection assertions in both export paths.
Independent review found no concrete defect. Scoped helper/test typechecking,
focused lint and diff checks are required alongside the still-open full build.
Real SQL export must still prove all three locales, retained removed/redacted
rows and foreign-store isolation; these unit tests do not prove SQL enforcement.
The schema-before-reader rollout gate also applies to these export readers.
No database, external send, public API, merchant editor or live store was enabled.

## Merchant write draft

Added an internal merchant gateway reusing `reviews.moderate` authorization and
the existing serializable store mutation transaction. Staff action receipt,
translation write and content-free translation audit share that transaction.
The helper locks the tenant-scoped original, checks generation and source version,
then checks the independent translation revision. Removal clears translated text
and source digest while preserving a revision tombstone, including when the locale
was previously absent. Redacted originals/translations cannot be resurrected.
No rating, original text, publication, purchase verification or incentive is changed.

Independent review caught a linked-only privacy check that missed customer-ID or
email tombstones without a shopper link. The writer now selects owned shopper
identity and calls the existing identity-aware tombstone helper on the same
transaction before any translation access. The regression tests currently mock
that helper; actual unlinked customer-ID/email fixtures and concurrent insertion
still require real SQL proof. Do not treat the mocked tests as that proof.

18 focused helper/gateway tests pass, including authorization rejection, stale
generation/source/translation versions, privacy rejection, removal tombstones,
CAS failure and audit-error propagation. Audit rollback itself remains a real SQL
gate. The gateway is internal only and does not itself authenticate HTTP: a future
route must verify the full envelope/input HMAC. No route, read editor or storefront
integration is enabled yet. Full web TypeScript checking passes on the updated
draft, as do 181 tests across nine translation/privacy/compliance files. Focused
lint, formatting and diff checks pass. Full build, SQL and browser/live acceptance
remain open; these checks do not close the feature gate.

Reviewer follow-up confirmed the identity-helper wiring fix. `SERIALIZABLE`
is an explicit writer prerequisite, not an optional optimization. Before enabling,
use two actual SQL connections to prove tombstone-first blocking/rejection and
writer-first commit followed by privacy erasure, for both unlinked identity types.
Also prove deadlock retries leave no partial content/audit/merchant receipt. Do not
acquire a customer Redis lock after taking the store SQL lock: that would reverse
the established privacy lock order.

## Merchant read draft

Added a strict review-ID read contract and private response shape, plus an
internal `reviews.read` gateway under the current store/staff transaction fence.
It verifies owned product/shopper relations and both linked and identity-only
privacy suppression before returning original text and at most three locale
rows. Response data includes current installation/source/translation revisions
needed for fenced edits, but excludes shopper identity, source hashes, staff
actors and action receipts. Hidden originals are available to authorized merchant
editors; this is not a public projection.

Changed source digest or invalid source version marks otherwise active text stale.
Removal/redaction returns null content even if residual text remains in storage.
Independent review found one consistency defect: malformed active content could
look usable to the editor when the public projection would reject it. The reader
now fails closed for null/blank active title/body or identical source/target
locales; regression coverage was added. Unknown persisted states are rejected.

Before that review correction, 196 tests across ten files and full web TypeScript
checking passed. After the correction, full web TypeScript checking, focused lint
and all 24 read/gateway tests pass.
No HTTP routes, merchant editor, storefront translation integration, database
changes or live acceptance were enabled. SQL privacy/concurrency/export rehearsal
remains required; mock-based selection tests cannot prove those gates.

## Merchant form and transport draft

Added the Polaris manual translation form and EN/JA/VI copy. Original content is
rendered as escaped plain text, and revision/generation identity stays in JS rather
than hidden DOM fields. A synchronous submission latch blocks duplicate requests
and remains closed after success or uncertainty until a fresh authorized read
changes the snapshot key. Source/review changes remount the form; UI-language
changes alone do not. Redacted translations and exhausted integer revisions are
not editable. Save/remove use the shared strict input contract.

Independent UI review found that changing target locale discarded unsaved text.
Per-locale in-memory drafts now preserve it, with an actual input → locale switch
→ return → submit regression. The future panel must not replace dirty snapshots
in the background; it must clear private content on authentication/permission
loss and invalidate in-flight reads when the authenticated client changes.
Reviewer follow-up confirmed the locale-switch fix and found no transport defect.
Before panel integration, a reload after saving one locale must preserve other
unsaved locale drafts safely or obtain explicit discard confirmation; a fresh-read
remount alone is not permission to silently drop those drafts.

Prepared a transport using the existing fresh-token JSON POST helper and no
automatic retries. Success must match requested review, locale, next revision
and save/remove outcome. Read results must match the requested review. No HTTP
route or panel integration is enabled by this work.

Shopify package typechecking, focused lint and all 23 form/transport tests pass.
Form tests use actual Polaris
controls in jsdom with a matchMedia stub; they do not prove 375px layout, keyboard
browser acceptance, live authentication or real persistence. The first test
placement in the web package failed because Polaris belongs to the Shopify
package; tests were moved to the owning package without changing dependencies.
SQL rehearsal, complete controller/routes, storefront integration, build and live
acceptance remain open.

## Explicit-load panel and reload protection

Added a parent translation panel using the prepared client and real form. It
loads only on explicit request, never polls or refreshes after saves, and tags
snapshots with authenticated-client and review identity. A replaced client or
review immediately stops rendering the old snapshot; operation sequencing rejects
late reads. Denied/expired-auth writes clear the editor and its private drafts.
The caller must replace client identity when the authentication context changes.

Reload now compares every in-memory locale draft against the loaded snapshot.
Any unsaved draft requires localized explicit discard confirmation; cancel keeps
it and a failed read retains it. Save and reload each have synchronous in-flight
guards. Independent review caught a same-event submit/reload race in a state-only
check; a separate save-pending ref fixes it and a single-batch regression covers it.

Shopify typecheck and 32 actual-Polaris DOM/client tests pass, covering locale
draft protection, failed reload, save/reload interleaving, stale read suppression,
review switching and access-loss cleanup. These use injected transport and jsdom,
not real Shopify authentication or layout acceptance. The panel is not mounted
in the review page and its HTTP routes remain absent pending the SQL and rollout
gates. The full feature remains unaccepted.

Panel follow-up review found definitive 404/410 responses were classified as
transient failures, potentially retaining previously loaded erased content.
The translation-only transport now classifies those responses as content-access
loss, clearing the snapshot just like denied/expired authentication. Network/5xx
failures remain ambiguous and preserve drafts. Loaded review → reload 404/410
tests exercise the real client classification and actual panel together.
After this correction, Shopify typechecking and all 36 form/panel/transport tests
pass. No route or deployed reader has been enabled.

## Named isolated MySQL checkpoint — September 20, 09:34 JST

Executed five `manual translations:` cases in the existing native-review MySQL
suite against fresh restricted-principal databases in the approved isolated Lima
instance. Each run generated this branch's Prisma client, pushed schema to the
empty fixture, then replaced the empty translation tables with the exact checked-in
`20260920_review_translations.sql` DDL. No retained/shared schema was changed.

- Initial fixture `weletic_loyalty_it_shopper_24cec8e286b6`: five passed.
- Reviewed rerun `weletic_loyalty_it_shopper_cf349a35e23e`: five passed, with
  strengthened assertions requiring the losing concurrent writer's exact revision
  conflict and the duplicate audit action's Prisma `P2002` unique target.
- Both exact fixture databases/accounts were removed by the harness. The retained
  development ledger count was 16 before and 16 after each run.

The real production helpers prove three-locale create/read/private export,
remove/recreate revision identity, original-rating/text preservation, one winner
for competing revision-zero writes, transactional rollback on audit uniqueness,
and actual unlinked customer-ID/email tombstone suppression of reads and writes.
The suite's 36 unrelated cases were deliberately filtered out, not counted as
passing. Providers remain mocked and the internal actor fixture bypasses HTTP/staff
authentication; merchant action receipt rollback is not proven by these cases.

Still open: two-connection privacy insertion ordering and deadlock-retry evidence,
foreign-store fixtures, source-edit invalidation, post-write erasure/purge and
export reconciliation after redaction, full-suite/build checks, authenticated
route integration and live acceptance. This checkpoint cannot close R09.
Full web typecheck passed before assertion-only review corrections; focused lint,
formatting and diff checks pass. Generated Prisma client remains this branch's
schema; sibling worktrees must regenerate before verification.
The MySQL container and localhost forwarding were stopped, and Lima confirmed
stopped at 09:35 JST. No application server, tunnel or email service was started.

## Cross-store and post-write erasure SQL checkpoint — 09:38 JST

Fresh fixture `weletic_loyalty_it_shopper_b274dbe4be5a` repeated the exact DDL
rehearsal and passed all seven targeted translation tests (36 unrelated tests
filtered out). A separate active store with its own workspace/program passed
the lifecycle guard but received `not_found` for reading/removing the original
store's translation. Owned content/revision remained intact and no foreign audit
was written.

The production review-erasure worker drained its real batches after a translation
save, removed title/body/source digest/source locale, retained revision and the
content-free audit, produced a content-free private export, and rejected a later
rewrite. The unchanged suite-ledger count proves no financial side effect here;
it does not establish preservation of a nonzero earned balance. Independent
review found no concrete defect or harmful interference with subsequent fixtures.

Full web typecheck, focused lint and diff checks pass. The exact disposable
database/account was removed; the retained development ledger remained 16 → 16.
Concurrent tombstone insertion ordering, deadlock retries, source-edit invalidation,
staff action receipt atomicity, routes, storefront display and live acceptance
remain unproven. No shared schema or live store was changed.

## Privacy-first concurrency SQL checkpoint — 09:41 JST

Fixture `weletic_loyalty_it_shopper_fed73e24f1c1` passed all nine targeted
translation cases against the exact draft DDL; 36 unrelated cases were filtered
out. Two new cases insert an unlinked customer-ID/email privacy tombstone in a
held transaction, then start the production translation writer in a different
MySQL connection. Barriers establish completed insertion and writer transaction
entry before releasing the privacy commit. The writer then rejects with exact
`not_found` / `Review unavailable`, leaving no translation or audit.

The bounded 100 ms unsettled observation establishes overlap, not independent
InnoDB lock-wait instrumentation; do not claim a specific lock was observed.
Independent review found no blocking correctness/cleanup defect. `finally`
releases the held transaction, awaits both operations and removes only returned
fixture tombstone IDs. The harness removed the exact database/account and the
retained development ledger remained 16 → 16. Full web typecheck, focused lint
and diff checks pass.

Writer-first concurrent erasure, explicit deadlock recovery, authenticated staff
receipt atomicity and installed-store acceptance remain open. These tests do not
authorize production schema changes, routes or deployment.

## Writer-first concurrency checkpoint — 09:43 JST

Fixture `weletic_loyalty_it_shopper_0c4db600eae9` passed all 11 targeted cases
(36 unrelated cases filtered out). New customer-ID/email cases hold the writer
after real translation and audit inserts but before commit. Privacy upsert enters
on a different MySQL connection; after releasing the writer, both operations must
succeed. Production redaction batches then erase the committed translated text
and source digest while retaining revision/audit identity and rejecting rewrite.

Independent review found no concrete defect. As with privacy-first tests, the
100 ms unsettled check is overlap evidence rather than lock-wait instrumentation.
The test calls redaction directly, so compliance-queue delivery, induced deadlock
recovery and authenticated merchant action receipts remain unproven. Exact
fixture/account cleanup succeeded; retained development ledger was 16 → 16.
Full web typechecking, focused lint and diff checks pass.

The subsequent unfiltered native-review SQL run used fresh fixture
`weletic_loyalty_it_shopper_e3cc0db85938`, rehearsed the same translation DDL,
and passed all 47 cases with none skipped. This checks the translation additions
alongside existing native review service behavior, rather than just the new test
filter. Exact database/account cleanup succeeded and retained ledger count stayed
16 → 16. It is still isolated SQL evidence with mocked external providers, not
live Shopify acceptance or a full application build.

## Signed HTTP wiring checkpoint — 09:53 JST

Added internal read/write translation routes and authenticated Remix adapters.
The backend verifies the complete actor/input HMAC before gateway entry; strict
schemas reject caller-injected ownership. Read/write limits are 16/64 KiB, with
the latter covering a fully Unicode-escaped 10,000-character translation.
Definitive privacy/unavailable-review 404 responses survive the adapter so the
existing client clears cached editor content. All responses are private/no-store;
unknown failures are sanitized and ambiguous writes are not retried.

Verification: 46 focused route/adapter/gateway regression tests passed, including
real HMAC verification and authenticated-adapter callback forwarding (authentication
and SQL services mocked at their respective unit boundaries). All 227 Shopify
package tests, both web/Shopify typechecks, focused ESLint and Shopify application
build passed. Build emitted existing Vite/Remix and source-map warnings; no claim
of a warning-free build. Independent review found no blocking issue; its requested
positive adapter coverage and stale-comment cleanup were completed.

The new routes remain an uncommitted local draft. The additive schema must precede
deployment of both routes and privacy/export readers. No shared schema, provider,
store configuration or live installation changed. Reviews-page mounting,
storefront translation projection/original toggle, authenticated SQL receipt
atomicity, induced deadlock recovery and named live acceptance remain open.

## Merchant page integration checkpoint — 10:00 JST

Mounted the translation editor on non-redacted Reviews-page records with fresh
App Bridge token acquisition through the prepared signed routes. Shared synchronous
operation ownership prevents translation reads/saves overlapping list reloads,
pagination, filters or moderation. Home navigation is blocked while an operation
is unresolved; beforeunload warns for pending work or unsaved translation drafts.
Page-level discard confirmation protects drafts in every locale. Definitive
translation access loss clears the enclosing review list too, so cached original
text/display names do not survive an authoritative denial.

Independent review identified two integration defects (page actions bypassing
draft confirmation; privacy denial clearing only the nested editor) and a
cross-locale follow-up (saving JA incorrectly marking an EN draft clean). All
three were corrected with real-page component regressions. Final focused review
confirmed the cross-locale correction.

All 240 Shopify-package tests passed, including 13 page integration tests and
22 translation form/panel tests. The page tests use actual Polaris/translation
components but mocked authentication, list/translation services and moderation
form; they are not installed-Shopify browser acceptance. Shopify typecheck and
focused ESLint passed. No services, shared schema, real messages, installs or
deployments were started. The draft remains uncommitted pending complete
storefront integration and remaining SQL/build/release verification.

## Storefront translation draft checkpoint — 10:06 JST

Wired locale through Liquid, the app-proxy allowlist, internal route and public
query. Public responses explicitly project matching fresh translations plus the
original title/body, excluding identity/digest/audit metadata. Cursor locale
binding prevents mixing language snapshots. Added EN/JA/VI widget controls,
safe-text original/translation toggling, and clearing cached cards/summary on
request failure. Ten public-query unit cases and all 243 Shopify-package tests
passed (including three real widget DOM tests with mocked fetch).

Independent review found a release-blocking privacy inconsistency: SQL summary
eligibility only covers linked tombstones, while customer/email identity matching
also catches unlinked tombstones. A first draft filtered only page items, exposing
suppressed-row metadata in its base64 cursor; this was corrected to throw a
sanitized unavailable error for any detected page identity match, returning no
summary/cursor at all. This is containment, not complete resolution: an unlinked
tombstone outside the scanned page may still affect SQL summary values.

Do not merge/release this draft until summary, row and pagination privacy eligibility
are consistent and independently tested against real customer/email tombstones.
No live theme, extension, deployment, shared schema or external provider changed.
The isolated SQL suite has not yet been rerun with this public-query change.

## Privacy diagnosis and forwarding verification — 10:10 JST

Confirmed that unlinked tombstones are intentional in the existing upsert
contract, not merely corrupt test fixtures. The complete fix needs consistent
eligibility before aggregates/page selection. The indexed-identity versus
per-request-scan decision has been surfaced; implementation remains unapproved.
See [the proposal](review-public-privacy-eligibility-proposal.md) for writer
coverage, additive rollout, retained-key rotation and acceptance requirements.

Added actual service-signature locale forwarding regressions for EN/JA/VI at
both proxy and internal route boundaries. Added widget regressions for failed
pagination clearing cached cards/totals and original-only/wrong-locale fallback.
All 26 focused gateway/public-query tests and all 246 Shopify-package tests
passed. Both web and Shopify typechecks pass. These are mocked-provider/local
tests, not installed-theme or live privacy acceptance. No database/runtime was
started and the release-blocking privacy eligibility gap remains explicit.

## Authenticated SQL receipt checkpoint — 10:16 JST

Added actual merchant gateway SQL tests using encrypted bound online sessions,
production staff authorization and transaction fencing. Both legacy installation
and mapped public admission/store-owned credential variants prove:

- authorized translation content and audit reference the committed merchant action;
- replayed request identity is rejected without another receipt or revision;
- stale translation revision rolls back its newly inserted action receipt;
- staff without a grant is denied without creating an action;
- the rolled-back request identity remains usable for an authorized read;
- read permission produces a separate receipt without a new translation audit.

Independent review verified the public variant uses the native credential path,
not legacy fallback, and that cleanup targets only fixture-owned records. This
uses synthetic credentials: it does not prove OAuth, a real public installation,
or live Shopify staff access. Earlier direct-helper tests cover post-content audit
uniqueness rollback; this new gateway case covers authorization and early-receipt
rollback on validation failure, not an injected post-content gateway failure.

Initial legacy-only fixture `weletic_loyalty_it_shopper_e7f4c9c6bd9d` passed 48
native-review cases. Final fixture `weletic_loyalty_it_shopper_37d684b99d85` passed
all 49 cases with none skipped after rehearsing the exact translation DDL.
Both exact databases/accounts were removed; retained ledger count stayed 16 → 16.
The full rerun includes the changed public query, but does not close its known
outside-page unlinked-privacy summary gap or the pending index design decision.

## Real deadlock recovery checkpoint — 10:22 JST

Found and fixed a retry gap in the existing shared review transaction boundary:
Prisma raw SQL locks report MySQL deadlock rollback as `P2010` with exact
`meta.code = "1213"`, whereas the wrapper previously handled only `P2034`
and optimistic conflicts. The narrow addition preserves the five-attempt bound
and original installation generation. It does not retry lock timeout 1205,
duplicate keys, P2028, generic connection ambiguity or lookalike plain objects.
The regression initially failed two cases; all ten retry tests now pass.
Independent review checked callback replay safety and found external provider
sends/uploads/catalog requests outside these transaction callbacks.

An induced SQL deadlock uses a disposable scratch table to invert lock order.
The final test inserts translation and audit first, then requires that exact
transaction to be the MySQL rollback victim. The retry reuses the same action
identity and expected revision; assertions require actual P2010/1213, exactly
two attempts and exactly one committed translation/audit.

Evidence:

- `weletic_loyalty_it_shopper_1c8ae3e99998`: 50 passed with the first, weaker
  deadlock-before-content version.
- `weletic_loyalty_it_shopper_7a0e92c8d4ee`: failed the strengthened test because
  the competing transaction was selected as victim; this did not prove the
  intended retry path. Exact fixture cleanup succeeded.
- `weletic_loyalty_it_shopper_41518fff1b5a`: all 50 passed with the strengthened
  post-content rollback test after increasing the competitor's synthetic row
  workload. The assertion was not relaxed. Exact DDL was rehearsed; scratch
  table, database and account were removed, retained ledger remained 16 → 16.

This is isolated MySQL evidence, not process-crash, network ambiguity or live
Shopify acceptance. The pending public privacy eligibility decision and all
previous external release gates remain open.

## September 20 — approved owner-privacy projection, draft increment

ADR 0041 is now merged in PR #95 (`874151a231`). Its indexed HMAC projection
choice replaces the earlier pending-decision status; the unresolved eligibility
gap is still a release blocker until implementation and acceptance pass.

Preserved the entire translation draft in a named Git stash before integrating
public main. Restored it without dropping that backup. Resolved staff privacy
and SQL test conflicts by retaining both Flow-grant/translation-audit cleanup
and both upstream process-crash/moderation-deadlock and translation-deadlock
tests. Independent review compared both sources and found no lost test cases.

Draft additions (not wired into runtime or published):

- Private store/shopper coverage and retained-key identity-row Prisma models.
  Coverage records generation, key-set proof, source proof, identity count and
  terminal erasure state. No raw customer IDs, emails or keys are persisted here.
- A deterministic contract using the existing tombstone HMAC/canonicalization
  rules. Key-set proof changes even when a secret is incorrectly replaced under
  the same key ID. Key ordering does not change coverage. Pseudonymous redacted
  customer IDs are rejected rather than rehashed as fresh identities.
- An internal transaction primitive that locks store then exact owned shopper,
  derives from persisted values, rejects linked/unlinked tombstones and retained
  redacted coverage, and replaces identity rows plus coverage in the caller's
  transaction. It exposes only the written identity count.

Verification: Prisma validation/client generation passed without applying any
database schema. **102 tests in five focused suites passed**, and web type-check
passed. Initial combined staff tests lacked the other module's empty table mock;
those fixtures now include both models. The first writer test asserted Prisma
SQL-object arguments for a tagged-template call; it now verifies the actual
parameter arguments. Neither correction relaxed production checks. These are
unit/mock results, not atomic SQL or backfill acceptance.

### Required next implementation and verification

1. Wire atomic maintenance into `upsertWeleticShopper`, using the persisted row
   before the inactive-loyalty return. Do not let a partial webhook erase a
   retained email or trigger loyalty enrollment.
2. Make projection erasure atomic with identity pseudonymization in
   `scrubWeleticShopperCustomerContext` and
   `redactShopperIdentityForShopErasure`. Already-pseudonymized retries must finish
   projection cleanup; linked tombstones remain authoritative.
3. Add bounded, generation-fenced backfill/readiness and key-retirement audit
   coverage. Include fixture creation/deletion utilities so they cannot orphan
   coverage. Never use generic shopper `updatedAt` as identity freshness.
4. Apply one indexed eligibility predicate before public review rows, aggregates,
   rating distribution and pagination; also cover summary sync and media access.
   Missing/stale coverage must be distinguishable from a genuinely empty set.
5. Add exact additive migration DDL, isolated MySQL anti-join/query-plan,
   source-change/privacy/rotation races, interrupted backfill and reconciliation
   tests. Shared schema application remains separately gated.

No privacy gate is closed by these draft models or helpers. All runtime writers,
public SQL filtering, backfill, retention and real-store acceptance remain open.

### Current-read correction after adversarial review

The reviewer identified that a caller can establish a Repeatable Read snapshot
before acquiring the owner lock. Ordinary reads after that lock could therefore
certify an old email or miss terminal redaction. The draft now selects source
fields, account privacy metadata, coverage state and matching tombstones through
parameterized `FOR UPDATE` current reads in the same transaction. The focused
five-suite rerun passed **102/102** after updating the query fixtures; these mocks
assert locking reads and tenant-scoped parameters, not actual SQL isolation.

A two-connection MySQL regression with an already-established snapshot passed
**3/3** in disposable fixture `weletic_loyalty_it_shopper_702879b78228`.
Each case proves distinct database connections and demonstrates that ordinary
reads retain the old snapshot after the other connection commits. The current
writer then uses the updated email, rejects terminal redacted coverage, or
rejects an unlinked customer-ID tombstone. The email case reconciles persisted
coverage and all identity rows against the expected current-source projection.

The exact additive `20260920_review_owner_privacy.sql` DDL was rehearsed after
verifying both generated fixture tables were empty. Fixture database and user
were removed; the retained development ledger stayed **16 → 16**. This proves
the three tested serializations, not every interleaving, key rotation, backfill,
public-reader eligibility or live acceptance. No shared schema, runtime
activation, production deployment or live customer data was changed.

The complete native-review SQL suite then passed **58/58** in fixture
`weletic_loyalty_it_shopper_55c09bfcdd23`, including existing crash/deadlock and
translation lifecycle cases. Independent review requested exact before/after
projection equality after rejected calls, since the rejection is caught inside
the transaction. Those stronger assertions passed **3/3** in a fresh exact-DDL
rehearsal, fixture `weletic_loyalty_it_shopper_a01527bbe8a7`. Both fixtures and
accounts were deleted, with retained ledger **16 → 16**. A startup attempt before
the last run failed because MySQL was not yet ready; it failed before fixture
creation. The retry followed an explicit healthy-container check. Changed-source
lint and web type-check passed. These results precede integration of PR #88 into
this draft branch and do not claim combined-main runtime acceptance.

### PR #88 integration and atomic owner erasure

Integrated public main `2517e7d73a` after retaining the entire draft in stash
`Review privacy SQL verified draft before PR88 integration`. The single import
conflict in `reviews/privacy.ts` retains both points-recovery cancellation and
translation erasure; no draft or backup was discarded.

The customer scrub path now pseudonymizes the exact owned source and erases its
private identity projection in one transaction. The shop scrub path does the
same, and already-pseudonymized retries drain remaining projection data instead
of returning immediately. The internal helper uses store → shopper → coverage
current locks, preserves the first redaction timestamp and keeps terminal
coverage while removing identity/source/key proofs. It does not grant operational
authority, reactivate a store, remove financial history or delete tombstones.

Independent review caught that legacy stores may lack an installation generation.
Terminal coverage now retains that real null value; active construction still
requires a nonempty generation. This is reflected in schema and draft DDL.

Verification on the integrated draft:

- **101/101** focused unit tests; **74/74** compliance tests after strengthening
  the already-pseudonymized retry assertion. Changed-source lint passed.
- **5/5** focused real MySQL tests after exact revised DDL rehearsal in fixture
  `weletic_loyalty_it_shopper_32bed00a07a0`: stale snapshots, actual customer
  pseudonymization/retry, rollback after an injected transaction failure, and
  legacy null-generation erasure.
- **60/60** full native-review SQL tests in fixture
  `weletic_loyalty_it_shopper_f95c5eb9a539`. Both fixture databases/accounts were
  removed and the retained development ledger remained **16 → 16**.
- Whole-shop request execution remains boundary-mocked; the shared erasure
  primitive and actual customer-scrub entrypoint have SQL evidence, not live
  whole-shop acceptance. No shared schema was applied.
- Default-heap web type-check failed with Node heap exhaustion, not a reported
  TypeScript diagnostic. The 8 GB heap retry completed successfully with no
  TypeScript diagnostics. Independent re-review confirmed the legacy-generation
  blocker was fixed. MySQL and the isolated Lima instance were stopped afterward.

Active identity ingestion, backfill/readiness, public SQL eligibility, rotation
and retention integration remain unfinished. This draft is not release-ready.

### Generation-bound ingestion and retained-key audit increment

Shopper ingestion now checks/locks the saved source using the same retained
tombstone predicate as projection replacement, then replaces projection rows
from the persisted final source in the same transaction. This occurs before
the disabled-loyalty return and does not create loyalty accounts or signup
awards while the module is off. A missing legacy generation never becomes
invented active coverage. Partial payloads retain the saved email.

Review identified an expired-but-retained old-email bypass in the first draft:
the existing generic privacy helper filters by expiry, while review projection
suppression covers every retained tombstone. The final saved-source locking
check includes those retained rows before any email rewrite. The regression
proves exact unchanged source/projection after both active and expired retained
old-email suppression. Independent re-review found the correction sound.

Verification:

- **36/36** focused unit tests. The first combined run exposed a lifecycle mock
  missing the PR #88 outbox table after its fence mock started returning a real
  generation. Added the empty outbox source; no production guard was relaxed.
- **6/6** exact-DDL MySQL cases in fixture
  `weletic_loyalty_it_shopper_565344b421c0`.
- **61/61** native-review and **154/154** shopper SQL cases in combined fixture
  `weletic_loyalty_it_shopper_2312e19e8ce8`. Fixture databases/accounts removed;
  retained development ledger **16 → 16**. MySQL/Lima stopped afterward.
- Web type-check and changed ingestion/source lint passed. PR #88 post-merge
  CI run `35492443901` also completed successfully.

The key-retirement audit additionally scans private review identity rows
directly, including orphans. Its composite cursor follows declared MySQL enum
order and selects only internal row/key identifiers, not customer digests.
Missing schema fails loudly. **13/13** audit unit tests, changed-source lint and
web type-check passed. Independent review found no concrete blocker;
real MySQL multi-page/orphan pagination remains unverified. An initial
owner-join draft caused an outdated single-call fixture assertion and could
miss orphan identities; it was replaced by the direct-table scan before release.

Backfill/readiness, public filtering before aggregates/pagination, key rotation
SQL acceptance, retention cleanup and named live journeys remain outstanding.
These changes remain an unpublished draft, not release acceptance.

### Shared SQL eligibility and public reader wiring

Added fixed-alias, parameterized SQL fragments shared by public list and photo
readers. Eligibility includes module/store admission, publication, tenant-owned
product/source, current generation/key-set coverage, exact total/per-kind key
row counts, terminal coverage, source pseudonyms, account privacy markers and
linked/unlinked retained tombstones. The unlinked anti-join intentionally has
no expiry filter. Missing/incomplete coverage is unknown rather than an empty
review set; public list reads reject unknowns before computing any totals.

The list reader now computes grouped totals and ordered candidate IDs from the
same eligibility predicate and Repeatable Read snapshot, then loads only those
candidates through the existing explicit translation/public-field projection.
Cursor sort/rating/locale binding is preserved. Photo access checks the same
predicate before allowing an object key to reach the existing 60-second signer.
It does not invalidate previously minted URLs or claim actual R2 delivery.

Evidence so far:

- **16/16** public translation/locale/SQL-fragment unit tests passed.
- Exact-DDL fixture `weletic_loyalty_it_shopper_9c907e8eca8c`: **7/7** focused
  SQL cases, including actual list-reader missing coverage and retained unlinked
  email suppression before count/page exposure.
- Integrated fixture `weletic_loyalty_it_shopper_50fb75451a93`: **62/62** native
  review and **154/154** shopper SQL tests. Direct fixture shoppers now establish
  their private coverage explicitly; production ingestion is not bypassed in
  the application.
- Exact-DDL fixture `weletic_loyalty_it_shopper_a07b768d1f24`: **8/8**, adding
  one-item pages across newest/highest/lowest and unfiltered/2-star/5-star queries.
  Suppressed first/middle/last fixture rows never enter totals or cursor boundaries;
  expected ordering, no duplicates and absence of private owner/email fields are
  asserted.
- Exact-DDL fixture `weletic_loyalty_it_shopper_a4b6a04bb945`: **8/8**, adding
  actual SQL photo eligibility with a mocked download signer. Missing coverage
  and retained tombstones prevent signer invocation. Synthetic publication/time
  and media-row setup are not merchant UI or upload/provider acceptance.

All listed fixture databases/accounts were removed; retained development ledger
stayed **16 → 16**. Independent reader review found no concrete blocker. Latest
full regression and media re-review are tracked separately, not inferred from
earlier passes. Summary-sync wiring, backfill/readiness, rotation, query-plan/load
proof and live installed-theme/privacy journeys remain outstanding.

Final verification for this reader increment:

- Combined exact-DDL fixture `weletic_loyalty_it_shopper_2c819ca18792` passed
  **63/63** native-review and **154/154** shopper SQL tests.
- Media re-review found the synthetic object key did not match production
  cleanup ownership. Changed it to the production WebP prefix and asserted the
  exact key, private bucket and 60-second signer expiry. Added explicit real SQL
  deletion-pending → deleted cleanup with mocked storage deletion. Fixture
  `weletic_loyalty_it_shopper_efc4770ab052` passed **8/8** after this correction.
- Both databases/accounts were removed; retained ledger **16 → 16**. The full
  63+154 run preceded the fixture-only correction; the final focused run covers
  that corrected fixture and cleanup. No earlier pass is represented as a live
  storage test. Reader/media re-review found no runtime authorization blocker.
- Web type-check and changed-source lint passed; isolated MySQL/Lima were
  stopped after the runs. No shared schema, deployment or real sends occurred.

Source freshness still depends on atomic ingestion and the pending backfill.
Existing published owners without coverage are intentionally unavailable until
backfilled, not accepted as an empty program. This is a rollout prerequisite,
not a permanent product behavior or a completed release gate.

### September 20 — summary-sync privacy integration (unpublished)

The Shopify rating projection now uses the same privacy readiness and eligible
SQL fragments as the public reader. Readiness and grouped totals share a
repeatable-read transaction; unknown coverage throws before credentials or
provider mutations. Counts and weighted sums reject unsafe or invalid values.
Admission and installation generation are checked before reading and again
after credential resolution. The existing standard `reviews.rating` and
`reviews.rating_count` contracts and zero-count cleanup are unchanged.

Ten focused summary tests passed, including unknown coverage, invalid totals,
provider rejection, frozen/pending admission, absent generation and suspension
before publication. The combined summary, SQL-fragment and public-translation
run passed **23/23** tests. Changed-source lint and whitespace checks passed.
Independent review found no concrete code blocker.

The first web type-check caught two ES2020 BigInt literals in the new test
fixtures. Replaced these with `BigInt(...)` constructors for the existing
compilation target; the final 23-test run, web type-check and changed-source lint
passed again.

This increment has not run the summary worker against real MySQL or Shopify.
In particular, add an isolated SQL case for disabled Reviews plus missing owner
coverage and assert stale-rating deletion through a mocked provider. Add
nonzero, retained-unlinked-tombstone and generation-change worker integration
cases. Earlier list-reader SQL passes are not summary-worker evidence. Remote
metafields remain eventually consistent; pre-request checks do not claim an
atomic transaction with Shopify or immediate revocation of a completed write.
Backfill/readiness, rotation/load proof, full regression, PR/CI and live
acceptance remain open. No runtime, shared schema or external sends were used.

### September 20 — summary worker isolated SQL acceptance

The real summary worker now has an isolated SQL lifecycle case, not only mocked
aggregate results. Exact-DDL fixture `weletic_loyalty_it_shopper_4ce1269fb7ed`
passed **9/9** focused privacy cases. The new case proves:

- Enabled Reviews with missing coverage fail before credential resolution.
- Disabled Reviews with the same missing coverage produce stale-rating deletion
  and count zero, rather than blocking cleanup.
- Coverage activation yields exactly one review and rating 4.00, checked against
  an independent aggregate over the exact synthetic source row.
- A retained, expired, unlinked email tombstone suppresses that review from the
  next rating projection.
- A real SQL installation-generation change during mocked credential resolution
  rejects the worker before a further provider invocation.

The isolated product prevents cross-test totals; shared module/generation flags
are restored in `finally`. Independent review found no concrete blocker. Web
type-check and changed-test lint passed. Fixture database and restricted account
were removed, with retained development ledger **16 → 16**.

Shopify credentials/transport are mocked and Redis serialization is bypassed;
this proves SQL/worker behavior, not live publication, distributed locking or
remote race atomicity. Full-suite results and runtime shutdown follow below.

Full exact-DDL fixture `weletic_loyalty_it_shopper_05bdbaa9d005` passed
**64/64 native-review + 154/154 shopper SQL tests** with the final test code.
The exact fixture database/account were removed, retained ledger **16 → 16**.
Formatting and whitespace checks passed. The summary-worker local integration
gate is now evidenced; shared rollout, backfill, rotation/load proof and live
Shopify publication remain unaccepted.

The exact MySQL container, SSH forward and isolated Lima runtime were stopped
after verification. No Shopify mutation or shared/production schema change ran.

### September 20 — bounded privacy backfill primitive (unpublished)

Added an internal page primitive for owners with native reviews. Batches are
limited to 1–100 owners; checkpoints bind store, installation generation and the
private retained-key-set proof. Each owner uses a separate transaction and the
existing current source/privacy locks. Key material is revalidated before each
owner. No shopper enrollment, award, review publication or remote write occurs.

Only a typed authoritative-suppression result can create terminal coverage and
remove private projection proofs. That is containment, not completion of the
raw-source erasure workflow. Missing owners, stale generations, invalid keys and
database errors still abort. Review caught overly broad pseudonym classification;
the fix requires the existing parser and rejects malformed/unavailable-key
pseudonyms without writing terminal coverage.

- **19/19** focused backfill/source-helper unit tests passed after the fix.
- Exact-DDL fixture `weletic_loyalty_it_shopper_7c6c060399db`: **10/10** privacy
  SQL cases passed. The backfill case verifies one-owner pagination, resumption
  after both malformed and unavailable-key errors, no coverage on those failures,
  expired retained unlinked-tombstone containment, no enrollment, and replay
  preserving the original terminal timestamp.
- Independent re-review found no remaining concrete blocker. Changed-source lint,
  formatting and whitespace checks passed. Fixture/account removed; retained
  development ledger **16 → 16**.

This is not a publicly callable repair API or an enabled operator command.
Audited operator entry, complete source/readiness reconciliation, concurrent
insertion-before-checkpoint handling and rotation/load acceptance remain open.
A null continuation means only this bounded scan ended, not that store readiness
or shared-schema rollout is accepted. Full-suite/type-check evidence follows.

Final exact-DDL fixture `weletic_loyalty_it_shopper_b387166033ad` passed
**65/65 native-review + 154/154 shopper SQL tests**. Web type-check passed.
Fixture database/account were removed; retained development ledger **16 → 16**.
No shared schema, customer traffic, real sends or Shopify mutation was used.
The exact MySQL container, forward and Lima runtime were stopped after the run.

### September 20 — read-only reader coverage inspection (unpublished)

Added `inspectReviewPrivacyReaderCoverage`, an internal count-only inspection
using the same SQL predicates as product readers. Whole-store scope has a
separate internal builder; the public product builder still requires a product.
The inspector uses one repeatable-read snapshot, validates the current
installation, rejects unsafe or inconsistent aggregate partitions, and emits no
owner identifiers, HMAC proofs, customer data or review content.

It reports eligible, authoritatively suppressed and unknown currently publishable
rows separately. Disabled modules and inactive admissions return explicit
non-passing states. `readerCoverageComplete` means only zero unknown rows in that
snapshot; it does not certify source-writer coverage, backfill completeness,
future publication, rollout authorization or production readiness.

The combined inspector/SQL-fragment/summary/public-translation unit suite passed
**31/31** tests. Independent review found no concrete blocker. Real SQL assertions
cover unknown → module disabled → covered eligible → retained-tombstone
suppressed transitions; execution evidence is recorded below when complete.
Audited operator entry, independent source reconciliation and rotation/load
proof remain open; no new endpoint or production activation was introduced.

Exact-DDL fixture `weletic_loyalty_it_shopper_3842fb71d0b8` passed **65/65
native-review + 154/154 shopper SQL tests**, including all four real inspection
transitions. Fixture database/account removed; retained ledger **16 → 16**.
Web type-check, changed-source lint and independent review passed.

Added a thin read-only `scripts/loyalty/inspect-review-privacy.ts` operator entry
with strict `--store` and `--generation` inputs, generic failures and count-only
output explicitly stating `productionReady: false`. It has no apply/backfill
mode. Separate process-level acceptance for CLI arguments, exit codes and
startup failures remains outstanding; direct-function tests do not replace it.

The SSH forward was removed and Lima is confirmed stopped. The container-stop
request returned EOF during VM shutdown, so graceful MySQL container shutdown
was not independently confirmed. Fixture cleanup completed before shutdown.
Final web type-check including the CLI, formatting and whitespace checks passed.

### September 20 — operator inspection process boundary

Moved application imports inside the CLI's sanitized failure boundary and
validated required scope arguments before initialization. Import/inspection/
disconnect failures now use the generic private-recheck message rather than
printing error objects. This does not change inspection SQL or enable writes.

Five real child-process failure tests passed: missing arguments, missing
generation, unknown flags, positional input and valid scope with an invalid
database URL. They assert exit 1, empty stdout and exact generic stderr; input
and database sentinels are not printed. The initial test-table shape incorrectly
spread arguments; that failed fixture was corrected before the final five-case
run. Independent review found no concrete blocker; type-check and lint passed.

SQL-backed process tests for unknown coverage, disabled Reviews and successful
coverage inspection were added to the isolated summary fixture. Their execution
result follows; no live Shopify transport or shared database is authorized here.

Exact-DDL fixture `weletic_loyalty_it_shopper_44b76de965e5` passed **10/10**
focused SQL cases, including real CLI processes returning exit 1 for unknown
coverage and disabled Reviews, and exit 0 for covered publishable reviews.
Output scope and `productionReady: false` are asserted along with absence of
shopper identity/email. Exact fixture/account removed; retained ledger **16 → 16**.
This final CLI-only increment did not repeat the unrelated 154-shopper suite;
the preceding full 65+154 inspection run remains separately recorded above.
The MySQL container was explicitly confirmed `exited` before removing the
forward and stopping Lima; the VM is confirmed stopped. No services were left
running by this verification.

### September 20 — retained-key rotation containment (unpublished)

Ordinary projection replacement now compares retained customer-ID proofs under
current locks before overwriting them. It rejects changed material under an
existing key ID, missing retained keys, missing customer anchors and retained
row counts inconsistent with locked coverage. Email edits remain valid with
intact customer anchors. Ordinary ingestion/backfill cannot implicitly retire
keys or reconstruct ambiguous/corrupt retained proofs.

The real SQL rotation case proves same-ID secret replacement makes the reader
unavailable and cannot overwrite existing proofs. Adding a new key while
retaining old keys requires rebuild, then restores the eligible reader. A
retained expired unlinked email tombstone written with only the old current key
still suppresses the review. Configuring only the new key cannot discard the
old proofs. Tests also deliberately remove customer anchors/all proofs, and
remove one whole key while another survives: each corrupt state aborts. Only
the exact synthetic rows are restored by fixture setup afterward.

Independent review found and drove fixes for missing-key and partial-proof
variants. The final focused source/backfill unit suite passed **25/25**; the
initial query-count assertion was updated for the new locking read. Earlier
intermediate exact-DDL fixtures `weletic_loyalty_it_shopper_2185c45e0a90` and
`weletic_loyalty_it_shopper_d8d7fe07711e` each passed **66+154** SQL tests, but
preceded the final completeness guard and are not final acceptance for it.
Both were cleaned up with retained ledger **16 → 16**. Final results follow.

This does not authorize actual key retirement, shared configuration changes or
live rollout. Retirement audit pagination/orphan evidence, explicit audited
retirement transformation, source reconciliation and query-plan/load acceptance
remain open. No historical tombstone is deleted to restore visibility.

Final exact-DDL fixture `weletic_loyalty_it_shopper_6875a012a9d2` passed
**66/66 native-review + 154/154 shopper SQL tests** with the completed guards.
Web type-check, lint, formatting, whitespace checks and final independent review
passed. The exact fixture database/account were removed; retained development
ledger **16 → 16**. This is local SQL evidence, not live key rotation acceptance.
MySQL was confirmed exited, the forward removed and Lima confirmed stopped.

### September 20 — retirement audit SQL pagination/orphan acceptance

Added a real SQL case for the appended review-owner identity audit source.
Sixteen synthetic identity rows span two absent stores, two owners, both MySQL
enum kinds and current/previous keys. Coverage and store records are explicitly
absent, proving the audit cannot depend on an ownership join.

For batch sizes 1, 2, 3 and 7, the test compares total scanned rows with an
independent database count and the exact previous-key record identities with
the eight expected synthetic identities. No skips or duplicates across store,
owner, enum-kind or key boundaries are accepted. The full audit must report
`ready: false` with eight review-identity dependencies even after a synthetic
30-hour overlap; serialized output must not contain the identity digests.

Independent review found no concrete blocker; type-check and changed-test lint
passed. Final execution evidence follows. This tests the audit, not operational
writer fencing or permission to retire keys. The only inserts/deletes are exact
synthetic fixture rows in the disposable database; the keyring is restored.

Exact-DDL fixture `weletic_loyalty_it_shopper_ff076bcb3c7e` passed **67/67
native-review + 154/154 shopper SQL tests**, including the paginated orphan audit.
The audit unit suite also passed **13/13**. Formatting and whitespace checks
passed. Exact fixture database/account were removed; retained development ledger
**16 → 16**. Real SQL pagination/orphan detection is now evidenced; operational
retirement fencing and actual key removal remain separate unaccepted gates.
MySQL was confirmed exited, its forward removed and Lima confirmed stopped.

### September 20 — transactional backfill audit foundation

Added a private additive audit table and trusted internal attribution on the
bounded backfill primitive. Each audit row commits in the same transaction as
one projected/suppressed outcome. Audit insertion is outside the suppression
catch: an audit failure must roll back that owner's projection. Replays append
another operation; counts are not distinct-owner or readiness evidence.

Rows contain an operation UUID, run UUID, store/generation, opaque operator
reference, outcome and timestamp. They contain no shopper ID, email, customer
digest or key proof. The reference is attribution, not authentication. Existing
internal callers may omit it; the future operator apply wrapper must require it.
No operator CLI/apply authorization or public endpoint is introduced here.
Audit access/retention and shared migration remain rollout gates.

The focused backfill unit suite passed **12/12** and web type-check passed.
Independent review requested a specific database-error assertion, incorporated
in the SQL test. Initial fixture `weletic_loyalty_it_shopper_95e5abdaa5df`
failed during test trigger setup with MySQL 1295 (unsupported prepared statement),
before the audit-boundary test could run; **66/67** native tests passed. This is
not rollback acceptance. Exact fixture database/account were removed and the
retained ledger stayed **16 → 16**. The revised test uses a temporary named CHECK
constraint in the disposable database and asserts that constraint's failure.
Final rerun evidence follows.

Final exact-DDL fixture `weletic_loyalty_it_shopper_28ffc41a2aac` passed
**67/67 native-review + 154/154 shopper SQL tests**. The named database constraint
failure rolled back coverage, identity proofs and audit insertion; removing the
test constraint allowed projected, suppressed and replay operations to commit
with corresponding audit rows. Independent review found no remaining finding
in this increment. Lint, formatting and whitespace checks passed. Exact fixture
database/account were removed; retained development ledger **16 → 16**.
This is isolated SQL atomicity evidence, not live operator acceptance. The
dry-run/apply wrapper, mandatory operator attribution, run reconciliation and
rollout authorization remain unfinished; no PR or deployment is claimed.
The MySQL container was confirmed exited, its SSH forward removed and Lima
confirmed stopped after verification.

### September 20 — private operator preview/apply/resume

Added `backfill-review-privacy.ts`, defaulting to a read-only bounded selection.
Apply requires an expected selection digest, opaque operator reference, UUID-v4
run ID and a new private checkpoint path. The selection proof binds store,
generation, current key-set proof, start cursor, limit and selected owner IDs.
Current source/privacy guards remain authoritative under each owner's locks.
No new public API, staff identity or shared execution authority was introduced.

Checkpoints use exclusive `0600` output creation, owned regular-file input,
no-follow/nonblocking opens and a hard 8 KiB read limit. Independent review caught
the FIFO-open hang and unrestricted-read issue; both were fixed with real process
regressions for FIFO, directory, symlink, oversized and permissive files. Partial
failure recovery replays the previous checkpoint into a NEW output path; audit
counts remain committed operations rather than distinct owners.

The operator runbook documents private artifacts, replay, scope confirmation and
the remaining reconciliation/retention/rollout gates. Focused unit/process tests
passed **22/22**; web type-check and changed-code lint passed.

Initial exact-DDL fixture `weletic_loyalty_it_shopper_0808171ca90a` passed **67/68**
native tests: the real command produced missing-Redis configuration warnings,
violating the clean-stderr assertion. No command mutation was accepted by that
test. The disposable process environment now supplies loopback-only unused Redis
placeholders, without connecting a provider. Exact fixture/account were removed,
retained ledger **16 → 16**. Final rerun evidence follows.

Final exact-DDL fixture `weletic_loyalty_it_shopper_2aca66112553` passed
**68/68 native-review + 154/154 shopper SQL tests**. The real CLI process proved
preview without audit writes, successful audited apply, `0600` checkpoint output,
resume, existing-output rejection and stale-digest rejection without extra audit
operations. Exact fixture database/account were removed; retained ledger remained
**16 → 16**. Formatting and whitespace checks passed. This is isolated process/SQL
acceptance only; shared rollout, source reconciliation and live gates remain open.
After verification, MySQL was confirmed exited, its forward removed and Lima
confirmed stopped. No shared schema, deployment or live store mutation occurred.
Final independent review found no remaining blocker in the bounded operator
increment; it did not infer live readiness or close the outstanding release gates.

### September 20 — persisted source reconciliation and retained-email suppression

Added read-only RR-page reconciliation across all owned native-review shoppers,
including unpublished reviews. It derives expected proofs from persisted sources
and compares exact tuples, source/key digests, generation and coverage state.
The first page separately counts reviews with missing/cross-store owner references.
The `inspect-review-privacy.ts --sources` command reports only aggregate counts,
supports bounded page size/count, exits nonzero on truncation/unresolved findings,
and explicitly disclaims a consistent whole-store snapshot or production readiness.

This exposed a writer gap: after a legacy source-only email change, replacement
checked derived current identities but could miss a retained email proof matching
an expired unlinked tombstone. The locking source guard now reads retained proofs
before tombstone lookup and checks both sets; it cannot replace away that evidence.
The runbook records local source-writer paths and remaining deployed-writer fencing.

First fixture `weletic_loyalty_it_shopper_efc1758b4c01` failed an older key-rotation
assertion that expected a missing-key proof error. The strengthened guard correctly
reports authoritative suppression first; the assertion was updated while retaining
checks that coverage/proofs remain unchanged. Exact fixture/account were removed,
retained ledger **16 → 16**. Intermediate fixture
`weletic_loyalty_it_shopper_6446fd9801be` passed **69+154** SQL tests before the final
orphan-reference assertion; it was also cleaned up with retained ledger **16 → 16**.

Final exact-DDL fixture `weletic_loyalty_it_shopper_1fe52901ddf5` passed **69/69
native-review + 154/154 shopper SQL tests**. Evidence includes same-shaped stale
email proofs, corrupted identity digest, expired retained tombstones after another
source change, malformed pseudonyms, wrong scope/generation, actual CLI truncation
and multi-page traversal, count-only output, no audit writes and orphan detection.
Exact synthetic source/reference edits were restored where required; the fixture
database/account were removed and retained ledger remained **16 → 16**.

Focused source/backfill/CLI tests passed **38/38**; type-check, lint and independent
review passed. Load/query-plan acceptance, externally deployed writer inventory,
crash/rotation operations, shared rollout and named live journeys remain open.
The feature draft is still unpublished; no shared schema or live store was changed.
Formatting/whitespace checks passed. After verification the MySQL container was
confirmed exited, its SSH forward removed and Lima confirmed stopped.

### September 20 — release PR integration and draft baseline refresh

Revalidated and squash-merged the outstanding public PRs without weakening CI
or using old-head evidence:

- [PR #91](https://github.com/satoshicancode/weletic-room-public/pull/91),
  `02434f257719b4e51d2e4be2108792d472a5f025`: Thank-you BigInt syntax compatibility.
  Fresh branch head `b229919a9c6e246b25ecfa2aeb6cac03559de8c2` passed all six jobs
  in full run `35497369124`; protected path-filtered checks passed. Local 192
  Shopify tests, type-check, build, ESLint and formatting passed. Post-merge
  run `35497890073` passed.
- [PR #94](https://github.com/satoshicancode/weletic-room-public/pull/94),
  `46dcf9fa46d7bb7fd42e40106b2f038ccf598234`: resource/reviewer preparation only.
  Fresh branch head `cc6fadb56210d968f7526c1e4d0861b9ca3ee7ff` passed all six jobs
  in full run `35497915747`; protected path-filtered checks passed. Independent
  documentation re-review and formatting/whitespace checks passed. The resource
  worktree had no installed formatter; used the existing clean release worktree's
  dependency runtime without installing or changing dependencies.

Main was synchronized, the existing dirty acceptance-matrix edit preserved, and
only the merged local branches removed (worktrees retained detached). The
translation/privacy draft fast-forwarded from `2517e7d7` to `46dcf9fa46` without
conflicts or discarding staged, unstaged or untracked work; retained safety stashes
remain. On this updated draft, all **247 Shopify tests**, Shopify type-check and
Remix production build passed. Existing Vite/sourcemap/React Router warnings remain.
No database/runtime service, deployment, external send, order, resource purchase
or Shopify publication was performed. The draft remains uncommitted/unpublished.
PR #94 post-merge verification follows.
Post-merge run `35498427959` passed on exact merged main
`46dcf9fa46d7bb7fd42e40106b2f038ccf598234`. The existing classifier correctly
skipped application jobs for this documentation-only merge; its full six-job
pre-merge run is recorded above. No open public PRs remained at verification.
This closes integration of PRs #91/#94, not live L07/S03/S04/S06 acceptance.

### September 20 — bounded multi-tenant privacy query probe

Added a disposable SQL fixture with 1,000 target-store reviews/100 owners and
2,000 foreign-store reviews/200 owners. Each store has its own workspace/program.
Rows are explicitly synthetic, unverified and unrewarded; no actual Shopify
order, invitation, delivery or incentive lifecycle is claimed. Twenty target
owners have expired-but-retained unlinked email tombstones: the expected public
population is 800, with 160 reviews per rating and average 3. Identical customer
identities in the other tenant must not suppress its 2,000 reviews.

The probe observes sanitized JSON query-plan access paths for unknown coverage,
aggregate, newest, highest and rating-filter queries. It checks exact aggregate
values plus the first two 50-row pages in newest/highest/lowest order, including
timestamp ties. Full EXPLAIN conditions and private identity proofs are not logged.
These are single measurements and bounded-page checks, not full pagination,
efficient anti-join guarantees, concurrency/load saturation or production SLO
acceptance. The rating-filter query is explained, not executed by this probe.

Failed evidence is retained:

- `weletic_loyalty_it_shopper_350527113e9e`: 69 existing tests passed; load setup
  violated the unique store/workspace relation. Corrected to separate exact
  synthetic workspaces/programs. No load acceptance from this run.
- `weletic_loyalty_it_shopper_2acdcf1c23fb`: load assertions and 69 existing tests
  passed, but fixture parent cleanup hit Prisma's emulated legacy
  `ProgramEnrollment.partnerId` cascade mismatch. Replaced only exact fixture
  parent removal with parameterized SQL after explicit child cleanup, followed
  by zero-count assertions. No production cascade behavior was changed.

Both failed-run databases/accounts were removed by the outer harness; the
retained development ledger stayed **16 → 16**. Independent review checked both
fixes and the evidence limitations. Final fresh SQL verification follows.

Final fixture `weletic_loyalty_it_shopper_a0ec461802f8` passed **70/70 native-review
and 154/154 shopper SQL tests**, including exact checked-in DDL rehearsal. Parent
cleanup assertions passed; the outer harness removed the exact database/account
and retained ledger remained **16 → 16**. Type-check, focused ESLint, formatting
and independent review passed.

Observed unknown-coverage/aggregate reads took 67.92/83.99 ms; six public reader
calls took 299.66–456.84 ms on this local isolated runtime. Review access used
store-scoped `ref` paths (`storeId_id` for unknown, `storeId_shopperId` for other
plans); the optimizer also chose a tombstone index scan and an identity access
estimate of 602 rows. These are observed plans, not evidence that every anti-join
is optimally selective. Further representative-volume, concurrent-traffic and
production-provider verification is still required. No index change or weakened
privacy predicate was made to obtain a passing result.

The feature draft remains uncommitted/unpublished. No shared schema, Shopify
store, real email/order, deployment or paid resource was changed.
After verification, the exact MySQL container was confirmed exited, its SSH
forward removed, and the isolated Lima instance confirmed stopped.

### September 20 — merchant translation privacy and release admission

Independent integration review found two concrete gaps before PR publication:

- Merchant translation reads/writes still used only the expiry-filtered customer
  tombstone helper. They could expose or create translated content while retained
  expired/old-email proofs, terminal coverage or pseudonymized source suppressed
  public readers. Added a same-transaction adapter to the existing current-read
  owner guard, before merchant output/content/audit writes. Only authoritative
  suppression maps to `not_found`; unknown/key/storage failures propagate. The
  adapter never writes coverage or grants staff authority.
- The Cloudflare Reviews opt-in route list lacked the two signed translation
  POST endpoints. Added exact read/write paths, preserving default-off behavior,
  method restrictions, sibling denial and application authentication.

Focused translation units passed **36/36**, release route tests **33/33**,
type-check and lint passed. Intermediate fixture
`weletic_loyalty_it_shopper_c39355b9c051` passed **74+154 SQL tests** and was removed
with retained ledger **16 → 16**. Review then strengthened the pseudonym SQL case
to retain active coverage, proving that independent marker rather than allowing
terminal coverage to mask a regression; final verification follows.

The initial broad unit command lacked CI's synthetic Shopify app identity and
stopped after **1,649 passes** on validator `invalid_scope`. No relevant validator
code changed. The same validator suite with checked-in CI's synthetic app ID and
secret passed **29/29**; a full rerun with that identity is pending. This is not
recorded as a green full suite. No CI configuration was changed.

Final strengthened fixture `weletic_loyalty_it_shopper_918a1d5f4c1f` passed
**74/74 review + 154/154 shopper SQL tests**. It independently denies editor
read/write for expired unlinked records, retained old-email proofs after source
drift, terminal coverage, and a pseudonymized source with still-active coverage;
no translation or audit row is created. Exact database/account were removed,
retained ledger **16 → 16**. All **62 changed/new web JS/TS files** passed ESLint
with zero warnings; formatting and whitespace checks passed. Full-suite/build
verification remains in progress; this draft is not yet published or live.

Broad verification then reached **1,882 passing tests** before an outdated
`challenger-security-antiabuse` Prisma mock failed on the new translation delegate.
Updated only that empty-review fixture with translation delegates, scoped current
owner reads and projection erasure operations; unknown query shapes throw.
Added explicit zero-proof/terminal-coverage and exact owner-deletion assertions,
preserving its existing immutable-financial-record assertions. All **27 tests**
in the corrected adversarial suite passed. A full sequential run without early
bail is in progress so remaining integration failures can be collected together.
The corrected fixture also passed zero-warning ESLint and the full web TypeScript
check. This does not close the still-running full unit/build gates.

Full web production build passed with Prisma generation, lint/type validation,
367 generated static pages and build traces, using disposable fixture
`weletic_loyalty_it_shopper_726db5890e93` and loopback provider placeholders.
The harness removed that database/account; retained ledger remained **16 → 16**.
This is build acceptance, not a deployed runtime, real provider or live-store
journey. The broad unit run remains pending.
The MySQL container was confirmed exited, its SSH forwarding removed and Lima
confirmed stopped after the build. The remaining unit run uses mocked transports
and does not require that database runtime.

Final full sequential unit run passed **580/580 files, 9,339 tests passed and
6 skipped (9,345 total)** in 777.39 seconds, using CI's synthetic Shopify app
identity. Skipped tests are not live acceptance. The built Next.js manifest
contains both signed translation read/write routes. Draft-wide formatting covered
83 supported files; one runbook Markdown alignment issue was corrected and
rechecked. No matching Shopify token/signed-URL patterns were found in the new
public documentation. The draft is ready for commit/PR verification, not shared
migration, deployment or live activation.
