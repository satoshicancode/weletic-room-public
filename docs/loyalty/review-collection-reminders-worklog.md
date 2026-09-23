# Review collection settings and reminders — R01 completion slice

## Current reconciliation — September 23, 2026

The retained September 20 draft is now integrated into `codex/store-review-core`
for draft PR #101, preserving the original worktree. The sections below this
entry record the original branch history; their earlier baseline and pending
states are not current release acceptance.

The integrated reminder sender uses the shared per-store email/customer budget.
Source attempts, immutable provider content and admission commit together. SQL
rollback leaves neither an attempt nor a reservation; a lost commit
acknowledgment retains both and resumes Resend with the original evidence.
Policy deferral rolls back before transport. An admitted SMTP attempt that loses
final authority is contained for reconciliation, with no automatic resend.
Terminal admission rejection settles the source and removes the parent token
when no reminder remains pending.

Customer exports now include an explicit private reminder-history projection,
without encrypted payloads, bearer tokens or worker leases. Durable exports use
the existing immutable page/checkpoint mechanism and append
`export_review_reminders` after `export_shopper_delivery`. Store erasure drains
reminders independently of request pointers, including orphaned rows.

Rollout requires the additive collection/reminder SQL before deploying readers,
even while reminders remain disabled. Drain/restart older in-flight exports
before activating writers so exports already past the new phase do not omit
history. Keep a worker that understands persisted reminder-export phases during
recovery; do not roll back to an older worker while those phases exist.

The prospective cutoff also advances when review email collection changes from
disabled to enabled while Reviews is already active. Delayed pre-enable
fulfillments cannot create invitations. Ordinary edits preserve the cutoff;
existing invitation timing, token hash and incentive policy remain unchanged.

Verification:

- Full web suite: 10,261 passed, six existing skips, 632 files. The additional
  durable reminder-phase export tests are recorded in the final focused result.
- Full native Reviews SQL suite: 107 passed. Two subsequently added isolated SQL
  regressions passed separately: anonymous email capacity versus authenticated
  reminders, and delayed pre-enable fulfillment versus prospective collection.
- Source/budget rollback and lost-commit-acknowledgment recovery passed in SQL;
  focused service/sender/export tests cover explicit deferral, terminal cleanup,
  immutable export pages and retained ownership after interrupted publication.
- Exact collection/reminder additive DDL was rehearsed in disposable databases.
  Exact database/user cleanup passed; retained development ledger remained at 16
  entries. That count is a containment guard, not financial reconciliation.
- Chromium exercised the actual component with Shopify CSS and synthetic
  transport: EN/JA/VI at 375px, no horizontal overflow, keyboard save and failed
  save/reload. Local screenshots are under `output/playwright/reminder-controls-*`.
- Independent review identified and verified fixes for atomic admission,
  terminal token cleanup and the prospective cutoff. No blocker remained.

Local evidence does not establish installed authentication or provider delivery.
Final build/type/lint and updated-head CI results are tracked in PR #101.

No historical sends, shared migrations, real provider sends/orders or production
activation have been performed. The named installed acceptance packet remains
open.

## Original scope and baseline

Implement the approved R01 collection workflow, not another incentive writer:
signed Shopify merchant collection settings, prospective reminder scheduling,
delivery suppression and history, and EN/JA/VI controls. The existing invitation,
submission, moderation, privacy and incentive contracts remain authoritative.
This branch starts from public main after PR #87; PR #88 recovery is separate.

Inspected September 20: the embedded reviews route exposes moderation and
incentives, but not the full collection settings. Existing settings contain
sendAfterDays, expiresAfterDays, autoPublish, photoUploadsEnabled and
requestEmailEnabled. Existing invitation creation snapshots sendAt/expiresAt,
but there is no reminder schedule or separate reminder delivery history.

## Implementation sequence

1. Add a browser-safe collection contract and signed read/write gateways using
   reviews.configure authorization, installation generation and settings revision
   fencing. Reuse the existing lifecycle writer; preserve module and incentive
   fields, provider ownership, cancellation effects and prospective activation.
2. Add reminder configuration and immutable per-invitation delivery rows. Default
   reminders off; bound count and intervals, reject duplicate/non-increasing
   schedules and schedules outside invitation expiry. Changes affect future
   invitations only; no historical email backfill or revival of cancelled jobs.
3. Each reminder has its own stable provider idempotency identity, private
   prepared content, winning lease, retry evidence and terminal ambiguity state.
   Reuse the same invitation and incentive promise, never create another request
   or claim for a reminder. Resending the initial job is not a reminder.
4. Add the merchant editor, confirmation of send-affecting changes, delivery
   history and localized errors. Do not expose emails, tokens, provider payloads
   or private shopper identifiers in history or the DOM.
5. Exercise actual services on disposable MySQL, rendered shared UI and signed
   gateway contracts, then request a single scoped yamaxdev delivery packet.

## Security and migration constraints

Initial delivery currently erases encrypted token material on success. Future
reminder-enabled invitations require separately bounded encrypted token material
so the original single-use invitation remains valid across reminders. Do not
rotate its hash, preserve raw tokens in jobs, recover erased historical tokens,
or extend invitation expiry. Erase reminder token/content material on submission,
expiry, privacy and terminal cancellation; erase recoverable reminder token
material after the final reminder is settled. Retention sweep must cover retired
installations independently of whether sending is enabled.

Use additive schema and reader-before-writer rollout. Rehearse the exact migration
in isolated SQL; shared schema application remains gated. No real delivery,
module activation, Shopify changes or paid infrastructure is authorized by this
local implementation slice.

Before dispatch, check original request ownership/generation, successful initial
delivery, due time, unexpired single-use token, no submission, module/email
enablement, communication suppression and current purchase/privacy eligibility.
Hold the established customer settlement lock through transport/finalization.
Do not turn ordinary refunds into incentive fraud; invitation send eligibility
and an already-earned participation award are separate decisions.

## Acceptance requirements

- Stale/concurrent edits, foreign tenant identifiers, replayed actor envelopes,
  malformed settings, permission denial and installation replacement fail closed.
- Settings changes preserve existing promises and schedules; module toggles do
  not reset collection settings or incentive revisions.
- Initial send failure/ambiguity cannot trigger a reminder. Duplicate schedulers,
  worker crashes and provider replay cannot create duplicate logical deliveries.
- Submission before/during reminder, expiry, suppression, cancellation and privacy
  races either prevent transport or retain truthful in-flight delivery evidence.
- Retries reuse immutable content and provider identity; unsupported ambiguous
  retries remain contained instead of silently sending again.
- SQL history reconciles with provider outcomes; missing evidence remains unknown.
- EN/JA/VI editor/history at 375px, keyboard focus, loading/error/permission states;
  no cleartext private identifiers or bearer links in rendered history.
- Actual approved inbox delivery and authenticated yamaxdev submission remain live
  gates. Mocked provider transports never close them.

## Status

Draft implementation now includes browser-safe collection read/write contracts,
shared legacy field validation and prospective reminder snapshot/planning helpers.
The proposed bounded schedule is off by default, with up to three strictly
increasing elapsed-day offsets after confirmed initial delivery. Each offset must
precede the configured expiry window; actual planning also drops offsets beyond
the original expiry if initial delivery was delayed. It never extends expiry.

Eighteen focused tests passed for defaults, authority separation, write fences,
legacy compatibility, immutable schedule copying, delayed sends and corrupt
snapshots. These helpers are not yet connected to merchant gateways or delivery;
no reminder schema application, sends or live acceptance has occurred. The full
slice still requires the sequence and acceptance work above before a PR.

The draft now adds collectionRevision/reminderAfterDays settings fields and an
unapplied additive migration. The existing lifecycle writer advances collection
revision for both collection edits and old/module editors, preserving module and
incentive authority and cancellation/provider-ownership effects. Signed actor
read/write service adapters are authored but not yet exposed through HTTP or UI.
Forty-one tests across collection contracts, collection service and existing
native-review service passed. Real SQL migration/concurrency and end-to-end
gateway coverage remain required; no public surface may claim reminders work
until persistence, delivery, retention and UI are connected and verified.

New requests now persist a nullable immutable reminderSnapshot alongside their
original send/expiry dates. Fulfillment replay returns the existing request
without adding or replacing its snapshot. Legacy null configuration creates no
reminder offsets. The migration draft includes the nullable request field, but
has not been applied. No reminder delivery jobs are produced yet.

The latest focused run passed 55 tests across five suites, including merchant
authorization ordering/rejection and production request-creation code with
mocked purchase/transaction boundaries. This is not real SQL or authenticated
browser evidence. The earlier full web type-check passed after increasing Node
heap to 8 GB; the default 4 GB run exhausted memory. Generated Prisma client was
regenerated for this branch after switching from the recovery schema.

The delivery model draft now defines one unique invitation/sequence row, bounded
due-query indexes, generation/lease/attempt fields and encrypted prepared content.
It also adds a private encrypted reminder-token field to invitations. The exact
SQL draft is additive and unapplied. There is still no producer or transport
writing those records or retaining reminder tokens.

Erasure-only cleanup preserves settled delivery outcomes, cancels unsettled
authority and clears private payloads under caller-owned lifecycle fences. It is
connected to new-snapshot submissions and paged privacy redaction. Privacy scans
include reminder-only private material; frozen-shop purge removes scoped reminder
children before invitation parents. Nine helper tests pass. A broader local run
passed 548 tests in 46 suites (56.17s); these are not SQL or transport-race proof.
The final frozen-purge insertion also requires its dedicated SQL acceptance.

Outstanding within this slice: reminder production/dispatch, token retention on
initial send, expiry and email/module-disable cleanup, suppression and ambiguity
handling, authenticated HTTP/client/editor/history, exact migration rehearsal,
real SQL concurrency, independent review and named live delivery acceptance.

Expiry cleanup now discovers reminder-only private material and queued deliveries,
then cancels/erases them under the existing customer/store lock and generation
selection. Historical request statuses and attempt counts remain unchanged.
Twenty-two focused expiry/reminder-retention tests passed after this integration.
Module/email-disable cleanup and actual reminder transport remain unconnected.

Module/email disable is now connected to same-transaction cancellation of owned
unsettled reminder rows and encrypted reminder-token erasure. This avoids
disable/re-enable revival before a background sweep. Original sent invitation
hashes remain usable when only email is disabled. The bulk settings operation
still needs isolated SQL scale/locking acceptance.

The reminder-preparation helper is authored but not connected to initial email
finalization. It requires a sent, unexpired invitation, current approved active
installation, enabled email/module and matching token hash. Per-sequence upsert
never changes existing rows and conflicts fail closed. Terminal rows cannot
regain delivery authority; token retention is encrypted and requires the exact
invitation fence. No reminder sends, provider calls or live changes occurred.

Initial delivery finalization now uses one transaction for its winning lease
receipt and reminder preparation, with the store row lock inside the already-held
customer settlement lock. Failed preparation propagates so initial finalization
rolls back and retains its prepared provider retry identity. Generationless legacy
installs cannot produce reminders. Thirty focused finalization/production/prepared-
email tests passed, but actual SQL finalization races still require rehearsal.
Type-check caught the missing wrevrem\_ ID union member; it was added, with a fresh
type-check required. Reminder dispatch itself and shopper/merchant live acceptance
remain unimplemented/unverified; no sends or migrations were executed.

The rerun after adding the ID prefix passed web type-check. Delivery snapshots
now optionally bind a reminder ID in addition to the original invitation, with
a distinct native-review-reminder provider key. Legacy invitation snapshots and
keys are unchanged. Reopening rejects cross-reminder, cross-invitation and
initial/reminder substitution. The prepared provider boundary accepts only the
bounded reminder-key shape; retries retain identical rendered bytes and key.
Thirty-two snapshot/provider tests passed with mocked transports. No reminder
dispatcher or live transport acceptance is implied by those results.

## September 20 — reminder dispatcher draft and adversarial review

The internal reminder dispatcher now claims an owned, due, generation-bound row
under the existing customer settlement lock, checks invitation/purchase/privacy
eligibility and current module/email pause settings, retains immutable rendered
content, renews its winning lease and records an exact provider receipt. Resend
retries retain their original identity and are bounded by provider evidence and
five attempts; SMTP ambiguity enters reconciliation rather than automatic retry.
Failed-row leaseExpiresAt is also the retry not-before fence; scheduledFor is
never moved. No scheduler invokes this entry point yet.

Independent adversarial review identified and verified fixes for two defects:

- Proven pre-transport deferral must not consume a send attempt or permanently
  reconcile SMTP. Only the winning reservation is unwound; first unsent content
  is discarded, while evidence of an earlier ambiguous attempt is retained.
- Cancellation must not relabel a previous ambiguous delivery as definitely
  unsent. Zero-attempt rows cancel cleanly; prior attempts retain reconciliation
  status even when submission, expiry, privacy or settings disable erases their
  private content. A late confirmed provider receipt may settle only the exact
  same attempt and cannot recreate private material or financial effects.

Order cancellation/refund invitation invalidation now erases reminder authority
in the same transaction for reminder-enabled records. Existing genuine submitted
reviews and participation awards remain untouched. The final reminder receipt
erases its recoverable invitation token when no pending reminder remains.

Verification: the broad local review filter passed 598 tests in 49 suites
(58.59 seconds). After the final order-cancellation addition, 40 focused tests in
three reminder suites passed. Web type-check with an 8 GB Node heap, focused
ESLint, Prettier and git diff whitespace checks passed. All delivery tests use
mocked providers/transaction boundaries: no real email, SQL migration, deployment
or yamaxdev acceptance occurred. Independent re-review found no remaining
concrete blocker in these corrections; this is not SQL race proof.

Next: connect bounded authenticated scheduling and delivery history, complete
merchant HTTP/client/editor EN/JA/VI flows, rehearse the additive DDL and real SQL
claim/cancellation/privacy races, then build and run full CI before publishing
the complete vertical slice. Quiet-hour/frequency policy integration and live
inbox/submission acceptance remain explicit gaps, not satisfied by the pause
check. No new PR or completion claim is made for this draft.

## September 20 — signed collection editor connected locally

Added strict signed internal read/write endpoints, authenticated embedded-app
forwarding, response-validated browser adapters and a collection panel mounted
on the existing Reviews page. The server validates the Zod 4 actor and Zod 3
legacy collection contract separately. Input cannot supply store/user authority,
module activation or incentive policy changes. Responses are private/no-store.
Writes preserve installation-generation and collection-revision fences.

The EN/JA/VI panel explicitly loads configuration, edits invitation timing,
expiry, reminders, photo upload and rating-independent auto-publication, and
requires confirmation before saving. Uncertain saves lock the form until an
explicit reload; no automatic mutation retry is introduced. Pending requests
and confirmed drafts are invalidated on authenticated-client replacement but
not locale-only changes. This stale-client correction was found and confirmed
fixed by independent review. No private actor/session fields appear in controls.

Verification: 93 tests across collection and adjacent merchant-action suites
passed before the stale-client correction; the final collection-only rerun
passed 71 tests in six suites, including its new regressions. Web and Shopify
type-checks, focused ESLint, formatting and the Shopify production build passed.
The build retains existing sourcemap/future-flag warnings; exit status was zero.
UI evidence is rendered React under jsdom, not real 375px browser or live Shopify
authentication. Route tests mock service-signature verification; underlying
merchant-service authorization tests remain separate evidence.

Still required before publishing this slice: bounded reminder scheduling,
delivery-history projection/UI, quiet-hour/frequency integration, isolated exact
SQL migration and races, real browser acceptance, full web build/CI and scoped
live sends/submission. The schema remains unapplied and no live settings changed.

## September 20 — authenticated scheduling and queue containment

Reminder rows now act as durable scheduling intents. The existing authenticated
outbox cron discovers bounded, unqueued intents and enqueues them under the saved
store/installation fence. Existing jobs, including dead letters, are never reset.
Discovery advances only an advisory updatedAt marker before the operational
enqueue transaction; the new discovery index and least-recently-touched ordering
prevent a full page of malformed/blocked sources starving later company stores.
The delivery schedule, attempts and authority are not changed by scan rotation.

An earlier draft attempted enqueue inside initial delivery finalization. Review
found that maintenance acquired during provider I/O could then roll back an
already-confirmed initial receipt. That approach was removed: receipt/reminder
intent persistence does not call the queue writer, and the later sweep can defer
independently. General initial finalization/preparation failure remains part of
the required SQL/provider-ambiguity rehearsal, not proven by this separation.

REVIEW_REQUEST_EMAIL now accepts an explicit reminderId together with requestId
and non-null generation. A reminder cannot fall back to initial-invitation
delivery or be rebound to the current installation. The dispatcher verifies the
owned parent ID as well as reminder/store/generation. Existing initial payloads
remain valid. Deploy all readers/workers before enabling reminder policy writes;
old strict readers reject the extended payload and must not remain in service.

Reminder jobs bypass the legacy blocked-store success no-op. Known temporary
states defer; retired generations, redacted/missing/unknown states enter explicit
reconciliation. Customer-lock contention, due-time/lease waits, and proven
pre-transport pauses restore the exact outbox claim without consuming its retry
budget. Provider ambiguity uses bounded retry or dead-letter reconciliation;
expiry/cancellation after an earlier uncertain attempt is not reported as sent
or definitely unsent. The existing authenticated scheduler is reused; no new
public mutation or scheduler authorization model is introduced.

Verification: 141 focused reminder/worker/cron tests passed. A broader run then
passed 721 tests in 56 suites (63.23 seconds). After final discovery rotation and
terminal-state fixes, 75 focused scheduler/outbox tests passed. Independent
review confirmed all reported integration defects corrected. These tests mock
SQL/provider boundaries except the real cron signature wrapper; isolated MySQL
execution, query plans, races and live sends remain required. No runtime schema,
worker deployment or store configuration was changed.

Remaining in this slice: delivery-history projection/UI, quiet-hour/frequency
integration, SQL migration/claim/scheduling/privacy/receipt rehearsals, browser
acceptance, full web build/CI, and scoped live inbox/submission evidence. Final
terminal-attempt private-token retention also needs coverage in the SQL lifecycle.

Final checks after discovery rotation: Prisma validation, focused ESLint and web
type-check passed. The initial bare validation command lacked DATABASE_URL; the
rerun used an explicitly synthetic localhost URL and did not connect to or mutate
a database. Existing relation-mode index warnings remain. The discovery index
is only in the unapplied draft migration/schema.

## September 20 — truthful merchant delivery history

Added a tenant-scoped, bounded delivery-history projection and EN/JA/VI merchant
component for the initial invitation and up to three reminders. Provider
confirmation is explicitly not proof of inbox delivery or readership. Missing
history is distinct from an observed empty reminder list. Raw recipient data,
provider errors, encrypted content, tokens and lease details are not projected.
Contradictory confirmation evidence and duplicate/out-of-order sequences fail
contract validation.

Adversarial review found stale `sending` rows could imply a worker was still
active. Initial and reminder projections now share one observation timestamp and
require an unexpired lease for that label. Expired/missing leases with earlier
attempts remain unconfirmed. The reviewer confirmed the correction; pure and
gateway regressions cover both initial and reminder records.

Terminal ambiguous reminder attempts now erase the parent invitation ciphertext
when no later reminder remains pending, while preserving bounded reconciliation
evidence. Tests cover both final-attempt cleanup and retention for later work.

Verification: 80 tests across delivery-history, merchant projection and reminder
delivery passed. Web and Shopify typechecks, focused ESLint, Shopify production
build and diff whitespace validation passed. Existing build sourcemap/future-flag
warnings remain. Browser checks used actual React components with explicitly
mocked transport on loopback, not Shopify authentication: EN/JA/VI loaded at
375px without horizontal overflow; keyboard focus reached controls; the
Vietnamese permission-denied message received focus. No synthetic installation
generation was rendered in the DOM. These are bounded component checks, not
full-page accessibility or installed-theme acceptance.

The mocked ambiguous-save browser path focused the uncertainty message and
disabled edits/repeated save until reload; it did not announce success. The
only browser console error was the fixture's missing favicon. The named browser
session and loopback fixture server were stopped after the checks.

The slice remains uncommitted and unaccepted live. Remaining work includes
quiet-hour/frequency integration, exact isolated SQL migration and scheduling/
claim/privacy/receipt races, full web build/CI, and scoped real delivery and
submission. No live settings, sends, orders, deployment or shared schema changed.

## September 20 — exact migration and real MySQL reminder boundaries

Extended `native-reviews-db.integration.test.ts` with six reminder cases. The
production preparation, scheduler, retention and dispatcher run against real
MySQL; Redis serialization is deliberately removed by the existing suite.
Email transports remain mocked: none of these cases proves actual inbox delivery.

- Eight concurrent preparations preserve exactly three immutable sequences;
  overlapping scheduler sweeps create exactly one outbox job per sequence with
  the original due time, request ID and installation generation.
- Cleanup cancels unattempted reminders, preserves attempted outcomes as
  reconciliation, and erases parent tokens, leases and encrypted payloads.
  Repeating preparation does not resurrect cancelled reminders.
- Eight concurrent delivery calls produce exactly one transport invocation for
  each of Resend and SMTP, one settled receipt, and no additional send on replay.
- Cleanup during transport cannot erase a subsequently confirmed receipt or
  turn an uncertain result into confirmed delivery. Both branches keep private
  material erased and do not resend on replay. This explicitly exercises the
  SQL containment layer without claiming a real Redis/privacy-service race.

Rehearsal runner generated fresh `weletic_loyalty_it_shopper_<random>` databases
and matching restricted principals at loopback port 3307. After Prisma created
the fresh fixture, it verified all affected tables were empty, removed only the
new empty reminder table/columns, and applied the exact checked-in
`20260920_review_collection_settings.sql`. Tests therefore used the draft
migration's storage, not just Prisma-generated tables. No retained/shared schema
was changed. The temporary runner remains local at
`/tmp/weletic-review-policy-sql-run.cjs` (`reminders` mode).

Runs: 29/29, then 31/31, then final 33/33 tests passed. Final fixture suffix was
`fabe7d03db91`; runner cleanup removed its exact database/account. The retained
development ledger count was 16 before and after every run (a count guard, not a
full independent financial reconciliation). SQL migration rollout to a persistent
environment is still unapproved/unperformed. Query-plan/load analysis, full
privacy-service and Redis races, crash restart, quiet hours/frequency, full
web build/CI and real authenticated delivery/submission remain open.

Follow-up review tightened concurrent dispatch assertions: every rejected call
must be the expected reminder deferral, so unrelated SQL/programming failures
cannot hide among losing callers. Added a seventh case starting from actual
fulfilled-request creation and mocked initial transport, proving finalization
commits two reminder intents relative to the saved receipt time and replay does
not resend or duplicate them. Final run passed **34/34** against exact migration
DDL in fixture `d1f4a50ad2a8`, then removed the database/account; retained ledger
count remained 16. Web typecheck, focused lint and diff checks passed.

One rerun initially reached MySQL before its socket was ready, before creating
any fixture. After checking the same container was healthy, the run above
succeeded; no database recreation or unsafe fallback was used for that startup
failure. Test SQL/container forwarding and the isolated Lima VM were stopped
after verification. Actual transports and persistent schema rollout remain gated.

## September 20 — shared delivery-policy decision prepared

Inspection confirmed `readShopperCommunicationSettings` currently returns only
branding and the shared pause flag. `WeleticMerchantSettings` already stores an
explicit nullable IANA time zone and revision, but no quiet-hour or frequency
contract exists. Do not describe those controls as connected or silently choose
the shopper's zone from locale/currency.

Decision requested: one shared per-store Loyalty + Reviews delivery policy
(recommended), or independent module policies. Shared policy should reuse the
signed owner-authorized merchant settings gateway and store time zone, preserve
the producers' existing consent/eligibility gates, and reserve capacity per
shopper transactionally before transport. Reservations must distinguish proven
unsent deferrals from uncertain attempts; retrying the same immutable message
must not consume a second slot or exceed the provider idempotency window.
No policy schema, migration, activation or delivery semantics were changed while
this architectural choice is pending. Relevant scope: L08 and R01.

Required acceptance for that next slice: DST/non-hour-offset boundaries,
cross-midnight windows, unknown time zone, simultaneous Loyalty/Reviews sends,
pause/settings changes during a claim, crash/lease recovery, original expiry
without extension, suppression/privacy erasure, and signed EN/JA/VI controls.
Whether the policy is shared or separate, provider-confirmed is not proof of
inbox delivery and no throttling policy grants permission to send marketing.

## September 20 — provider ambiguity and immutable retry SQL evidence

Added Resend/SMTP ambiguity cases. Resend persists an uncertain attempt, enforces
retry-not-before without a second transport call, then reopens the encrypted
original payload with the exact `native-review-reminder:<id>` key. The test changes
the current product title before retry, preventing a newly rendered coincidental
match from satisfying saved-content evidence. The retry preserves the original
schedule and settles attempt two. SMTP instead remains in reconciliation after
the first uncertain call, retains bounded evidence, clears the final parent token
and refuses another transport invocation.

All 36 SQL tests passed twice, including the strengthened mutable-input test in
the final run (14.64s, fixture `eb4107930785`). Exact migration rehearsal and
database/account cleanup passed; retained ledger count stayed 16. These tests
simulate a retry from persisted state in one test process, not OS process death,
and email providers remain mocked. Independent review found no ambiguity/
containment assertion blocker and prompted the mutable-input improvement above.

Full host `pnpm build` compiled successfully and passed its type-validation phase,
then failed collecting page data for the existing partner login route because
this checkout has no DATABASE_URL. No production/development credential was
substituted and no static-data/auth guard was bypassed. Provider configuration
warnings were also present. Therefore full web build remains **failed**, not
accepted from the successful compile phase. A parallel default-memory standalone
typecheck exhausted the 4 GB Node heap; this is retained as failed evidence.
Focused ESLint and diff validation passed. The isolated SQL service and VM were
stopped after cleanup.

The standalone typecheck rerun with `NODE_OPTIONS=--max-old-space-size=8192`
subsequently exited zero. A fresh focused run passed 238 tests in 17 collection,
reminder, delivery-history and merchant-projection suites. All changed/untracked
TypeScript/TSX files passed Prettier checks. A full build rerun now uses a new
restricted disposable database rather than credentials for retained data;
non-SQL provider placeholders resolve only to loopback. It preserves normal
static generation and runtime guards. Its outcome must be recorded separately.

The broader current-head review/merchant-review/outbox regression run passed
677 tests in 47 suites (29.79s). Changed web TypeScript/TSX files also passed
ESLint with zero warnings. Expected negative-test logs (unsigned cron requests
and synthetic failures) are not production execution evidence.

## September 20 — full build recovered with isolated configuration

The normal full web build now passed end to end: compilation, lint/type
validation, page-data collection, all 367 static pages, optimization and traces.
The temporary runner's `build` mode supplied fresh restricted SQL fixture
`5ea8c157471a` and loopback-only non-SQL provider placeholders. It did not use
skip-validation/static-generation flags, existing credentials, or retained
development records. The runner removed the exact fixture database/account;
the retained ledger count stayed 16. The earlier missing-DATABASE_URL failure
above remains historical evidence; it is not the current build result.

The current Shopify typecheck and production build also passed, retaining the
existing sourcemap/future-flag warnings. This is host build verification with
synthetic configuration, not a Cloudflare release image, provider integration,
installation or live delivery result. Do not deploy these verification artifacts.
SQL forwarding, the test container and isolated Lima VM were stopped after the
run. No persistent schema, CI configuration, store policy or production setting
was changed. The slice remains draft pending remaining implementation/acceptance
and PR/CI gates; the shared-versus-module delivery-policy choice is still open.

## September 20 — bounded live acceptance packet

Prepared [the live acceptance packet](review-collection-live-acceptance-packet.md)
with prerequisites, proposed limits of two test orders/three provider submissions,
an explicit no-incentive boundary, independent reconciliation and exact cleanup.
It is not execution approval. Actual recipient, schema diff, runtime identity and
delivery-policy readiness must be established before requesting the live bundle.
The shortest real reminder requires one elapsed day; altering clocks or saved
timestamps would not be live timing evidence. Provider-confirmed and inbox arrival
remain distinct. Current draft implementation and outstanding gates are unchanged.

## September 20 — receipt failure and expired-reservation regression coverage

Added four cases covering confirmed Resend/SMTP transport followed by a failed
receipt write, a late receipt losing its lease/attempt ownership, and an expired
Resend sending reservation reopening its saved content with a new lease. They
assert provider-specific containment, retained encrypted evidence, exact update
predicates and no fresh rendering or provider-key change for recovery.

The reminder-email and delivery-snapshot suites passed **54/54** tests; focused
ESLint, formatting and the 8 GB web typecheck passed. Independent review found no
assertion defect.
These are mocked boundary tests, not proof of SQL rollback, a persisted competing
owner, SMTP process-crash redrive or OS restart. Existing 36-test SQL evidence
remains separately scoped; these additions do not expand its claims. No runtime
implementation, store settings or delivery provider was changed.

The follow-up collection/reminder/delivery/merchant/outbox regression selection
passed **392 tests in 22 suites** (15.24s). Expected unsigned-cron and synthetic
failure logs are negative-test output, not live dispatch. All test processes
finished; no SQL service or provider was started for this increment.
