# Historical opening-balance import

## September 12 signed merchant gateway database checkpoint

Eight opt-in integration tests pass through the real import `POST` handler,
HMAC verifier, native credential/session binding, staff authorization and MySQL
services. The fixture uses generated test-only signing/encryption/privacy keys,
mapped native installation records and encrypted synthetic online sessions; it
creates no Weletic user or legacy generic installation. External fetch is blocked.

The happy path covers context, byte inspection, revision-fenced staging, signed
commit, actual worker execution, signed status/reconciliation, signed rollback
and independent SQL totals. Two opening balances include an integer above
JavaScript's safe integer limit. Four append-only entries reconcile to exactly
zero after rollback. The test explicitly releases fixture scheduling/leases for
worker execution; it does not prove worker supervision or natural scheduling.

Rejections cover modified signed bytes, sequential/concurrent nonce replay,
expired online sessions, altered session digests, missing native credentials,
missing/revoked staff grants, cross-store source IDs, stale source revisions and
stale installation generations. Failed authentication checks leave no merchant
action, source or ledger write. Tests invoke `Request`/`Response` in-process:
**this is not HTTP transport, Shopify OAuth, browser login, maximum-size upload,
or named yamaxdev acceptance.** Those gates remain unchecked.

Use `vitest.historical-import-gateway-db.config.ts` only with an explicitly
selected disposable fixture. The suite requires both
`HISTORICAL_IMPORT_GATEWAY_DATABASE_INTEGRATION=1` and
`HISTORICAL_IMPORT_DEDICATED_INSTANCE=1`, a named
`HISTORICAL_IMPORT_SOURCE_FIXTURE_DATABASE` matching the import-fixture prefix,
loopback port 3308 and the verified `loyalty_dev` database principal. It does not
create or apply schema. The approved runner independently verified all 157 tables
empty before/after the eight-case run and revoked its temporary DML grant.
Cleanup targets generated fixture identities; environment restoration and
disconnect run in `finally`. No production implementation or public API changed.
The dedicated server was stopped after cleanup. The six focused gateway,
transport and deadline suites also pass (116 tests); independent final review
found no blocker. Production build evidence remains the preceding `c8796152cd`
checkpoint because this follow-up changes only tests, their opt-in configuration
and documentation, not runtime sources or dependencies.

## September 12 grouped rollback and proof-read checkpoint

The next query-only checkpoint reads ownership by account primary key, then checks
the selected account's store/program and shopper's store/customer identity.
Global metadata-linked ledger evidence is still read in full. Claims fetch only
entries not already loaded in that same proof transaction; global reference
discovery reads IDs and loads full evidence for newly discovered entries. Missing
reference hydration fails closed. Source-wide overflow, orphan/foreign evidence,
exact arithmetic and fresh per-transaction proof remain required. No schema,
public contract or application deadline changed.

Independent review found no production blocker. All 44 focused reconciliation
and batch-budget tests pass, including missing/foreign owners, missing/corrupt
claims, missing reference hydration, deduplication and overflow. The two UI files
last visible before the previous full-suite stall pass independently: 36 tests.
The full rerun with a temporary file-level progress reporter passed all 480
files: 7,586 tests passed and six existing skips. The earlier stall was not
reproduced; no UI or test-runner code fix is claimed. The reporter is a local
diagnostic artifact and does not change the checked-in test configuration.
The populated-source profile reached bounded continuation on the approved
dedicated instance: rollback queue verification 13,505 ms; one real worker
delivery 54,234 ms; 30 actual reversal rows, with the job safely pending again
and no failure/dead-letter result. Independent proof verified the exact net
balance `(50000 - 30) * 9007199254740993` and 50,030 ledger rows. This fixture
contains 49,999 synthetically seeded commits and only one real initial commit;
it is not full 50,000-row execution acceptance. The delivery's 30-second target
is a soft budget checked between transaction groups, not a hard worker duration
limit; each transaction retains its existing 30-second deadline. The profile
completed with exit 0, all 157 tables independently empty and its temporary grant
revoked. The complete 500-row real-worker test also passed: 11 deliveries per
phase, 64,014 ms for commit and 29,863 ms for rollback; independent proof verified
all 1,000 ledger entries and zero remaining import balance. Together with the
ordinary regressions, 43 MySQL tests passed (four opt-in skips). All 157 tables
were independently empty afterward and temporary access was revoked.

Final verification passed: web/Shopify typechecks, all ten root lint tasks,
Prisma validation, changed-file formatting, 32 Shopify tests, and both production
builds (web: 367 static pages). The web build used temporary SELECT-only access
to the empty dedicated fixture; all 157 tables remained empty and the grant was
revoked afterward. The dedicated server was stopped without an OOM event; its
empty volume is retained, and shared services remain unchanged.
Independent final review found no code, secret or scope
blocker. The checkpoint remains draft, not a merge or deployment authorization;
shared-schema, authenticated merchant and full real-worker scale gates remain.

## Earlier September 12 scale continuation — historical local checkpoint

The accepted ADR 0024 grouped rollback checkpoint was copied into the separate
compatibility worktree on top of `ed1bf07c98`; the original checkout was not
modified. All 42 ordinary MySQL source cases (including three new adversarial
group cases) and 13 deterministic batch-budget cases passed. The ownership-change
case uses a valid replacement lease UUID so it exercises stale ownership rather
than malformed-record rejection. Operation-only timing instrumentation is local;
it measures Prisma model calls, not raw SQL or CPU-only proof work. No new code was
pushed and PR #13 remains at its previously verified compatibility checkpoint.

A new schema-only fixture, `weletic_loyalty_it_import_scale_20260912`, began with
157 empty tables. The populated profile created synthetic evidence for 50,000
committed rows (only the first was committed by the real row handler). The run
failed during the full execution-record read before rollback queue creation or
group execution. Docker reported `OOMKilled=true` with a 805,306,368-byte
(768 MiB) container limit. This was a server-memory failure, **not** a successful
throughput measurement or a reproduced transaction-deadline result. Timings
before failure: snapshot read 2,337 ms; failed execution read 7,653 ms. No SQL,
query parameters, customer identifiers or source rows were included in the
normalized timing report.

The server failure also interrupted automatic fixture cleanup and grant
revocation. The previously running container was restarted without changing its
resource limits; its server UUID was rechecked and it returned to healthy status.
The exact disposable fixture database was dropped and its temporary DML grant
revoked, both independently verified. Existing development/legacy databases were
retained. No application service, live Shopify operation or deployment ran.

Hiro approved a separate disposable MySQL instance under
[ADR 0030](../adr/0030-disposable-import-load-database.md). It uses a dedicated
2 GiB memory budget, loopback port 3308, fresh credentials and a separate volume,
leaving the existing instance unchanged. The generated fixture
`weletic_loyalty_it_import_dedicated_20260912` contained 157 empty tables before
and after the 42-case regression run; temporary DML privileges were revoked.
The first dedicated populated profile avoided OOM but failed queue creation when
the existing 30-second transaction expired during owner verification. Model-call
timings: snapshots 6,798 ms, executions 18,386 ms, first 20 shopper batches 4,060 ms.
The 120-second cleanup hook also expired; independent SQL rejected the nonempty
fixture and the temporary DML grant was revoked. Only that disposable synthetic
schema was removed and regenerated on the identity-verified dedicated instance.
The profile's cleanup-only hook now has a 300-second allowance, outside the
measured workload; application transaction and delivery deadlines are unchanged.

Query-only improvements are local and independently reviewed: project only
execution/owner evidence fields and split ledger ID/reference lookup paths while
retaining global orphan discovery, fresh full proof, transaction fences,
deduplication and cumulative source-wide overflow checks. All 35 focused
reconciliation/batch-budget tests pass, including global reference-only foreign
evidence, cross-path overflow, deduplication and projection contracts. The
comparison profile still failed before rollback queue creation: snapshot reads
5,799 ms, projected execution reads 5,025 ms, 50 owner batches 6,950 ms and the
first two ledger operations 10,993 ms. The narrower execution projection reduced
that operation's observed duration, but the overall 30-second proof gate remains
unpassed. These are operation-only measurements on a shared development host,
not controlled production benchmarks. Never remove proofs or extend application
deadlines merely to obtain a passing scale result.

Final local verification: all 42 ordinary MySQL source cases passed again after
the query changes; all 157 fixture tables were independently empty afterward and
temporary DML access was revoked. Both dedicated profiles kept the server alive
without OOM. The comparison profile's longer cleanup-only allowance completed
successfully. Web typechecking (including a final rerun), Shopify typechecking,
all ten lint tasks, Prisma validation, changed-file formatting, 32 Shopify unit
tests and the Shopify build passed. The full web suite stalled with idle workers
and no terminal summary; it was deliberately interrupted (exit 130), not passed.
The web production build was not rerun for this local checkpoint. No new commit,
push, merge, shared-schema application or deployment was performed.
The dedicated container was stopped after cleanup as required by ADR 0030;
its empty volume and private local credential files are retained for reproducibility.
The original dirty import checkout and existing port-3307 instance were unchanged
during this dedicated-instance execution.

Next: profile the remaining global ledger discovery and ownership-query costs
without exposing row data; retain all orphan/foreign-write discovery and fresh
transactional proof. Isolate the full web suite stall independently before
publication. Rerun ordinary regressions, populated-source verification, full web
tests and the web build after any correction. Full 50,000-row real-worker
commit/rollback, authenticated merchant journeys and shared rollout remain open.

Status: implementation in progress, 2026-09-09. The three import tables have been
approved and created only in isolated local MySQL. Both opt-in database suites
pass (39 regular source cases and nine ledger cases after bounded rollback grouping;
historical opt-in load checkpoints are qualified below). Byte-derived inspection/staging
persistence and commit/rollback orchestration are covered locally; authenticated
browser journeys and live merchant acceptance remain unproven. Nothing is deployed
to Shopify.

## Draft review and release gates

September 12 compatibility checkpoint: see the
[schema release gate](historical-import-schema-release-gate.md). The published
import checkpoint was integrated with public main `cfd241e62c` in a separate
worktree; original unpublished grouped-rollback changes were not included.
Both communication and import job families retain strict payload/generation and
ownership checks. Full delivery claims are projected into the import-specific
strict claim shape; rollback to no VIP tier cannot produce achievement messages.
The read-only schema audit and additive enum planner do not authorize shared DDL
or remove the draft release gate below.

Fresh isolated fixture `weletic_loyalty_it_import_compat_20260912` was generated
from the combined Prisma schema. The real audit passed the baseline/restored
schema and rejected each missing import table, an extra required column, an extra
unique constraint, the wrong opening-balance type, and a non-null rollback tier
destination. All 157 tables were independently verified empty before and after;
temporary SELECT-only access was revoked. No existing database schema was changed.
An attempted MyISAM fixture conversion was rejected by MySQL before that negative
audit could run; wrong-engine/view rejection is covered by unit tests, not claimed
as a live MyISAM conversion result. This is metadata compatibility evidence, not
full financial execution or live privacy acceptance.

Compatibility verification: 480 web test files, 7,569 tests passed, six existing
skips; web and Shopify typechecks; all ten root lint tasks; 32 Shopify tests;
Prisma validation; both production builds (web: 367 static pages); all changed
TypeScript/Markdown formatting. The build used the same empty fixture with
temporary SELECT-only access and verified cleanup. The initial high-parallelism run missed two existing wall-clock
performance thresholds; the complete rerun with two workers passed without
changing those assertions. Web typechecking required an 8 GiB Node heap after the
default-heap run exhausted memory. Independent review found and verified fixes
for strict-claim projection, no-tier VIP messages, and restrictive schema drift.

This implementation is a draft review checkpoint, not a merge or release candidate.
Existing privacy export and erasure workflows now query the three import tables
even when no import has been used. Deploying against an unprepared database would
break those workflows. Shared-environment schema compatibility must be explicitly
approved, applied and verified before this change can be merged or released;
the isolated database approvals below do not authorize that rollout.

Authenticated maximum-size upload/staging and full 50,000-row commit/rollback
remain unverified. The maximum-size isolated preparation checkpoint below
reproduced and corrected the default transaction deadline failure. Preparation
and reconciliation now have bounded 30-second transactions, 35-second gateway
deadlines and 40-second browser deadlines. Context/status/history retain their
short gateway deadlines. The isolated preparation, pending-manifest and 500-row
worker measurements do not prove authenticated HTTP paths or performance against
a populated production ledger. A source-specific
ledger metadata lookup is not indexed; retain the orphan-discovery safety checks
while evaluating load. No live acceptance checkbox is satisfied by this checkpoint.

### Maximum-size preparation deadline correction

After publishing draft PR #13, an opt-in real MySQL test used 50,000 existing
synthetic shoppers and a valid JSON source padded with whitespace to exactly
10 MiB. Inspection failed under the merchant route's default five-second Prisma
transaction timeout, before any source or financial write. The test also exposed
MySQL's prepared-statement placeholder ceiling in bulk fixture deletion. The
exact failed fixture was recovered with bounded shopper deletes; the suite now
uses fixture-scoped batches of 500 and a bounded 120-second cleanup hook.

With the shared 30-second transaction limit, inspection completed in 11,951 ms
and staging in 18,706 ms. One maximum-size test passed (32 unrelated cases skipped).
The database contained all 50,000 snapshots, and no row executions, ledger entries,
loyalty accounts or outbox jobs for the fixture. Cleanup completed; an independent
read-only check found zero source-suite fixtures across ten affected models.

Preparation and reconciliation transport deadlines now preserve headroom around
that transaction budget, matching the existing execution deadline pattern.
Eleven new regression cases verify long-operation gateway deadlines, unchanged
short reads, and browser cancellation at 40 seconds without retries. The focused
transport selection passes 106 cases. Independent review found no actionable
blocker. This is real byte-derived persistence plus isolated transport-contract
evidence, not authenticated HTTP/browser throughput, privacy live acceptance,
full-source commit/rollback, or a shared-schema rollout approval.

### Maximum-source worker continuation diagnostic

A separate opt-in real MySQL test exercised two actual outbox deliveries against
a 50,000-row source. Each delivery committed 50 rows, taking 8,101 ms and 7,725 ms.
Between deliveries, the real continuation returned the same job to `pending`
with zero attempts and cleared ownership; no manual rescheduling or lease reset
was used after initial fixture eligibility. The source remained `committing`.
Independent whole-source proof reconciled exactly 100 opening entries and the
exact BigInt total, while explicitly reporting `fullyCommitted: false`.

The diagnostic passed (33 unrelated source cases skipped). Shopper seeding is
now batched in groups of 1,000 to stay below driver parameter limits. Exact fixture
cleanup completed, and independent read-only counts were zero across ten affected
models. Web typechecking, focused lint and independent review passed.

This does not establish the remaining 49,900 commits, finalization, or rollback
performance on a fully populated 50,000-row source. At that checkpoint rollback rechecked
whole-source evidence in each row transaction. Moving that proof to claim and
finalization alone would weaken detection between row transactions; do not do so
as a performance shortcut. Measure a populated rollback fixture before choosing
an optimization, retaining foreign-entry and orphan discovery. A multi-row locked
transaction changes contention and containment granularity; the subsequent
explicit approval is recorded in ADR 0024 below.

### Populated rollback profile and bounded worker scheduling

A synthetic committed fixture was built from one actual row execution, rewriting
every shopper/account/snapshot/ledger identity and field-state binding for the
remaining 49,999 rows. This is a populated performance fixture, **not evidence of
50,000 commits through the worker**. Real full-source verification accepted it.
An initial direct rollback profile took 24,612 ms to claim and 25,605 ms for one
atomic correction. At that observed per-row cost, a fixed 50-row delivery risks
exceeding the default five-minute outbox claim window. Extrapolation also suggests
a full rollback could take days; no full-run duration has been measured.

At this checkpoint commit and rollback batches retained the row-count cap and added a monotonic
30-second soft time target checked between rows. The first row is attempted even
if selection consumes the target. No in-flight row is interrupted; failures and
containment retain their original behavior. This is not a hard 30-second delivery
deadline: recovery, selection, the last atomic row and durable continuation add
time. Every existing full-source proof, lease and ownership check remains intact.

The populated test then queued rollback and used the actual outbox worker. Queue
creation took 26,236 ms; one delivery took 62,759 ms and corrected two rows. The
same job returned to `pending`, with zero attempts and cleared ownership. Independent
whole-source proof reconciled 50,002 ledger entries and exactly 49,998 opening
balances remaining, with `fullyRolledBack: false`. The test passed (34 unrelated
cases skipped). Faster machines may reach the row cap before the soft target;
fake-clock tests prove the scheduling rule without a wall-clock performance claim.

Fixture cleanup completed in bounded account/shopper batches. Independent read-only
checks found zero source-suite fixtures across ten affected models. The focused
suite passes 854 tests, including nine deterministic batch-budget cases and
short-progress continuation cases for both worker phases. Independent review
found no production blocker. The 50,000-row throughput gate remains open.

Reducing full-source proof frequency across separate transactions remains
prohibited. Hiro subsequently approved bounded multi-row transactions with
changed group failure/containment granularity; see
[ADR 0024](../adr/0024-bounded-import-rollback-transactions.md).

### Approved bounded rollback groups

Rollback now groups at most ten rows in one fresh repeatable-read transaction.
One full-source proof is retained under store/program/source/queue locks, and
each row keeps its execution/account, field ownership and ledger checks. A final
database-time lease check aborts the entire group if ownership has expired.
Proof never crosses transaction boundaries. A late conflict aborts every row in
that group before a separate same-lease transaction contains the conflicting row
and source. Earlier committed groups remain durable.

The delivery row cap and soft 30-second target still apply, now between atomic
rollback groups. The 30-second transaction timeout remains unchanged. This is
not a schema change or permission to merge/deploy. The previous populated-source
timings above describe single-row transactions, not this grouped implementation.
The isolated source suite passes 39 regular cases (five load cases skipped),
including ten-row correction/replay, mixed replay/new work, exactly one proof per
group, final database-time lease expiry, late field/ledger containment and a
second-row SQL failure that aborts the first row and permits retry. Stale
installation and altered-source evidence fail closed. Nine isolated ledger cases
also pass. Initial new fixture failures were missing shoppers beyond the first
row; fixture seeding was corrected without changing application safety checks.
Independent review found no blocking implementation or test issue.

The broader import/outbox/Flow/staff unit selection passes 942 tests in 55 files
with two workers. Web typechecking passes with the existing CI's 8 GiB heap
setting; focused lint, Prisma validation, formatting, Shopify typechecking and
both production builds pass. The initial default-heap TypeScript run exhausted
4 GiB, and an over-parallelized unit run had worker-start errors; neither failed
run is counted as a pass. Lower-concurrency verification completed cleanly.

The populated 50,000-row profile did **not** pass after this change. Initial
rollback queue creation exhausted the existing 30,000 ms transaction budget
(Prisma reported 30,046 ms) while reading full-source ledger evidence, before
the grouped rollback worker ran. There is no new grouped-throughput measurement.
This exposes insufficient headroom in the existing full-source verifier; smaller
rollback groups cannot fix a timeout that occurs before group execution.

Exact fixture cleanup completed, followed by independent zero-count checks
across ten affected models. The grouping follow-up remains local and uncommitted;
published draft PR #13 still points to `b13eb922976f420cb67d58d2d4a8de38609ea0e8`,
whose public Fast Quality Gate passed. No schema, deadline or integrity check was
relaxed, and nothing was deployed. Further full-source query profiling and
optimization is the next proposed work item, pending Hiro's direction after this
verification failure. Full-scale and authenticated/live acceptance remain open.

## Approved isolated database execution

After verifying `weletic_loyalty_dev` and principal `loyalty_dev@%` at
`127.0.0.1:3307`, execution created only the three allowlisted import tables.
The reviewed generated DDL SHA-256 is
`c3a4017125ca45d444767bafdc7e3a3c0e04ea07b657af7714303b5a64c1a547`.
No existing tables were altered. See [ADR 0021](../adr/0021-isolated-loyalty-import-tables.md).

The source suite passed 35 cases across normal and opt-in load runs, including atomic rollback, actual outbox dispatch, competing claims and recovery,
exact >safe-integer opening balance, concurrent row replay, source finalization,
stale installation rejection and cross-store snapshot rejection. The accounting
suite passed all nine cases, including append-only correction, later-activity
containment, competing writes and rollback, current closure observation and
transaction abort. These are real isolated MySQL results, not `yamaxdev` evidence.

Both suites cleaned their generated fixtures. Independent read-only checks found
zero rows in each new table and zero stores with either integration-suite prefix.
Remaining authenticated upload, privacy, load/query-plan and
live acceptance gates are not satisfied by these tests. Earlier pending-schema
statements below are historical and superseded for this isolated database only.

### Final row-insert failure atomicity

The tenth source database test forces an actual MySQL duplicate-key failure at
the final row-execution insert, after the real enrollment, birthday scheduling,
field update and opening-balance ledger operations. Only execution-ID generation
is overridden; no financial or database mutation is mocked. The duplicate ID
belongs to a separately committed fixture, which remains unchanged.

The test observes `P2002`, then independently finds no account, ledger, birthday
outbox, earn grant or execution record for the failed row. Source lease/state
is unchanged. Retrying under that same lease succeeds with one account, ledger,
execution record and birthday job. All ten source tests passed; subsequent
read-only counts across ten affected tables found zero source-suite fixtures.
Full-web typechecking and focused lint/format pass. Independent review found no
actionable issue. This proves transaction abort and retry, not user-requested
append-only rollback orchestration, tier rollback or live-store acceptance.

This document records incremental checkpoints; later sections supersede earlier
implementation counts and diagnoses. Current verification: 854 focused
import/outbox/staff-client tests, Prisma validation, focused lint, web/Shopify
typechecking and both web and Shopify production builds pass.
Installed source/ledger table tests are verified as above; authenticated browser
journeys, maximum-source load and live acceptance are not yet proven.
The latest non-parallel full unit suite passes: 406 files, 6,334 tests passed
and six skipped. Earlier parallel runs failed only the simulated profile timing
benchmark. See the cross-app typecheck
diagnosis below for the resolved import-related React augmentation issue.

## Real inspection/staging persistence checkpoint

The source suite now runs the real byte-derived inspection and staging services
against isolated MySQL, without mocked preview, locks or persistence. Inspection
returns the revision submitted to staging and creates no source. Two simultaneous
stage attempts produce one success and one domain conflict; the winner retains
the original file SHA, staff/generation, exact opening balance and birthday row.
No loyalty account, ledger entry, outbox job or execution record is created.
A later duplicate upload leaves both persisted records unchanged.

A second case forces an actual snapshot primary-key collision after source
creation. The transaction leaves no partial source/snapshot or financial effects,
preserves the other fixture's snapshot and accepts the unchanged upload on retry.
All 12 source tests pass. These direct persistence calls do not establish signed
merchant authorization, the caller's store/session lifecycle lock, HTTP upload,
full-file load performance or live acceptance.

## Approved isolated job types and no-tier history

Hiro approved [ADR 0023](../adr/0023-durable-import-jobs-and-no-tier-rollback.md)
on 2026-09-09. The reviewed local DDL appended `HISTORICAL_IMPORT_COMMIT` and
`HISTORICAL_IMPORT_ROLLBACK` and made the tier-history destination nullable.
It preserved all previous enum values/ordinals, including the existing local-only
`REVIEW_POINTS_FULFILL` value. No full-schema push or unrelated schema cleanup ran.
DDL SHA-256: `39d2df803317aa148b48771e45f3036d8ccb42120c260c6bcb8d588d6f0b09fd`.
The guarded [local script](../../apps/web/scripts/dev/apply-loyalty-import-execution-schema.ts)
verified `127.0.0.1:3307`, `weletic_loyalty_dev` and `loyalty_dev@%` before both
ALTERs and verified schema readback afterward. MySQL DDL is not transactional;
the script recognizes either already-applied statement without reordering enums.

Payload contracts reject raw files, shopper identities, private lease material,
invalid revisions and missing generations. Existing merchant, customer-account,
event-time earning and backfill consumers now permit a true null destination.
The new destination labels cover EN/JA/VI; this is not full extension localization.
Independent review found no actionable blocker; 167 focused tests, web/Shopify
typechecks and focused lint passed. The 13 source and nine ledger MySQL cases
passed, including cancelled job enum fixtures and null relation readback.
Independent source-fixture cleanup checks returned zero rows across 12 affected
models. This is schema/contract evidence, not append-only rollback execution or
durable worker dispatch. Those remain unfinished and inactive. No shared or
production database, Shopify deployment, email delivery or worker activation ran.

## Merchant screen checkpoint

A local `/loyalty-imports` page now obtains authenticated store/generation context
and configure capability before enabling upload. Its EN/JA/VI controls connect
file preparation, preview and staging, with paginated 20-row summaries and no
rendered shopper IDs or filenames. It explicitly states that point commit is not
available. File/format changes clear previews; busy guards suppress duplicate
requests; unmount epochs discard stale responses; uncertain staging clears the
one-click retry path. Permission and loading/error states fail closed.
Screen tests cover those boundaries and localized controls. Shopify type-check
and production build pass (existing Vite/Remix/sourcemap warnings remain).
Real 375px/keyboard/accessibility and authenticated-store browser acceptance are
still required. No import schema or app deployment has occurred.

## Staged persistence shape and read-only preview

Three new Prisma models are staged: source identity/progress, immutable imported
row snapshots and separate row execution evidence. The source holds both digests,
format/version, installation generation, revision and lease state. Aggregate
opening balance uses Decimal(30,0), since the sum of valid BIGINT rows can exceed
a single BIGINT. Snapshot uniqueness covers source row position and customer;
execution holds ledger/reversal IDs and before/after field and ledger-version
evidence for contained rollback. No raw upload bytes or filename is persisted.

Prisma validation passes with existing relation-mode warnings. This is a draft
schema, not a migration result. Runtime persistence, privacy export/erasure and
retention coverage must be implemented before activation. Like existing standalone
backfill evidence tables, these models require explicit tenant/owner checks and
cleanup; the schema alone supplies neither authorization nor immutability.

The read-only preview helper consumes an already authenticated transaction. It
verifies the program's store, resolves store-owned shoppers, checks retained owner
and identity tombstones, rejects unavailable accounts and deleted/foreign tiers,
and projects exact additive opening balances with resulting BIGINT overflow checks.
Only row positions, issue codes and balance projections are returned. A known
shopper without an account is marked for future enrollment, never enrolled during
preview. Unresolved customers remain unavailable until authoritative identity
resolution exists; no email-based identity guessing is used.
Numeric webhook IDs and GraphQL customer GIDs are resolved within the store;
if both records exist, preview fails closed instead of choosing a wallet.

The helper does not enforce the installation/revision values or authorize an
import. Those belong to the upcoming authenticated gateway and commit transaction.
Source parsing must precede preview; browser-supplied row lists are not trusted
provenance. Birthday/tier application and conflict previews remain unfinished.
Current focused evidence before integrity additions: 66 tests across contracts, source parsing, staging and mocked
read-only preview. No database race or live acceptance claim is made.

Source staging derives snapshots from verified bytes, rejects duplicate uploads
without replacing provenance, checks generation/revision and validates every row
before persistence. The caller must hold authenticated store/session authority in
one transaction; the service locks the active program. Source and row writes are
chunked, with exact insertion-count checks. No account or ledger writer is called.
Caller rollback, installation races and privacy cleanup still need real DB proof.

An authenticated transaction-local inspection step now derives a full-file preview
and initial staging revision from the same verified bytes. It rejects stale
installation generations and existing source provenance, preserves global row
numbers across 1,000-row preview batches, and performs no persistence or wallet
writes. Three added tests cover revision handoff to staging, batch numbering and
stale-generation rejection; all 163 focused import tests pass. Independent review
found no blockers. The preview's valid flag covers existing customer/account/tier
availability and balance checks only, not full birthday/tier commit readiness.
Merchant UI is implemented locally but not browser-accepted. The backend preparation transport is described
below; real authenticated upload acceptance remains outstanding.

## Signed preparation transport

The internal merchant imports POST endpoint accepts only inspection or staging.
The complete JSON actor, operation and canonical base64 upload are covered by the
existing service signature. Encoded-body and decoded-file limits are enforced
before the transaction. The adapter requires loyalty.configure, derives store,
staff and installation generation from merchant authorization, checks project
binding and operational eligibility, then calls the byte-derived services in the
same Repeatable Read transaction. No commit operation or wallet writer is exposed.
Errors are sanitized and requests are not automatically retried.

The latest focused import/compliance run passes 252 tests across thirteen files.
The preceding full web unit run passed 5,755 tests with six skipped across 374
files; that run started before the new gateway/route files, which have separate
focused coverage. New-table database verification and maximum-upload latency
under the transaction limit remain unproven. This endpoint is not deployed.

The Shopify app now has a matching POST action using the existing session-token
merchant authenticator and signing client. Browser input cannot inject an actor;
the action bounds the upload and verifies backend acknowledgement scope, generation,
source digest, row numbering/count and preview consistency before returning it.
Shared upload and response contracts contain no server-only imports. Staging
acknowledgements must advance revision and cannot claim balances were committed.
Response review additionally required staging acknowledgements to include the
byte-derived source descriptor and previews to enforce canonical signed-64-bit
balances, permitted nonnegative opening deltas and exact aggregate arithmetic.
Regression tests cover wrong-file staging and contradictory financial previews.
All 199 focused import tests pass; web and Shopify TypeScript checks pass.
The browser import client now uses fresh session tokens, omits cookies/cache,
validates strict upload/response contracts and checks the expected store binding.
It never automatically retries a stage request or stores tokens/upload contents.
Eight focused client tests and Shopify type-check pass. The merchant upload
screen's real browser acceptance remains outstanding.

Browser file preparation now reads the selected file once, validates declared and
actual byte lengths, calculates SHA-256 with Web Crypto and base64-encodes bounded
blocks without spreading an entire file onto the call stack. It returns no
filename and does not parse or render shopper rows. Nine tests prove exact bytes
and hashes across block/padding boundaries, pre-read size rejection and actual
size checks; Shopify type-check passes. It is not yet wired into an upload screen.

Review found per-row preview lookups would scale poorly under tenant locks.
Preview now batches shopper and tombstone reads. A full 1,000-row unit fixture
asserts four Prisma delegate reads (program, tiers, shoppers, tombstones); the
shopper relation include can require another underlying SQL read. This is a
query-count improvement, not a production latency or maximum-file DB benchmark.

Stored snapshot integrity now uses the upload parser's canonical row proof.
The reader first checks source ownership, then loads a bounded source row set
and rejects missing/extra rows, incorrect row order, duplicate snapshot/customer
identity, foreign store/program/source references, privacy-redacted rows and
altered birthday/tier/balance values. Normalized digest and aggregate balance
must match exactly. Errors do not reveal stored row content. Source-byte digest
syntax is checked, but the original file cannot be reverified without retained
bytes; no such claim is made. This verifier is not lifecycle authorization and
is not yet wired into a balance commit. Independent review found no blocking issue.

## Opening-balance posting primitive

A transaction-local financial primitive now locks the account and checks the
resolved shopper, active/redaction state, ledger version and resulting balance.
It posts `MANUAL_ADJUSTMENT` with the explicit
`LOYALTY_IMPORT_OPENING_BALANCE` reference and source/snapshot/digest provenance.
It creates no earn grant and calls no signup, referral or tier reward producer.
The actual lifetime-earned policy is included in focused tests and confirms zero
qualifying earned points for this entry. Zero opening balances retain a ledger
record without qualifying activity.

This is not an exposed commit workflow. Its caller must authorize staff, hold
store/program/source locks, reverify snapshots/privacy and atomically persist row
execution plus birthday/tier changes. The existing generic ledger primitive does
not enforce its optional `expectedLedgerVersion` parameter, so this import helper
checks version under its own account row lock instead of relying on that option.
Commit orchestration, contained rollback, expiry-state restoration rules and
independent reconciliation remain unfinished. Current focused suite: 125 tests
across seven files, including mocked posting; isolated real-ledger evidence is below.
Review found that a post-lock consistent read could still observe stale active
status after privacy closure. The locking SELECT now returns all account
eligibility/version/balance fields directly. A mocked stale-active/current-closed
test proves the helper uses that result; isolated MySQL evidence is recorded below.

## Isolated MySQL ledger evidence

Nine tests in `vitest.historical-import-db.config.ts` passed on 2026-09-09 using
the existing isolated development database, without applying the import schema.
The suite requires an explicit opt-in, exact loopback host/port/database/user and
verified server database/principal before mutation. Unique fixture stores are
created and exact ledger/account/shopper/program/store cleanup runs afterward.
External fetch is forbidden. Independent review cleared this guard and scope.

- Actual ledger posting preserves the integer balance above JavaScript's safe
  integer range, leaves lifetime-earned and pending points at zero, and creates
  no earn grant or outbox event.
- Two competing writes from one account version produce one ledger entry and one
  expected revision conflict, not two opening-balance credits.
- A Repeatable Read transaction first observes an active account. Another
  connection commits closure without changing ledger version. The original
  transaction still observes stale active state through its ordinary read, but
  the helper's current locking read rejects posting. No ledger entry is created.
- A forced enclosing transaction failure rolls back both the actual ledger
  entry and cached account balance/version.
- An account selected through another store fails without a ledger write.
- Financial rollback appends an exact manual correction and retains the original
  opening-balance entry; balance returns to its prior value without earned points.
- Later account activity blocks automatic reversal and preserves the later balance.
- Two concurrent reversal attempts produce one correction and one containment
  error, never two debits.
- A composed transaction checks current locked field state, appends correction,
  restores birthday/expiry fields and preserves unrelated newer metadata. The
  captured owned fields match the pre-import state afterward.

The reversal helper checks current locked account eligibility/version/balance and
the original entry's type, reference, amount, pending delta, grant absence and
source/snapshot/digest metadata. It accepts only the original posting sequence as
the current version; any intervening ledger event requires containment. It does
not delete ledger history. Independent review cleared this financial-only scope.

This proves the financial primitive and the specific closure-field interleaving.
It does not run the full privacy closure service, authenticated merchant gateway,
installation fencing, staged-source tables, birthday/tier mutation or complete
import commit/rollback. Those remain required. Test credentials are read only
from the existing local secret file and are never stored in this repository.
In particular, the generic ledger updates the expiry activity clock for a nonzero
correction. The upcoming full rollback transaction must check and restore the
saved expiry/birthday/tier field state atomically with the correction, or contain
the operation when those fields changed. The financial helper alone is not a
complete rollback API and must not be exposed as one.

## Birthday and field-state planning

The field-state helper captures tenant/account identity, birthday presence/value,
tier and expiry fields only. It refuses restoration if current owned fields no
longer equal the applied snapshot and merges restored birthday into current
metadata rather than replacing other modules' data. Absent birthday and explicit
null are distinct. Equality does not detect change-and-revert history; full
orchestration must additionally check ledger, tier history and program policy
generations under current locks. Privacy cleanup must include these snapshots.

Birthday planning follows the existing customer birthday route's year-2000
month/day anchor. Matching registrations retain their age and reward markers,
conflicts fail instead of overwriting locked birthdays, and new registrations
use the existing 30-day lead-time schedule. The helper returns a future schedule
but does not enqueue or award anything. Commit integration still must schedule
the normal future birthday journey idempotently, without retrospective rewards.

## Reconciliation increment and pending tier-history decision

An independent pure checker compares complete scoped ledger evidence with verified
source/execution rows. It detects missing, extra, reused or mismatched entries,
validates opening/reversal references and provenance, and computes exact imported,
reversed and net totals. `reconciled` is deliberately separate from
`fullyCommitted`/`fullyRolledBack`; pending rows cannot establish completion.
Nine focused cases pass. The existing isolated rollback fixture also feeds its
actual SQL ledger selection through this checker. Source-row completeness,
account-cache reconciliation and authenticated selection still require service
integration; the pure checker cannot prove omitted input exists.

Tier rollback to an originally tierless account exposed a required decision:
existing tier history and its merchant contract require a non-null destination.
Restoring only the account pointer would leave incorrect event-time tier history.
Approval has been requested to support an explicit null destination and update
consumers/tests. No such schema or API change has been made while awaiting the
answer. This does not authorize shared schema application or deployment.

The transaction-local reconciliation reader now verifies stored source snapshots,
execution membership and account/customer ownership before selecting ledger
evidence. Discovery includes exact source metadata, snapshot references and claimed
entry IDs, including foreign-store stray writes; no customer or ledger identifiers
are returned. Queries use bounded 1,000-ID chunks and reject excess evidence.
Source lifecycle state additionally gates completion flags. Review identified and
prompted fixes for missing wrong-wallet checks and store-filtered orphan discovery;
regression tests cover both. This reader still requires an authenticated caller
and a repeatable-read transaction. New-table database verification, merchant
integration and account-cache reconciliation remain outstanding.
Foreign-store ledger evidence raises a generic integrity error before totals are
computed, preventing cross-store financial disclosure through failed summaries.
Follow-up review cleared the fixes. All 148 focused import tests across nine files
pass; web type-check and focused reconciliation lint/format checks also pass.
These are local implementation checks, not schema or live acceptance evidence.

## Privacy export integration

The durable compliance worker now includes import snapshot and execution export
phases before its manifest. Snapshot selection resolves the store-owned shopper
and handles numeric/GID customer identities without requiring enrollment. Execution
selection uses the durable store/account owner. Both use the existing 100-record
encrypted-artifact pagination and retention path. Explicit projections include
the customer's imported birthday/balance/tier and rollback field evidence, but
exclude source-wide totals, uploader identity, file digests and worker controls.
Independent review found no blockers in this export increment. The combined
import/compliance suites pass 216 tests across ten files; web type-check and
focused compliance lint also pass.

Complete customer/shop erasure verification and new-table database verification
are still required. This code must not deploy
before its tables exist; export coverage does not authorize schema application or
establish full privacy compliance.

Customer erasure now invokes a bounded import cleanup under the existing store
lock and compliance mutation lease before backfill cleanup. It marks affected
sources contained, increments revisions and clears leases before scrubbing row
customer identity, birthday and tier fields plus execution field-state JSON.
The account and ledger audit linkage remains; no ledger entry or balance is
modified. Each call selects at most 100 identity snapshots and 100 executions,
then follows at most 100 additional execution-linked snapshots for account-only
subjects. Those linked rows are scrubbed before execution completion, so retries
cannot lose that privacy path. Already scrubbed rows are excluded on later calls.
This remains local code with mocked privacy tests: real new-table transaction
races and final customer retention/purge handling are outstanding.
Shop-wide redaction now drains import executions, snapshots and source provenance
in separate 100-record batches before backfill cleanup. It requires a frozen
store under the compliance mutation lease, repeats exact store/ID predicates on
deletion and rejects affected-count mismatches. Ledger tables are untouched.
Independent review cleared this increment. The combined import/compliance suites
now pass 230 tests across eleven files; web type-check and focused lint pass.
Real database purge/race evidence and customer-record retention policy enforcement
remain outstanding.

## Contract increment

The strict preview input accepts a bounded batch of Shopify customer GIDs,
canonical nonnegative decimal opening balances, optional month/day birthdays and
optional tier IDs. It requires installation generation, revision and source
SHA-256/format. Duplicate customers and unknown fields are rejected. Precision is
preserved beyond JavaScript's safe integer range, up to signed MySQL BIGINT.
February 29 is valid without collecting birth year.

The 1,000-row bound is a request batching limit, not a total migration limit.
The eventual upload workflow must split larger files into durable, resumable
batches without losing source identity or accepting duplicate customer rows
across batches. Schema parsing does not authorize a tenant, prove a customer's
existence, validate tier ownership or verify an uploaded file's digest.

## Accounting constraints confirmed from source

- Existing order backfill reconstructs order earns; it is not this workflow.
- `BACKFILL` counts toward lifetime-earned points. It must not be used for
  opening balances, which must not fabricate historical earning or VIP progress.
- The ledger supports explicit references and immutable append-only corrections.
  A commit must preserve opening-balance provenance and must not emit signup,
  referral, historical earn, coupon or tier-entry reward events.
- Balance range validation on input is insufficient: commit must validate the
  resulting account balance under its write fence.

## Import context verification (2026-09-09)

The import screen now bootstraps through the signed import context operation,
authorized with `loyalty.configure`, exactly like preparation. It no longer
depends on `settings.configure` or `loyalty.read`: staff permission grants do not
implicitly include other grants. Context resolves the store and installation
generation from the authenticated actor and preserves project binding and the
operational fence. It does not inspect or stage a source.

Regression coverage includes signed context routing, rejection of unsigned or
scope-injected requests, strict context responses, fresh browser tokens, and
no automatic retries. All 234 focused import tests across 17 files pass, and
the Shopify app TypeScript check passes after sharing the merchant request
schema rather than importing an undeclared dependency. Independent review found
the permission mismatch resolved with no new critical findings in this fix.
Live authorization acceptance is still outstanding.

The full web production build failed during type validation at the unchanged
`impersonate-user.tsx` admin component: its `variant="danger"` is incompatible
with the resolved Button type. This is not a successful full-build result;
That initial classification was incorrect: the cross-app typecheck diagnosis
below identifies and fixes an import-test dependency as the cause. The failed
build itself remains historical evidence, not a passing build result.

Deployment ordering is mandatory: the modified existing compliance worker reads
the new import tables even when no imports have run. Do not deploy this branch
before the reviewed schema has been approved and applied. No schema application
or deployment was performed for these checks.

## Birthday conflict preview verification (2026-09-09)

Preview now reuses the birthday planner after customer, account and tier
eligibility checks. Conflicting or malformed registrations return the generic
`birthday_conflict` issue with no birthday values or balance projection.
Unavailable owners do not receive birthday diagnostics. Matching registrations
retain their registration age and reward markers; omitted birthday inputs are
untouched. Preview discards all planned metadata and schedules without writing
or enqueueing anything.

The shared response contract and EN/JA/VI screen support this issue. Tests prove
staging remains disabled and the staging service refuses persistence for an
invalid preview. All 248 focused import tests across 17 files and the Shopify
TypeScript check pass. Independent review found no actionable issues in this
increment. These are local tests, not live or new-schema database acceptance.
Commit must repeat birthday validation under its write fences; a successful
preview never authorizes overwriting a later registration.

## Source status lookup verification (2026-09-09)

The signed merchant imports endpoint now accepts a strict `status` request with
`sourceId` and `expectedInstallationGeneration`, without source upload bytes.
It requires the same `loyalty.configure` permission as preparation and checks
the current actor, project and operational lifecycle before accessing a source.
Source lookup includes the authenticated store, and the source's program must
also belong to that store. Missing and foreign sources fail closed.

The response exposes only source-record status, row count, exact decimal total,
timestamps and fenced identifiers/revision. It excludes shopper records, raw
input, staff identity and worker leases. The current installation generation is
separate from the source's original generation, so an approved current actor can
read historical records without resuming old workers. `source_record_only`
explicitly means this is not ledger reconciliation or completion evidence.

The Shopify action and browser client validate response store/source/generation,
reject extra fields and numeric totals, obtain fresh tokens and never retry
automatically. All 272 focused tests across 18 files and the Shopify TypeScript
check pass. Independent review found no concrete blockers. Merchant-screen
status controls were not connected at this checkpoint; live and actual
new-schema database acceptance remain outstanding.

## Merchant status panel verification (2026-09-09)

A successful staging acknowledgement now reveals an EN/JA/VI status panel for
that source. It uses the signed status client with the authenticated store and
current generation; identifiers are kept in component memory, not rendered into
the DOM or saved in browser storage. Status refresh is explicit and does not
upload a file, restart a worker or automatically retry. Exact totals remain
decimal strings and timestamps are labeled UTC.

The panel distinguishes saved state from ledger reconciliation, labels older
installations without offering to resume them, clears stale success before a
refresh, and sanitizes failures. It is removed on source replacement or loss of
configure access. Late results from unmounted panels are discarded.

All 285 focused import tests across 19 files pass, including localized status
and failure states, duplicate-click suppression, replacement races, permission
loss and identifier exclusion. This is component-test evidence, not browser or
live acceptance. History discovery after page reload remains unimplemented;
this panel currently addresses the source staged in the current page session.

## History gateway verification (2026-09-09)

The status-panel review completed without actionable findings. The next local
increment adds a signed `history` operation and browser client so previously
staged sources can be discovered without uploading their files again. The
current configure/project/lifecycle/generation checks run before source access.
Pages contain at most 20 source-record summaries, including earlier-installation
records, with the same explicit non-reconciliation semantics as status lookup.

Pagination orders by creation time and then UTF-8 binary source ID, newest
first. A parameterized, store-scoped query selects at most 21 IDs. A bounded
store/ID metadata read preserves Prisma Decimal values; program ownership is
checked in one bounded query. The cursor is the last visible row, not the
lookahead row. Response validation rejects duplicates, out-of-order records,
rows not strictly before the requested cursor, substituted scope/generation
and inconsistent continuation cursors. This closes a replayed-page issue found
during independent review.

All 302 focused import tests across 19 files and the Shopify TypeScript check
pass. Prisma validates the staged schema, including the store/creation-time/ID
index; no schema application occurred. A read-only constant-row query on the
isolated MySQL database verified parameterized binary cursor comparisons and
mixed-case ordering (`a`, `Z` before `z`). This does not prove real import-table
query plans, races or performance; those remain gated on schema approval.
History discovery UI is not yet connected. Independent review confirmed the
pagination fix with no new correctness/security blocker. `ORDER BY BINARY id`
may require a filesort beyond the returned 21 rows; the result limit is not
evidence of a bounded database scan. Realistic EXPLAIN/load evidence remains a
deployment gate even with the staged index.

## History screen verification (2026-09-09)

The merchant screen now connects the history client independently of file
selection, so saved sources can be rediscovered after a page reload. EN/JA/VI
controls load the latest page, request older pages using the verified cursor,
and open a separate current-status lookup for a selected source. History and
status expose saved-state semantics, not reconciliation proof. Exact totals
remain strings; timestamps are labeled UTC. Identifiers stay in memory/React
keys rather than DOM attributes or browser storage.

Each load clears the previous page and selected status. Duplicate loads are
suppressed; failed loads offer an explicit latest-page retry without retaining
stale totals. Store/generation remounts and permission-loss removal discard late
responses. All 309 focused import tests across 20 files, Shopify typechecking,
focused lint and formatting pass. Independent review found no actionable
permission/lifecycle/privacy/concurrency blocker. Real mobile, keyboard,
screen-reader and authenticated `yamaxdev` acceptance remain unverified.

## Reconciliation gateway verification (2026-09-09)

The signed imports endpoint and browser client now accept `reconcile` with a
source ID, current installation generation and the source revision last read
by the merchant. Current actor/store/project/lifecycle checks and revision
equality precede independent source/execution/ledger reconciliation in the same
repeatable-read transaction. No points, source state or worker jobs are changed.

Responses explicitly describe `ledger_provenance`, not cached-wallet balance
verification. Exact aggregate values remain decimal strings; diagnostic codes
are allowlisted and contain no shopper identifiers. Both transport boundaries
check source/store/generation/revision and arithmetic/completion consistency.
Clean committed/rolled-back sources require the corresponding full-completion
flag; clean preview/cancelled sources cannot claim posted or reversed points.
This closes a response-consistency issue identified during review. A clean
preview is not a completed import.

All 336 focused tests across 21 files pass, including substituted identities,
stale revisions, malformed diagnostics, precision loss, contradictory state and
legitimate mismatch evidence. Independent review confirmed the consistency fix
with no remaining blocker in that increment. Merchant reconciliation controls
are not connected yet. Actual-table performance, independent cached-wallet SQL
reconciliation and authenticated live acceptance remain separate work; no schema
application or deployment occurred.

## Reconciliation screen verification (2026-09-09)

Reconciliation is now available after a successful status read from either the
newly staged source or history. The action sends the observed source revision,
current generation and source ID through the scoped client. EN/JA/VI outcomes
distinguish mismatch, fully committed, fully rolled back and clean-but-incomplete
evidence. Every allowlisted diagnostic is localized; all totals stay exact
decimal strings. The screen explicitly excludes cached-wallet audits.

Each status refresh remounts reconciliation even if the revision did not change,
discarding prior results and detached requests. Explicit reruns clear prior
evidence, suppress duplicate dispatch and sanitize failures without automatic
retry. Existing configure/store/generation gates remain in force. No identifiers
or raw errors render, and no evidence is persisted in browser storage.

All 343 focused tests across 22 files, Shopify typechecking, focused lint and
formatting pass. Independent review found no actionable blocker. Browser/mobile,
keyboard/screen-reader, actual-schema and live financial acceptance remain
unproven; no deployment or schema application occurred.

## Execution lease primitives (2026-09-09)

Local internal helpers now claim, validate and renew import execution leases.
Each transaction locks the operational store, active program and current source
in that order, then samples database UTC time. Source ownership, installation,
revision, lease pairing and hash shape must match; transitions use an exact
compare-and-swap. Initial claims allow preview to committing or committed to
rolling back. Only expired matching-phase leases can be reclaimed; contained,
cancelled and malformed states cannot be silently adopted.

UUID lease identities and renewal revision rotation invalidate displaced or old
tokens. Expiration is checked at the boundary; revision overflow and unavailable
database clocks fail closed. The source lock must remain held through each row
transaction. These helpers do not authorize a merchant, validate source rows,
schedule durable jobs, enroll accounts or post points. Those responsibilities
remain in the same-transaction orchestrator still to be implemented. No public
commit endpoint or worker execution has been enabled.

Independent review found no actionable blocker in these primitives. Focused
mocked tests cover claim/reclaim/renewal, lock order, stale revisions/owners,
tenant/generation guards, containment, malformed state and compare-and-swap
failure. This is not real MySQL contention or installed-schema evidence; schema
application and deployment remain explicitly gated.

The accumulated focused import suite passes 368 tests across 23 files, including
the final representable revision and unavailable-clock cases. Focused lint and
formatting pass. The full web TypeScript check exhausted its default 4 GB Node
heap before reporting type results. The 8 GB retry finished with shared UI type
errors and one import lease-status enum error. The import enum error was fixed.
The final 8 GB full-web check reports 631 diagnostics, with none matching the
import modules/tests. This is not a successful full-web typecheck.

## Commit-time row eligibility checkpoint

The internal commit-row reader now validates the stored snapshot under the
current source execution lease. It uses current locking reads for shopper,
account, privacy tombstones and optional tier ownership, rejects ambiguous
customer identities and foreign-owned accounts, and rechecks birthday conflicts
and exact signed-64-bit balance/ledger-version bounds. It does not enroll an
account, write points, apply fields or schedule rewards.

Independent adversarial review found no actionable blocker within that scope.
The initiating orchestrator must still verify the whole immutable manifest;
row-execution idempotency and all eventual writes must occur in the same locked
transaction. Mocked eligibility tests do not prove real MySQL privacy races.

The focused suite passes 390 tests across 24 files. A test-title formatter tried
to JSON-serialize a BigInt fixture and prevented collection of the new suite;
using a case index instead fixes collection without changing financial values.
Typechecking also caught array fixtures being spread as Vitest arguments;
object-wrapped shopper arrays now exercise the intended missing, ambiguous and
foreign-shopper cases. These require the domain conflict error rather than any
exception. All 22 row-reader tests pass after that correction. Focused lint
passes. No import schema was applied or live writer enabled.

## Dedicated import enrollment checkpoint

The standard shopper enrollment path can issue account-created signup rewards.
Imports now have a separate internal transaction step that invokes current,
lease-fenced row eligibility first, then reuses an eligible account or creates a
zero-balance account. It does not call signup, referral, tier, ledger or outbox
award paths. The unique shopper-account constraint remains authoritative;
concurrent-create failures propagate rather than adopting an unchecked account.

Independent review found no actionable blocker within this internal-only scope.
The focused suite passes 403 tests across 25 files, including 13 enrollment cases
for reuse, zero-valued creation, validation order, rejected ownership/accounting
state and error propagation. These mocked tests are not real concurrent-enrollment
or transaction-rollback evidence. The caller must still compose enrollment with
opening-balance, field and execution writes atomically, after manifest verification
and row idempotency checks. No route or worker invokes this step yet.

## Transactional imported fields checkpoint

An internal field-application step now revalidates the stored row under the
execution lease after enrollment and before ledger posting. It captures the
original owned fields, preserves unrelated metadata, registers a new birthday
with its future reward job in the same transaction, and records changed tier
placement as a sequenced manual override. Imported placement does not emit tier
achievement events, grant entry rewards or alter qualifying counters. An
unchanged tier preserves its existing grace deadline and creates no history.
Unsequenced or exhausted tier history fails closed.

Review identified and resolved an annual birthday-job collision: the outbox
enqueue primitive can return an existing job unchanged. This import step now
requires a newly created job for a new registration; cancelled, completed and
stale pending jobs cause the caller transaction to abort instead of silently
losing the schedule or reissuing a reward. Independent follow-up review cleared
that fix. Tests cover these cases; actual transactional rollback is not yet
proved against the import schema.

The returned `afterFields` is deliberately intermediate. Ledger posting resets
expiry activity, so the orchestrator must capture the final owned-field state
again after posting and scheduling before persisting row-execution evidence.
The focused suite passes 417 tests across 26 files. No route or worker invokes
the field helper, and rollback-to-no-tier history remains an unresolved schema
decision rather than a silently implemented change.

## Owned atomic row execution checkpoint

The internal row executor now owns a fresh Repeatable Read transaction with a
30-second timeout. It fences the active execution lease before row access,
checks execution idempotency, enrolls without synthetic signup awards, applies
imported fields, posts the exact opening balance, checks the final account, and
creates the committed row-execution record in that same transaction. Errors
propagate through the transaction; it never exposes an independently committable
partial enrollment or field step.

Final field evidence is captured after ledger posting, including the changed
expiry clock. Existing expiry supervision is still responsible for the durable
unscheduled marker; that operational deployment is not proved by this helper.
The executor verifies unchanged pending and lifetime totals as well as the exact
available balance and ledger version before persisting success.

A committed retry verifies source-wide immutable ledger provenance and its
original sequence instead of reapplying current shopper fields. Missing execution
records with any opening/rollback key, import reference or exact source/snapshot
metadata ledger evidence fail closed as orphan financial writes. Review caught
the initially missing rollback-orphan check; the expanded guard and query-aware
tests were independently re-reviewed without a remaining blocker.

The focused suite passes 438 tests across 27 files. The mocked transaction tests
prove composition, error propagation, replay and rejection paths, not actual
MySQL rollback or simultaneous workers. The initiating staff authorization,
whole-manifest proof before lease issuance, durable job scheduling, source
finalization, rollback executor and live schema tests remain unfinished. No
gateway or live worker invokes the row executor.

## Source finalization checkpoint

The internal finalizer now owns a fresh Repeatable Read transaction, locks the
active source lease, and reads the full verified manifest and ledger/execution
proof before any terminal source update. Reconciled but incomplete sources stay
in progress. Commit requires every row committed; rollback requires every row
rolled back. A second lease check reads database time after reconciliation, so
expired ownership cannot finalize a long-running proof. Terminal compare-and-swap
matches source/store/program/generation/status/revision/lease, increments revision,
records completion time and clears the lease. Exhausted revisions fail closed.

Internal row-completion flags are separate from the merchant-facing summary.
The existing merchant reader still reports full completion only when source
state is terminal, with no added response fields. Independent review found no
actionable blocker in the finalizer or that compatibility refactor.

The focused suite passes 448 tests across 28 files. These tests cover incomplete
proof, corrupt/mismatched proof, lease expiry during reconciliation, terminal CAS
failure, revision exhaustion and both phase transitions. They do not prove actual
MySQL finalization races. This proof remains ledger/execution-state scoped, not
an independent audit of cached wallets or restored birthday/tier fields. No
live worker invokes finalization; rollback orchestration remains unfinished.

## Verified lease issuance checkpoint

Lease claims now run full stored-manifest and ledger/execution verification
before their source compare-and-swap. Proof must match the current source
revision, installation generation, normalized digest and phase. Initial commit
accepts only pending rows; commit recovery permits pending/committed rows.
Initial rollback requires fully committed evidence; rollback recovery permits
committed/rolled-back rows. Contained, cross-phase or corrupt evidence fails
before source mutation. Lease lifetime starts from fresh database time after
the full-file proof, not from before that potentially expensive read.

The merchant summary contract remains unchanged; source binding and row-state
sets are internal evidence only. Independent review found no actionable issue
within this state machine but identified a caller requirement: issuance must
start in a fresh transaction and lock the source before any consistent read.
Source revision does not advance per row, so revision binding alone cannot
detect an older execution-row MVCC snapshot. Gateway/worker wiring must honor
and test this requirement. Authorization and durable scheduling are still not
implemented by the claim primitive itself.

Focused verification passes 459 tests across 28 files, including mixed-state
expired-lease recovery for both phases. Focused lint and formatting pass. The
full-web typecheck still fails with 631 diagnostics, none in the import paths.

## Authorized merchant start checkpoint

An internal Shopify commit-start service now owns a fresh transaction and
rechecks `loyalty.configure` using the current signed actor. Store and program
scope are server-derived; the strict request allows only source ID, expected
installation generation and revision for the commit operation. The service
locks the active program and scoped staged source, rejects any non-preview
state, then calls verified lease issuance. Merchant start is not a recovery or
rollback endpoint.

Inspection and independent review confirmed that existing staff authorization
locks the store before its first consistent read. Import row writers share that
store lock, so this ordering gives the fresh transaction a coherent execution
snapshot even though the source lock is acquired after authorization. Tests
cover permission failure, generation mismatch, cross-scope input, state rejection,
ordering and propagated claim failures; the focused suite passes 470 tests across
29 files. Actual session/transaction races remain unproved.

The caller must still verify the complete request signature. The service returns
private lease material for worker dispatch, not a merchant response. No HTTP route
invokes it: durable dispatch must be integrated atomically with initiation before
activation, and schema/deployment gates remain unchanged.

## Bounded commit batch checkpoint

The internal commit batch loop now selects outstanding durable snapshot rows
under the current source lease, renews ownership after selection, and passes the
rotated token to the separately atomic row executor. Each invocation handles at
most 100 rows (default 50). Reaching the cap returns a private continuation lease,
not a completion claim. Empty selection still invokes independent full-source
finalization. Expired tokens, failed row transactions and incomplete final proof
stop the batch; they are not silently retried or marked complete.

Review identified repeated committed-prefix scans in the initial query. A
validated in-batch row-number cursor now advances only after successful row
execution, avoiding rescanning that prefix for every row within a batch. Each
new batch starts from durable evidence again; the cursor is not a completion
proof. Prefix work can still recur across batches. Real MySQL EXPLAIN/load and
join-lock evidence remain required before activation; LIMIT 1 is not a bound
on rows scanned. No scheduler or HTTP route invokes the batch loop yet.

Follow-up review confirmed cursor correctness without removing that performance
gate. Focused verification passes 484 tests across 30 files; lint passes. The
full-web typecheck remains at 631 diagnostics, with none in import paths.

## Prepared source-table database tests — not executed

Read-only inspection confirmed `weletic_loyalty_dev` at `127.0.0.1:3307` is
healthy and contains none of the three import tables. Explicit approval to create
only those tables in that isolated database was requested and remains pending.
No schema application, production database access or new-table fixtures ran.

A separate opt-in integration configuration and five source-table tests are
prepared: competing claims, forced transaction abort, damaged manifest rejection,
expiry/reclaim stale-owner rejection and installation-generation fencing. Before
fixtures, the suite requires its explicit opt-in flag, exact local URL/user,
verified database/principal and all three existing tables. It contains no schema
creation code. Cleanup is restricted to the UUID store IDs generated by that run.
The ordinary Vitest configuration excludes these integration files.

These are prepared tests, not passing database evidence. Real row-write rollback,
privacy races, query-plan/load checks and full installed-schema acceptance still
remain, in addition to running this source-lease suite after approval.

## Cross-app typecheck diagnosis

The earlier classification of the hundreds of Button diagnostics as unrelated
shared-UI source failures was incorrect. Rebuilding `@dub/ui` and checking without
the incremental cache did not remove them. The declared Button variants were
correct. The actual cause was `@shopify/app-bridge-types` globally augmenting
React's `ButtonHTMLAttributes` with `primary | breadcrumb`, pulled into the web
TypeScript program by the import bootstrap test's full Shopify route import.

The import page is now separated from its thin Shopify route wrapper. The page
accepts a structural token-provider object; the route still obtains the real
App Bridge instance and retains its existing settings loader/action exports.
The web-hosted bootstrap test imports the page without importing App Bridge or
the Shopify CSS loader. Shared UI source and dependencies were not changed.
The uncached check also caught three PromiseSettledResult narrowing errors in
the prepared database test; explicit status guards now narrow winner and loser.

After extraction, all 484 focused import tests and Shopify typechecking pass.
Focused lint passes. The full-web recheck then isolated one remaining import-route
error: Prisma inferred a single result type for a callback returning a union of
four response promises. Making that callback async produces a promise of the
result union without changing authorization, isolation or operation routing.
Full-web TypeScript checking now passes, as do the 16 route tests and route
format/lint checks. No full web build or browser acceptance claim follows.

Subsequent production verification: `pnpm --dir apps/web build` exits zero,
including Prisma client generation, compilation, lint/type validation, page-data
collection, all 398 static pages and final tracing. No schema application was
performed. Existing warnings concern the marketplace's re-exported `revalidate`
setting and edge-runtime static generation. This supersedes the earlier failed
web build checkpoint, but does not establish authenticated browser acceptance,
installed-schema correctness or any live Shopify journey.

The parallel full-web unit run reported 6,075 passing tests, six skipped and one
failure: a simulated in-memory profile benchmark measured 66.4 ms against its
50 ms threshold. That benchmark includes Vitest assertions in its timed loop;
it does not exercise Shopify or database latency. All 64 tests in that file pass
when run separately. This does not establish the cause of the full-run failure;
the threshold and test source remain unchanged. A second parallel full run gives
the same counts and benchmark failure (60.2 ms). The repository's `test:unit`
script specifies `--no-file-parallelism --bail=1`; verification with those
configured Vitest options passes: 394 files, 6,076 tests passed and six skipped
in 454.87 seconds. Neither parallel run is a green suite. No test threshold,
test source or CI configuration was changed to obtain the configured result.

## Expired commit recovery boundary

The internal recovery wrapper now owns a fresh, bounded Repeatable Read
transaction. It accepts exact source/store/program/installation scope from
trusted durable work, locks the operational store, program and source, and
rejects anything except an expired `committing` lease using database time.
It cannot start a preview, initiate rollback, adopt contained work or replace a
live owner. Extra phase/revision/token fields are rejected rather than trusted.

Recovery derives the current revision from the locked record and reuses the
existing full manifest/execution/ledger proof before rotating lease ownership.
The displaced owner fails subsequent assertions. Failures escape the transaction
without automatic retry. The returned lease is private supervisor material,
not a merchant response. No scheduler or HTTP endpoint invokes this wrapper yet.

Independent review found no actionable blocker. All 496 import tests across 31
files pass, including 48 lease/recovery tests. Focused lint and full-web
typechecking also pass for this change.
The successful full-web build and 6,076-test full suite above precede this
recovery increment. Real database races and trusted durable dispatch remain
required before activation; these mocked tests are not live recovery evidence.

The separate source-database suite now also prepares two real-wrapper tests:
competing recoveries must yield exactly one persisted owner and one domain
conflict, fencing the displaced token; preview and live-lease recovery attempts
must leave source state unchanged. Setup and the production recovery wrapper
share the actual Prisma singleton, guarded by the suite's exact local
database/principal/table checks before any fixture writes. The suite now has
seven tests and remains unexecuted pending explicit schema approval. No schema
creation or new database writes were performed for this increment.
Full-web typechecking, focused lint and formatting pass; independent review
found no actionable issue. These static checks do not constitute database proof.

## Recovery candidate discovery

Internal discovery now reads one exact store/program/installation generation in
a fresh bounded transaction, after operational store and active-program fences.
It uses database UTC time and selects only leased `committing` sources whose
leases have expired. A validated binary source-ID cursor and a maximum 25-row
page (plus one lookahead) support advancing through candidates. Returned scope
hints contain no lease token, staff identity, customer data or financial totals.
Every candidate still requires the independently fenced recovery transaction.

Discovery does not claim work or write source/account/ledger records. A future
supervisor must finish pagination even after candidate-level failures and restart
later sweeps from the beginning to pick up newly expired earlier IDs. No
scheduler or HTTP path invokes discovery yet. LIMIT bounds returned rows, not
database work; binary ordering and expiry filtering require real EXPLAIN/load
verification before activation.

All 514 import tests across 32 files pass, including 18 discovery tests. Review
found no actionable blocker. Database performance and scheduler behavior remain
unverified, and local-schema approval remains pending.

## Connected recovery worker page

One internal operation now connects discovery, verified recovery and one bounded
commit batch per candidate. Discovery failures propagate as page failures.
Candidate failures produce sanitized `conflict`/`failed` outcomes with their
stage and unknown progress; a batch can have committed earlier rows before an
error, so no zero-progress assertion is made. Later candidates still run and
the page cursor is preserved. No automatic retries or containment writes occur.
The future supervisor must persist/report outcomes and apply retry policy.

Completed outcomes come from independent source finalization. Incomplete
successful outcomes carry the latest private continuation token, typed as
unknown until the next batch validates it. Earlier tokens may expire while later
candidates run, so returning a token does not guarantee it is still usable.
Source and row evidence remains durable if the process exits; later recovery
must reverify it. No merchant API or live scheduler calls this operation.

All 526 import tests across 33 files pass. Review found no financial or tenant
blocker and highlighted the continuation-expiry caveat documented above.
Full-web typechecking and focused lint/format pass after aligning the
continuation type with the existing batch's unknown-token boundary.
Live dispatch, failure persistence/alerts, bounded retry policy, graceful
supervision and real database acceptance remain required before activation.

## Prepared full-row database acceptance

The opt-in source database suite now contains nine cases. Two new cases invoke
the actual shared row executor and finalizer: concurrent delivery must produce
one enrollment, one exact opening-balance ledger entry above JavaScript's safe
integer range, one execution record, and one verified replay; finalization must
clear the lease and reject further use of it. A foreign snapshot must fail before
either store receives an account or financial write. No synthetic earn grants or
outbox jobs are expected for the opening-balance-only fixture.

Both concurrent transactions are awaited with `Promise.allSettled` before any
assertions, including on failure, to prevent a remaining writer from racing
fixture cleanup. Cleanup remains restricted to the suite's generated store IDs.
Review identified and resolved this wait-safety issue. The existing 30 executor
and finalizer unit tests, full-web typecheck and focused lint/format checks pass.

These nine database cases have NOT run: the three source tables still require
explicit isolated-schema application approval. Prepared assertions are not live
or MySQL proof. Later-write rollback atomicity, birthday/tier side effects,
expiry behavior and independent SQL wallet reconciliation still need coverage.

## Atomic initial dispatch checkpoint

The internal merchant start service now authorizes, checks preview state, claims
the source and creates `HISTORICAL_IMPORT_COMMIT` in one transaction. Queue
failure aborts ownership changes. The job carries only source/program references,
installation generation and the initiating source revision; the public result
contains only source ID and status. No lease token is returned or persisted in
the payload. An existing job for the just-created revision fails closed rather
than using the generic outbox duplicate-key shortcut.

The job is scheduled at the initiating lease's database-derived expiration
(currently 60 seconds after claim). This permits future worker recovery without
adopting a live private token or spending retry attempts waiting for ownership.
The worker must still validate its claim, current installation and source state;
the payload revision is initiating evidence, not permission to bypass later
ownership or reconciliation checks.

The source MySQL suite passes 15 tests, including two new cases: concurrent
starts produce one source claim and one pending job; an actual duplicate-ID
failure in the outbox insert restores the source to preview with no lease, and a
subsequent retry succeeds. Only ID generation is overridden for that failure;
the existing sentinel job remains unchanged. Independent post-test counts find
zero fixtures across the 12 checked source-suite models. Dispatch/start unit
suites pass 22 tests; full-web typechecking and focused lint/format pass.
Independent review found no actionable blocker in this checkpoint.

This is initial durable enqueue evidence, **not worker execution**. The outbox
consumer, bounded continuation, terminal-job reconciliation, rollback execution
and merchant commit route remain unfinished and inactive. No Shopify deployment,
shared schema application, email delivery or live-store acceptance occurred.

## Bound queue ownership and continuation checkpoint

The private source token can now bind the exact outbox job, owner, claim time,
attempt and initiating revision. Outbox recovery acquires and verifies source
ownership and this binding in one fresh transaction. A stale claim aborts recovery
instead of committing a new source lease. Every subsequent row, renewal and
finalization checks the binding using current locking reads in the order
store → program → source → outbox. Waiting for the outbox lock is followed by a
new database-time check so the wait cannot extend the source lease.

After a successful bounded commit batch, the continuation primitive atomically
expires and revision-rotates its source lease and requeues the same durable job.
It retains the original payload, releases queue ownership and resets the failure
attempt budget for the next successful-progress slice. It does not mark the job
completed. The next slice must recover from persisted evidence, and the old
token is immediately invalid. The dispatcher must call continuation only after
actual successful progress and must not run generic completion handling afterward.

All 18 source MySQL tests pass, including bound recovery/commit/finalization,
rollback of an attempted recovery under a stale queue owner, rejection of queue
replacement before enrollment or ledger writes, and a bounded handoff followed
by recovery and independent final reconciliation with exactly one opening entry.
Independent read-only counts find zero fixtures across 12 source-suite models.
Focused ownership/recovery/contracts and batch/row/finalizer/continuation tests
pass (150 tests across eight suites). Full-web typechecking and focused lint pass.
Independent review found no actionable blocker in this checkpoint.

These tests manually claim disposable jobs; they are not scheduler acceptance.
The full import unit selection also passes: 36 files, 586 tests. Two older unit
fixtures initially failed collection after the public-main privacy update; their
partial mocks now preserve the real module's unrelated exports. No runtime
privacy behavior was relaxed to make those tests pass.
Actual outbox dispatch, terminal-job replay after source finalization, retry/dead
letter handling and merchant activation remain unfinished. Source reconciliation
on each recovery also needs maximum-size load/query-plan evidence. No runtime
worker, Shopify deployment or shared schema change was activated.

## Actual outbox commit execution checkpoint

`processOutboxJobsBatch` now passes its exact acquired ownership to the import
handler. The handler validates reference-only payloads, checks terminal replay,
recovers the bound source lease and executes at most 50 rows. Successful partial
progress uses atomic continuation and skips generic acknowledgement. Completion
is acknowledged only after source finalization or a fresh locked proof that the
committed source has fully reconciled manifest/ledger evidence. No cleared source
lease is required to recover a lost queue acknowledgement.

Nested failures are sanitized before the generic worker records retry/dead-letter
errors. A still-live source lease is different from execution failure: after
checking the queue owner, the handler defers to database-derived expiry and the
worker restores the previous failure-attempt count using exact-claim atomic SQL.
This fixed the review finding that ordinary short backoffs could exhaust five
attempts before a 60-second lease expired. No live lease is adopted.

All 22 source MySQL tests pass. Four added cases call the real outbox worker with
an exact disposable store/job allowlist: commit and acknowledgement replay;
50-row continuation followed by terminal reconciliation (exact sum
`50 × 9007199254740993`); live-lease deferral at four of five failure attempts and
successful recovery afterward; and sanitized dead-letter failure without ledger
writes. Fixtures adjust only their own initial eligibility/lease timestamps;
they do not change the DB clock or start a global scheduler. The 50-row scenario
took approximately 8–10 seconds in these runs, not a maximum-size load result.

The combined import/outbox unit selection passes (40 files, 723 tests), as do
full-web typechecking and focused lint. Independent review confirmed the retry
finding fixed with no residual blocker. Independent cleanup counts found zero
fixtures across 12 source-suite models.

This proves isolated worker integration, not supervised deployment, alerts,
authenticated merchant commit/rollback, maximum-size imports or named `yamaxdev`
acceptance. Rollback job execution remains unimplemented. Nothing was deployed,
no shared schema was applied and no customer communications were sent.

## Atomic rollback row checkpoint

The rollback row executor now owns a fresh transaction for verified rolling-back
source/queue ownership, scoped execution/manifest proof, locked account state,
field-restoration preparation, append-only financial correction, birthday-job
cancellation, nullable tier history and execution acknowledgement. The opening
entry and account enrollment are retained. Correction-induced expiry updates are
replaced with the verified original fields in the same transaction; unrelated
current metadata is preserved.

Automatic restoration rejects later owned-field or ledger changes. Tier changes
must have the original import as the latest sequenced history entry; an original
non-null tier must still belong to this program and not be deleted. No-tier is a
real null destination, not a fabricated tier. Birthday cancellation requires the
exact import-created registration/job payload and installation generation with
no active worker claim. A conflicting row aborts before containment is recorded
in a separate source-lease-fenced transaction, stopping further automatic work.
Replay proves the recorded correction without restoring fields a second time.

All 27 source MySQL tests pass. Five added cases cover birthday/no-tier restoration
and finalization; competing rollback deliveries producing one correction and one
replay; a claimed birthday job left untouched under containment; later ledger
activity preserved under containment; and an actual duplicate-ID tier-history
insert failure that aborts the already-appended correction/field restoration,
followed by a successful retry. Fixture tiers have a nonzero entry bonus, but
neither imported placement nor rollback creates that bonus. Independent cleanup
counts found zero fixtures across 12 models, including generated history IDs
identified by their source-scoped notes.

Import unit tests pass (38 files, 631 tests), including field ownership,
same-state later tier activity, deleted/foreign original tiers and birthday-job
claims. Full-web typechecking and focused lint pass. Independent review found no
actionable blocker. The first database run exposed a test assertion that did not
accept the correctly restored null metadata; it was corrected and the full
suite rerun successfully.

This checkpoint is row-level rollback, not rollback outbox dispatch or a merchant
journey. Bounded rollback recovery/continuation, merchant initiation and live
acceptance remain unfinished. No shared schema, scheduler or Shopify deployment
was activated.

## Rollback worker and merchant execution checkpoint

Rollback is now connected to the existing outbox worker with phase-specific
queue-bound recovery, bounded 50-row batches, durable continuation and independent
terminal ledger proof. A contained row stops automatic processing and dead-letters
the owned job immediately; it is never reported as successful rollback. Terminal
acknowledgement replay verifies provenance without appending another correction.

The isolated source MySQL suite passes all 30 tests. Three added real-worker cases
cover birthday/no-tier restoration plus terminal replay, a 50-row rollback that
remains pending until its separate finalization pass, and later shopper activity
that produces containment and a dead-letter job on the first attempt. The 50-row
scenario took approximately 12.6 seconds; this is not maximum-file load evidence.
Independent read-only cleanup counts found zero fixtures across 12 models.

Signed merchant commit and rollback now use the same authenticated import gateway.
The actor determines the store; fresh configure authorization, installation
generation, source revision and initial phase are checked in the transaction that
claims the source and creates its durable job. Public acknowledgements contain no
private queue ownership or lease material. Strict response validation rejects a
different store, source, operation, generation or unexpected terminal status.

The staged-source and history status panels expose EN/JA/VI confirmation controls
only after a fresh status read, for a current-installation preview or committed
source respectively. Dispatch clears the old revision and reconciliation result.
Both success and ambiguous failure require an explicit fresh status read; there
is no automatic mutation retry. Queued messages explicitly do not claim completion.
Identifiers remain in memory, not rendered hidden inputs or data attributes.

The combined import/outbox/staff-client unit selection passes (44 files, 824 tests),
including localized confirmation, stale-result invalidation, duplicate dispatch,
late responses after source replacement and transport deadlines. Independent
review found and verified a timeout correction: import execution has a 40-second
browser deadline around the gateway's 35-second deadline; other merchant callers
retain their 30-second default. Prisma validation, focused lint, web/Shopify
typechecking and both web and Shopify production builds pass (the builds retain
existing Next.js configuration and Remix/sourcemap warnings).

At this checkpoint this was uncommitted local implementation, not a public PR, authenticated
browser acceptance, supervised deployment or named `yamaxdev` evidence. No shared
schema application, Shopify deployment, real email or global scheduler occurred.

The final full-web build passes. The broader non-parallel unit run stopped after
6,208 passing tests and six skips at one historical Flow migration assertion: it
compared an immutable older SQL enum to the complete current Prisma enum. The
assertion now requires that exact historical prefix/order and exactly the two
approved appended import labels; the old SQL files were not rewritten or applied.
The fresh non-parallel full-suite rerun passes: 406 files, 6,334 tests and six
skips. This is local repository evidence, not the public Fast Quality Gate.

## Local browser checkpoint

A separate loopback-only synthetic harness rendered the actual import screen,
history, status and reconciliation components in Chromium at 375 × 812. It used
in-memory fixture callbacks, no Shopify authentication or database operations,
and no production stylesheet. This does not prove the embedded merchant journey.
Normalized observations, not screenshots, are retained in the public reference.

English commit confirmation and Japanese rollback confirmation were traversed
with Tab/Space/Enter. Both yielded the localized queued-not-completed message and
removed stale mutation controls. Vietnamese rollback transport failure displayed
the localized uncertain-result message, removed the prior revision and required
refresh, with no internal error disclosure. These states had no page-level
horizontal overflow or fixture identifiers in the DOM.

Visual inspection found two issues: introductory copy still said commits were
unavailable, and Japanese table headers wrapped one character per line. EN/JA/VI
copy now describes preview, staging, confirmation and ledger verification. History
and preview tables keep cells on one line inside named keyboard-focusable
horizontal-scroll regions. Focused UI tests (43) and lint pass after these changes;
Shopify typechecking and its production build were rerun successfully.
The Japanese table was rechecked after rebuilding the fixture: headers remained
on one line, the two-row table stayed under 120px high, the page remained 375px
wide and ArrowRight scrolled the focused history region. The fixture browser and
its loopback server were stopped afterward; ignored local artifacts were retained.

Remaining browser scope includes actual authenticated upload/staging, all locale
and permission/lifecycle combinations, application styling, screen-reader checks
and named `yamaxdev` evidence. Maximum-source performance remains unverified.

## Reconciliation scalability checkpoint

The ownership verifier no longer rescans every execution row for each
1,000-account database batch. Executions are grouped once by account, and every
snapshot is still checked, including malformed rows sharing an account. No
tenant/program check, orphan discovery query, financial write or schema changed.
Independent review found no blocker. Tests at 1,001 and 50,000 committed rows
verify bounded query lists, linear account visits and exact BigInt totals. These
use fixture query responses and are not database load evidence.

The 30 isolated source MySQL regression cases pass. An additional opt-in real
50,000-row pending-manifest test passes with
`HISTORICAL_IMPORT_LARGE_SOURCE_INTEGRATION=1`: source verification/claiming took
2,113ms and the independent proof read took 1,976ms in this run. The fixture setup
inserts snapshots in 1,000-row chunks. No ledger history was fabricated and the
result explicitly remained pending, not fully committed. Exact fixture cleanup
completed; independent read-only counts found zero fixtures across 12 models.

A read-only `EXPLAIN FORMAT=JSON` diagnostic for source-metadata discovery showed
a primary-index scan with the JSON source predicate applied as a filter, not an
indexed source lookup. The small isolated ledger does not establish the cost on
a large populated ledger. Full commit/rollback load, competing-store latency and
query/index strategy therefore remain release gates; no index was added or
shared schema applied. The latest focused import/outbox/staff/Flow selection
passes (45 files, 828 tests), as do full-web typechecking and focused lint.

## Real multi-batch worker load checkpoint

The separate `HISTORICAL_IMPORT_WORKER_LOAD_INTEGRATION=1` case ran 500 real
opening-balance rows through both outbox phases in isolated MySQL. Each phase
used eleven real worker deliveries: ten batches of 50 rows followed by independent
terminal reconciliation. Initial fixture eligibility was adjusted before each
phase, but no attempt count, lease or schedule was reset between continuations.

Commit took 54,759ms total, with row batches between 4,740ms and 5,991ms. Rollback
took 121,748ms total, with row batches between 11,350ms and 12,548ms. Every
intermediate source/job remained nonterminal and pending respectively. Final
source proof verified exact totals; SQL-backed counts found exactly 1,000 ledger
entries and 500 wallets with zero balance and ledger version 2. The test did not
fabricate purchases, referrals, coupons or historical earns. Independent cleanup
counts found no fixture remnants across 12 models.

Independent review found no continuation shortcut or broad cleanup. Focused lint
and full-web typechecking pass. This establishes one 500-row lifecycle on the
isolated database, not maximum-size execution, competing-store latency,
supervised deployment or named `yamaxdev` acceptance. The 50,000-row execution
and large populated-ledger query-cost gates remain open.

## Remaining implementation and verification

1. The three source/row tables, import job enum types and nullable tier destination
   are now approved and verified only in isolated local MySQL (see checkpoints
   above). Shared schema application remains gated; local persistence evidence
   is not deployment proof.
2. Verify the implemented read-only preview against authenticated store data,
   including privacy tombstones, active accounts, tier mappings and birthday
   conflicts. Prove full-file limits and transaction duration under load.
3. Commit dispatch, queue-bound recovery, continuation and terminal replay are
   integrated and verified locally as above. Extend interruption/concurrency,
   large-source load and deployment supervision evidence; do not substitute
   fixture worker calls for supervised live execution.
4. Atomic append-only rollback rows, bounded outbox orchestration and containment
   are verified locally as above. Extend interruption and load evidence; the
   independent ledger-provenance reconciliation reader is implemented locally.
   Subsequent shopper activity must not be overwritten; changed balances,
   birthdays or tiers need explicit containment rather than restoring snapshots
   blindly. Never remove existing ledger history.
5. Verify the implemented signed upload/preview/staging, status, history,
   reconciliation and commit/rollback journeys in an authenticated browser,
   including EN/JA/VI, 375px layout, keyboard operation and permission loss.
   Keep private identifiers excluded from rendered output.
6. Cover isolated MySQL races, privacy lifecycle, interrupted imports, retries,
   stale generations and rollback after downstream activity. Complete browser
   acceptance and named `yamaxdev` evidence after explicit execution approval.

The server-side source parser now verifies the actual UTF-8 upload bytes against
the declared digest, parses CSV/JSON itself, and computes a versioned normalized
row digest. CSV and JSON representations of identical rows produce the same
normalized digest while retaining different source-byte digests. Row order is
significant. Exact aggregate balances use BigInt; duplicate customers are checked
across the whole source, including across the 1,000-row request boundary.

Source parsing is limited to 10 MiB and 50,000 rows per file. CSV parsing stops
after the header and one overflow row instead of materializing an unbounded
number of tiny records. Oversized sources fail explicitly, never truncate into a
successful import. Errors expose a code and optional one-based data-row position,
not customer identifiers or source content. The existing PapaParse dependency is
reused; no dependency change was made.

Focused contract tests pass (24); source-parser coverage additionally exercises
hash mismatches, normalized digest stability, quoted CSV, malformed headers,
invalid UTF-8, exact totals, size limits and duplicates across batch boundaries.
These prove parsing only, not durable provenance, authorization, accounting or
live acceptance. Upload transport and source staging now exist locally; their
database and authenticated-store acceptance remain unverified.
