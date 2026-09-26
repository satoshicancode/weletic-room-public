# Testing-first plan reconciliation — September 26, 2026

Execution plan for the August 27–September 26 review window. The
[core launch checklist](core-launch-checklist.md) remains the product authority.
The new testing-first goal does not reactivate the deferred parity backlog.
Production is not ready; no installed acceptance gate is closed by this review.

## Sources and current authority

Reviewed the current repository plans and evidence indexes, the three matching
Notion planning documents, recent project task summaries, and all six open public
PRs. Git history was searched across the window; the clean-history public import
means a file's public commit date does not establish its original creation date.
This is a reconciliation of discoverable plans, not a claim to have recovered
every private or archived conversation.

- [September 5 six-package rollout](https://www.notion.so/3d2e26097bfd81c0a667ce21978d4fdc):
  runtime, publication, Flow, referrals, reviews and cutover; subsequent expanded
  twelve-package baseline. Its earlier target n0pvef-cs is not authorization to
  test on that store now. Canonical acceptance remains yamaxdev.
- [Public-app roadmap](https://www.notion.so/3d2e26097bfd81079fe5dfe9036c3d9a):
  public identity, isolated runtime, native interfaces and controlled release.
- [September 16 completion plan and September 26 reset](https://www.notion.so/3dde26097bfd811fbd84f212b6d67fe5):
  current approval and execution record; latest reset supersedes parity order.
- [Company-store contracts](company-store-completion.md),
  [requirement matrix](unified-acceptance-matrix.md),
  [readiness index](v1-launch-readiness-2026-09-24.md),
  [native-review history](native-reviews-plan.md), and ADRs 0038, 0040–0045.
- Recent project chats: “Audit Weletic Room loyalty”, “Ship basic review app”,
  “Plan Smile-like loyalty features”, “Report progress and plan remaining”, and
  “Rà soát công việc Gemini 3.8”. Their old completion claims retain their original
  repository, version and capability boundary; current code/CI takes precedence.

Current source: public main `c86f216e87c6cc71ccb799b8a7f94e700b5a1c6b`;
core candidate `808a1cf533abc42d5ee006537c508a0e8ce4477d` before this follow-up.
The original historical-import checkout and all other unfinished branches remain
untouched. Six open PRs were re-read/listed on September 26:

| PR                                                                    | Disposition                                                                                                                                                                                               |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [176](https://github.com/satoshicancode/weletic-room-public/pull/176) | Core launch candidate; draft, all six checks green at 808a1cf533; schema/installed acceptance still open.                                                                                                 |
| [173](https://github.com/satoshicancode/weletic-room-public/pull/173) | Refund allocation evidence; draft with additive schema. Evaluate for independent core refund reconciliation; do not merge or apply blindly. Its validator currently rejects legacy unavailable histories. |
| [175](https://github.com/satoshicancode/weletic-room-public/pull/175) | Provider payload/budget sensitivity evidence. Keep as proposal input, not spending approval.                                                                                                              |
| [174](https://github.com/satoshicancode/weletic-room-public/pull/174) | Advanced VIP reporting documentation; outside launch critical path.                                                                                                                                       |
| [158](https://github.com/satoshicancode/weletic-room-public/pull/158) | Import full-scale process handoff; preserve, defer to P3.                                                                                                                                                 |
| [106](https://github.com/satoshicancode/weletic-room-public/pull/106) | Import provenance index, schema-gated; preserve, defer to P3.                                                                                                                                             |

## Consolidated requirement disposition

These rows retain every L01–L10, R01–R10 and S01–S06 family from the prior plans.
Exact tests and boundaries remain linked from the original requirement matrix.

| Family | Required before core launch                                                                   | Deferred work                                         |
| ------ | --------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| L01    | Purchase earning, ledger concurrency/idempotency, partial/full refunds and recovery           | Signup/birthday and configurable expiry               |
| L02    | Fixed native coupons, wallet/history, issuance/recovery/checkout/refund                       | Other discount and stored-value types                 |
| L03    | Contain subscription-specific earning and preserve existing obligations                       | Contract-level subscription cadence acceptance        |
| L04    | Keep new VIP/campaign activity disabled; preserve historical accounting                       | VIP/campaign journeys                                 |
| L05    | No new referral activity                                                                      | Claims, benefits, abuse, refund and delivery journeys |
| L06    | Existing launcher usable with core content                                                    | Advanced appearance/nudges                            |
| L07    | Account hub and theme launcher, EN/JA/VI, mobile/keyboard and recovery                        | POS/Plus/expanded surfaces                            |
| L08    | Transactional review invitation delivery, suppression and privacy                             | Growth communications and deferred feature notices    |
| L09    | Balances, ledger, reward status and operational reconciliation                                | Advanced analytics, cohorts and exports               |
| L10    | Compatibility for any shared readers; no import activation                                    | Historical imports and scale work                     |
| R01    | Verified invitation/submission, seven-day delay, thirty-day token, no historical sends        | Configurable reminders                                |
| R02    | Manual moderation, replies, stars/listing, low-rating neutrality                              | Advanced presentation                                 |
| R03    | Preserve shared privacy readers; no open submissions                                          | Open review eligibility/anti-abuse                    |
| R04    | Immutable prospective participation policy and honest disclosure                              | Coupon/photo bonuses and richer policy UI             |
| R05    | Exactly one points award per order, recovery and enrollment rules                             | Coupon fulfillment                                    |
| R06    | Existing obligations, audited invalidity and privacy; hiding criticism never revokes points   | Additional cost/reporting features                    |
| R07    | Compatibility for shared award/privacy readers                                                | Store reviews and their collection journey            |
| R08    | Private photos, validated upload/deletion and privacy                                         | Video processing/playback                             |
| R09    | Preserve shared privacy dependencies                                                          | Q&A and manual translations                           |
| R10    | Preserve provider data until approved retirement                                              | Historical review imports                             |
| S01    | App/shop/generation identity, staff access, paid/private-free admission, suspension/reinstall | General external-merchant onboarding                  |
| S02    | Four enabled triggers and bounded points action, deduplication/revocation                     | VIP/expiry/referral Flow capabilities                 |
| S03    | Public-owned theme/account/Flow identity and minimum required scopes                          | POS/Plus-only checkout bundle                         |
| S04    | Stable testing runtime, supervision/recovery, alerts and restore before production            | Capacity expansion                                    |
| S05    | Export/erasure, retention, private media, schema compatibility and protected-data evidence    | None of the applicable privacy obligations            |
| S06    | Accurate listing, review and separately approved production activation                        | External acquisition and additional pricing tiers     |

## Execution order and proof required

1. **T0 — Reproducible local testing.** Resolve the occupied SQL port without
   terminating the existing SSH listener. Update the isolated development
   tooling's exact ownership contract and tests to support the selected owned
   Docker layout. Do not only override environment URLs. Keep loopback-only
   SQL/Redis/media and capture-only mail. Record image IDs, schema, source SHA,
   fixture generation, startup/stop/restart and bounded worker results.
2. **T1 — Core SQL and privacy stability.** Run production-service tests for
   financial races, ambiguous issuance, worker recovery, review token races,
   single awards and privacy/export races under core-v1. Add self-contained
   fixtures where a focused test currently depends on prior tests. Preserve
   deferred tests in their original profile. Run relevant types/lint/build/CI.
3. **T2 — Installed yamaxdev preview.** Prepare exact origins/routes, public
   extension identities and a setup-only packet. Obtain approval for exposure
   and installation changes before starting the tunnel. Verify authenticated
   app/shop IDs, installation generation and staff scope. No historical sends.
4. **T3 — Native billing.** The actual Partner API query now returns HTTP 200,
   no GraphQL errors, activeSubscription null for app 419628580865/shop 73236414690. Client 37492 has Manage apps only. Plan handles remain unknown.
   Verify a supported development pricing route; do not treat registration as
   necessary for all testing or fabricate live entitlement. Paid/private-free,
   cancellation, rejected selection, unavailable API and reinstall need proof.
5. **T4 — Installed loyalty and reviews.** Execute approved synthetic test-order,
   recipient and media packets. Purchase → earn → fixed coupon → checkout →
   partial/full refund; fulfillment → real inbox → text/photo review → one
   disclosed participation award → moderation → public display. Independently
   reconcile SQL and provider receipts, duplicates and restart recovery.
6. **T5 — Essential Flow.** Publish only the approved public-owned capabilities
   after its explicit publication gate. Retain receipts for all four triggers,
   bounded action, duplicates, revoked grants and disabled workflows.
7. **T6 — Persistent acceptance.** After exact resource/budget approval, audit
   target schema and compatible migrations, deploy the accepted candidate,
   rehearse backup restoration and supervised restart, verify alerts and private
   media/provider delivery. A laptop preview cannot establish durable hosting.
8. **T7 — Production eligibility.** Freeze evidence and SHA; complete honest
   privacy/listing/reviewer materials and Shopify approval. Only after separate
   activation approval enable one company store, monitor 72 hours, and obtain
   retirement approval before removing existing apps/provider data.

## Files, contracts, migrations and risks

Implementation touches existing `infra/shopify-development` tooling,
`apps/web/tests/weletic` integration fixtures, and production service modules only
when a verified test failure requires a fix. Update this record and the canonical
checklist as evidence arrives. Preserve the existing ledger, issuance saga,
participation policy, authorization and installation-generation contracts.

No new shared migration is authorized here. Local synthetic databases may receive
reviewed compatible schemas. The subscription snapshot and any selected refund
allocation DDL need exact-target review before shared application. Deferred tables
may remain necessary for shared privacy readers.

Current risks: local runner scripts are temporary; full core privacy coverage is
incomplete; broad legacy SQL has a known deferred referral failure; current
public version still points at example.com; hosted plans, real inbox, actual
Flow workflows, provider restore and protected-data approval remain unproven.
A passing API query with null subscription proves query compatibility only.

## First execution slice

Add a self-contained core SQL regression for review erasure after billing expiry,
using two independently created shoppers and real transaction boundaries. Assert
one participation award each before erasure, retained append-only financial rows,
redacted target content/tokens, unchanged other-shopper state and idempotent
completion. Email/storage remain mocked; do not label this an inbox/R2 test.

## First-slice validation

The focused core SQL selection passed 10 tests (117 unselected/skipped), then the
new privacy case passed by itself with the strengthened account/claim assertions.
Both runs used the existing scoped local MySQL database; no shared schema or
external side effect. The test remains synthetic and does not prove photo deletion,
real inbox delivery or the full customer export/erasure workflow. Independent
review identified a missing target-account/claim assertion; it was added and the
reviewer found no further actionable issues. Exact follow-up CI belongs to PR176.

## Reproducible local services checkpoint

The local tooling now supports explicit private SQL host ports, retaining
3307/3902 defaults. Initialization, runtime/preview, service verification and
local schema helpers share the same validated declaration. Docker ownership,
loopback binding, database/principal and private-file restrictions remain in force.
Validation: 74 focused tests across four suites, web type-check, focused ESLint,
format checks, independent review, and an actual Compose model showing exactly
one selected binding per SQL service.

Local execution on September 26 moved SQL to 13307/13902 without disturbing the
SSH listener on 3307. The existing local credentials were copied to the current
core worktree without rotation; the older checkout is untouched. Existing Redis
and media volumes remain in use with read-only credential mounts from the current
worktree. The old MySQL volume failed exact-grant isolation because its user also
has grants on older import/access-test schemas. Its data and grants were preserved.

The current core SQL service instead uses a new named Docker volume,
`weletic-loyalty-dev_mysql-core-20260926`. Its initial grants already matched the
strict exact-schema policy; a guarded repair attempt refused unexpected input and
made no grant changes. All 13 live service checks then passed. The empty local
schema staging command completed with 177 tables and zero imported records.
The standard four-file environment preflight passed all 16 checks, reporting
`configuration_consistent` and `liveReady: false`.

The current local Compose invocation must include all three files:

```sh
docker compose -p weletic-loyalty-dev \
  -f infra/shopify-development/compose.yaml \
  -f .env.loyalty-secrets.local/compose-ports.yaml \
  -f .env.loyalty-secrets.local/compose-core-volume.yaml ps
```

Keep the private overrides with the credentials. Omitting the volume override
selects the preserved older volume; do not operate on it as the core database.
No application process, tunnel, Shopify installation, email send or worker was
started by this checkpoint. Full runtime launch still needs the core billing
configuration; actual hosted plan handles remain unverified. Local `db push`
proves current-model compatibility only, not shared migration history or deployed
acceptance. Draft PR176 remains unmerged.

## Free billing revalidation checkpoint

The public-plan zero-dollar contract was already guarded by authenticated Admin
API `shop.plan.partnerDevelopment`; redirect parameters cannot supply this flag.
The SQL suite now proves production-store denial without provisioning, development
and private-free admission, denial after loss of development status or an unknown
private plan, recovery after a fresh accepted contract, and denial on Partner API
failure. Existing paid admission, suspension, expiry, stale HTTP and reinstall
cases also pass: six SQL tests total in the isolated `core_billing_test` database,
using a new database-scoped synthetic principal on the owned test container.
The test runner accepts an explicit `CORE_BILLING_DATABASE_PORT` while preserving
its loopback, database-name and opt-in guards; the default remains 65366.

These provider responses are mocked. This checkpoint does not prove a real
Shopify charge selection, private plan, cancellation/freeze or installed benefit
journey. The actual dashboard still redirects the documented pricing setup path
to registration. No registration, payment, Shopify permission change or billing bypass was
performed. Continue independent testing while hosted-pricing setup remains deferred.

## Local review-photo storage checkpoint

An explicit `CORE_REVIEW_MEDIA_DATABASE_TEST=1` test now binds production storage
upload/delete methods to the owned local SeaweedFS endpoint and private bucket.
The normal DB suites continue using mocked storage. The opt-in case refuses any
fetch outside `http://127.0.0.1:9002`; service ownership verification passed before
execution. It creates a unique synthetic buyer, invitation, photo and sibling
object, and cleans up only their exact test keys.

The check proves actual PNG-to-WebP upload, SQL ownership/size metadata, denied
anonymous reads, signed local reads, and rejection of public delivery before
publication. The photo is attached through review submission, then published,
hidden and republished through the production moderation service. Public delivery
returns the actual signed bytes only in the published state. The previously
unenrolled shopper still has no loyalty account after submission/publication.
After billing expiry, an injected deletion failure leaves the media
row pending and the object present. A production cleanup retry deletes the exact
object (signed GET returns 404), preserves the sibling bytes, and replays without
another delete. Production runtime behavior is unchanged.

The initial standalone upload/erasure case passed. The expanded submission and
publication case passed in the combined core selection:
11 tests with 117 unselected/skipped, including the prior privacy, financial
concurrency and low-rating/publication cases. The separate billing SQL suite
passed six tests; pricing unit tests passed seven. Web type-check, focused ESLint,
formatting and independent adversarial review also passed.

Limits: invitations, merchant actor identity and Redis serialization are synthetic;
the privacy projection is explicitly seeded through its service helper. No real inbox,
merchant moderation UI, R2 provider, installed Shopify workflow or production
deployment is proven here. Published-photo delivery is proven only at the local
production-service boundary. The installed review journey and full privacy-race
acceptance remain open.

Hiro explicitly chose to keep App Store registration deferred and continue free
tests. Do not infer payment, new permissions or public-preview approval from this
choice. The previous revision cde56a1c68 completed CI successfully in run
36248314162; new test changes need their own exact-head CI.

## Core fixed-coupon SQL checkpoint

The reward lifecycle suite now runs in `core-v1` with only fixed-value amount-off
coupons. It seeds synthetic app/installation-generation subscription authority in
the guarded disposable database and leaves production entitlement checks active.
The original five reward variants remain covered outside the core profile.

Three core SQL cases passed: issuance/replay with ambiguous-response reservation
and terminal compensation; used-coupon partial/full order-refund reconciliation;
and competing wallet reservations while the first remote issuance waits. The
tests independently compare persisted ledger sums with cached balances. Expiring
the subscription explicitly denies the new-benefit gate while existing coupon
expiry/deactivation, late-use correction and refund obligations still settle.
The same three cases also passed in the legacy profile after fixture cleanup.

An explicit `LOYALTY_REWARD_DATABASE_PORT` permits the owned local test container
on port 53041; the default remains 3309. Loopback, opt-in, random schema name,
matching scoped principal and SQL database/principal identity checks remain.
The schema was created fresh with a unique principal; no shared schema or older
test container was changed. Web type-check and focused lint/format checks passed.

Shopify discount responses and Redis locks are mocked, and order earning inputs
are seeded. This proves local SQL/service behavior, not a real checkout, signed
webhook, actual worker-process restart or complete ambiguous-issuance recovery.
Those installed acceptance requirements remain open. Registration stays deferred.

## Ambiguous-coupon recovery correction

The next SQL regression exposed a production worker defect: generic provisioning
recovery verified the immutable discount configuration but omitted its saved
`currencyVerifiedAt` when invoking transactional adoption. The adopter correctly
refused an undefined currency generation, so even an unchanged, matching coupon
took deactivation/compensation instead of being recovered as issued.

The worker now passes the immutable snapshot timestamp into the existing check.
It does not substitute the current timestamp or weaken the currency fence. The
new core SQL cases prove that a lookup miss and foreign ownership retain the
reservation; a later matching coupon is adopted once after billing expiry; and a
currency-verification change during remote lookup requires confirmed deactivation
before one compensation entry. Both replay paths preserve independent ledger sums
and account balances without another create, debit or refund.

Validation: five core SQL cases passed; the two new cases also passed alone;
the three legacy cases passed with the two core cases skipped. The focused outbox
and discount-saga unit suites passed 137 tests. Final web type-check (8 GB Node
heap), focused lint/formatting and the production build passed. The build reported
expected missing QStash-token warnings in this isolated environment. Independent
adversarial review found no blockers. Preceding commit `15367a76c2` completed all
CI checks in run `36249446881`; the correction needs its own exact-head CI.
Shopify responses remain simulated and Redis locks bypassed;
this closes the specific SQL/service recovery gap, not actual Shopify consistency,
worker-process restart or deployed acceptance. Registration remains deferred.

## Core Flow and review crash checkpoint — September 27

The isolated Flow action suite now seeds generation-bound subscription authority
for core fixtures while retaining the production entitlement service. All 29
core SQL cases passed; the new billing lifecycle case also passed alone. Legacy
compatibility passed 28 cases with the core-only case skipped. Coverage includes
owner authorization and signed internal grant requests, exact budget arithmetic,
concurrent replay, revocation, stale generations, privacy, and rollback.

The new case proves billing expiry rejects a fresh credit with no receipt, ledger,
budget or outbox changes. Existing receipts replay and bounded owner-authorized
debits remain accounted for. A fresh synthetic verification allows the rejected
run to apply exactly once; revoked authority then blocks new debits while old
receipts remain readable. Independent SQL sums match cached balances. Only
metafield-sync jobs are queued; the adjustment does not recursively emit Flow
award events. `FLOW_ACTION_DATABASE_PORT` permits the owned local port 53041,
retaining the default 3307 and existing loopback/schema/principal identity guards.

Review crash fixtures previously launched their child without the core profile.
The child now receives the explicit core profile and synthetic app/privacy
identity, so its production transaction follows the same release restrictions as
the parent. Actual SIGKILL tests before and after commit pass for moderation and
participation points: one durable audit or award, independent balance sums, one
points-earned Flow event and no deferred tier job in core mode. Legacy retains
its expected tier job. The bounded selection passed seven cases in each profile
(121 unselected/skipped): four process-crash cases plus Flow event deduplication,
outbox worker contention and stale-lease recovery.

The existing shared review-owner privacy selection passed 15 cases on a fresh
isolated schema under core-v1 (113 unselected/skipped), including key retirement,
backfill rollback, exact source reconciliation, suppression-aware public queries,
key rotation and source erasure. The initial reused-database run passed 13 and
failed two fixture assumptions: global audit pagination exceeded its test bound
and old audit rows prevented installation of the failure-injection constraint.
That run is not counted as green. Use a fresh schema for this selection; no
production behavior or assertions were relaxed to obtain the clean rerun.

Final web type-check, focused lint/formatting and independent adversarial review
passed. Runtime source is unchanged from the preceding recovery correction,
whose production build passed.
Recovery correction `11bac84feb` subsequently passed every CI check in run
`36250391127`, including the full unit suite and final quality gate. This newer
test-only slice still requires its own exact-head CI.

These are local SQL and production-service boundaries with synthetic authority
and invitation promises. The signed internal grant test is not Shopify action
ingress or a real workflow receipt. Process-crash reconciliation is proven for
the review transaction; deployed worker supervision, stable provider delivery,
real inbox and installed-store acceptance remain open. No production code,
shared schema, Shopify configuration or registration was changed in this slice.

## Captured invitation journey — September 27

The opt-in `CORE_REVIEW_MAIL_DATABASE_TEST=1` selection passes three localized
core journeys (EN/JA/VI). It delegates to the production Nodemailer sender and
captures SMTP at owned local MailHog port 11026, with its read/delete API on
loopback port 18026. The runner checks the owned container and exact loopback
bindings. Authentication is empty and recipients are unique `example.test`
fixtures. No external inbox or transactional provider is contacted.

Each journey creates a separate shopper/account and synthetic fulfilled order.
Production invitation creation preserves its immutable points policy, seven-day
delay and thirty-day validity. Early dispatch is rejected. Only the fixture's
persisted dispatch deadline is moved into the past to exercise delivery; this
is not evidence of seven elapsed days or permission for historical sends.
Duplicate dispatch produces one captured message. The test decodes the actual
captured MIME, including Japanese base64, verifies localized disclosure that
rating/publication does not determine eligibility, and extracts the bearer token
from that message rather than from mocked transport arguments.

The captured token matches retained request authority, previews the product and
submits one one-star review. Replay is rejected. One 100-point ledger award is
made before publication. Manual publication displays a verified, incentivized
review; hiding it removes it from the public listing without reversing points.
Award retry preserves the same ledger entry and balance. Cleanup restores shared
settings and SMTP configuration and deletes only captured fixture message IDs.

The combined selection passes 14 cases (117 unselected/skipped), including core
billing expiry, privacy cleanup, actual private-photo storage, token concurrency,
publication deduplication and ledger/refund accounting. The first combined run
found test-fixture balance contamination; dedicated shoppers/accounts fixed it
without changing production behavior or weakening the negative-balance check.
Final web type-check, focused lint/formatting and independent adversarial review
passed. This slice changes tests and evidence only; the preceding production
build remains applicable to runtime source. Exact-head CI is still required.

The local inbox is capture-only, and submission/moderation use production service
calls with synthetic authority. External inbox delivery, browser navigation,
authenticated merchant moderation, installed Shopify billing and deployed
acceptance remain open. Registration remains explicitly deferred.

To repeat just the captured-email selection, first verify the owned capture-only
MailHog container is running with ports 1025/8025 bound only to
`127.0.0.1:11026`/`127.0.0.1:18026`, with no external relay. Use the private,
scoped SQL test environment described in [free-first acceptance](free-first-acceptance-2026-09-26.md#reproducing-the-focused-sql-selection).
From `apps/web`:

```sh
LOYALTY_DATABASE_INTEGRATION=1 WELETIC_FEATURE_PROFILE=core-v1 \
  CORE_REVIEW_MAIL_DATABASE_TEST=1 \
  pnpm exec vitest run --config vitest.loyalty-db.config.ts \
  --testNamePattern 'core captured SMTP invitation'
```

The ordinary suite skips these cases unless both opt-ins are present. The token
is a local synthetic credential; do not publish captured messages or token URLs.

## Core customer and reviewer copy reconciliation — September 27

Captured invitations exposed a scope mismatch: participation-only core promises
still described deferred media bonuses and store reviews. Core-v1 now presents
the exact capped participation amount, one reward per order, rating/publication
neutrality and explicit enrollment requirements in EN/JA/VI. The amount uses
integer arithmetic over the saved base and cap. Existing promises with media
bonuses, coupons and historical null policies retain their existing disclosure;
durably prepared retry messages are not rewritten.

Focused disclosure/coupon/form tests pass 58 cases, including caps below the base,
zero caps and values above JavaScript's safe integer range. The combined local
SQL/storage selection passes 14 cases; the three captured emails exclude deferred
bonus/store-review claims and contain the same disclosure as their form previews.
Web type-check, focused lint and independent adversarial review passed.

The [reviewer packet](app-store-reviewer-packet.md) now matches the approved core
policy: US$500 public subscription, private-free company plan, verified subscriber
provisioning, points-only review incentives, required theme/account surfaces and
the five essential Flow capabilities. Its old free/company-only/manual-admission
description is superseded. This is a draft preparation correction, not a public
listing edit or evidence of installed reviewer acceptance.

## Core merchant Reviews interface — September 27

Source inspection found a functional gap: loading review participation settings
also requested the coupon catalog, whose endpoint is unavailable in core mode.
The failed catalog request prevented the supported settings from loading. Core
mode now loads the policy without that deferred dependency or coupon search UI.

The Reviews page uses its existing core context to hide open-submission,
store-review and manual-translation panels. The incentive editor offers only
none/participation-points policies and hides media bonuses. Existing saved
disclosures remain readable, but incompatible drafts cannot activate. No
historical policy is rewritten by rendering the editor.

Core collection settings omit automatic publication and reminders. An explicit
EN/JA/VI notice explains that saving turns those settings off, and the existing
confirmation, revision/generation checks and ambiguous-write recovery remain in
place. Legacy mode retains its existing controls and behavior.

The focused UI selection passed 54 tests and the merchant Reviews page passed
16, covering all three languages and legacy behavior. Formatting, focused lint
and independent adversarial review passed. Web and Shopify type-checks passed.
The local web production build using the existing `loyalty-only` release profile
and the Shopify Node production build passed. Standalone type/lint checks ran
separately, as required by the release profile. These are local compatibility
checks, not container-isolation, installed-browser or deployment acceptance.

An earlier ordinary web build was stopped after measured memory pressure
(9.1 GB process footprint and roughly 31 GB system swap); that attempt is not
counted as passing. The successful core-profile build used the repository's
existing 4.5 GiB heap/worker configuration and generated all 353 static pages.
Provider-configuration warnings under synthetic build inputs and Shopify
sourcemap warnings were emitted; both builds completed with exit zero.
No build configuration, dependencies or CI pipeline changed.
