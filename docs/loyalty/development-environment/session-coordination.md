# Shopify session coordination — implementation evidence

Decision: [ADR 0017](../../adr/0017-durable-shopify-session-coordination.md).
Scope: the approved dedicated coordination table and isolated MySQL validation.
This delivers the local coordination boundary, not installation, live token-renewal,
or package 1 acceptance.

## Database boundary

The additive SQL creates only `WeleticShopifySessionCoordination`. Credentials
remain in the encrypted SDK session payload. The coordination key includes the
configured app identity and canonical shop; this does not make the existing
session table support multiple Shopify apps sharing one database.

Each acquisition must supply its original observed revision and lease generation.
An active retry may recover that same untouched acquisition, but cannot gain a
new generation or a newer session revision. Renew and publication lock the row
before evaluating database time in a new statement; MySQL timestamps otherwise
remain fixed while a statement waits past expiry.

The updated backend anchors and revisions legacy writes in the same table. Once
a shop has entered coordinated acquisition, that backend rejects uncoordinated
mutation clients. This does NOT protect against an old backend instance that
still writes without the fence. New clients never fall back on a conflict.
Legacy generation bootstrap remains separately gated; it is not a coordinated
token refresh or permission to reconnect a frozen installation.

## Mandatory rollout order

1. Pause session mutation/token-exchange traffic; keep the existing app identity
   fixed for this database. Confirm the non-secret `SHOPIFY_API_KEY` matches in
   both web and Shopify runtimes. The isolated launcher derives both from its
   pinned, reviewed app configuration; it never inherits an ambient app key.
2. Stage the additive table on the explicitly approved target and validate it.
3. Deploy the updated backend everywhere and drain every old backend writer,
   including requests already in flight. Do not enable the new SDK while old
   backend instances can still accept legacy session writes.
4. Deploy the coordinated SDK, verify the distinct `/sessions/coordinated`
   endpoint, then resume only approved test traffic. A missing endpoint fails
   closed; it is not proof that all old writers have been drained.
5. For rollback, pause mutation traffic first and preserve the additive table.
   Rolling back to an old backend does not restore the coordination guarantees.
   Do not reset epochs or delete rows to allow a legacy client to write again.

Retained/deployed environment changes are not applied by this PR. Their app-key
configuration, database staging and traffic drain need an explicit rollout gate.

## SDK and privacy behavior

The wrapped admin, unauthenticated-admin and app-proxy operations acquire before
the SDK can refresh. Async operation context covers newly constructed sessions;
object observations preserve the earlier version for delayed 401 invalidations.
The SDK transport renews ownership immediately before a token request and consumes
its complete, JSON-validated response within 15 seconds and 64 KB. An uncertain
exchange, publication or malformed acknowledgement invalidates the operation.
No token exchange runs inside a database transaction or retries within a lost
operation. Contention is a retryable service failure, not a reconnect signal.

The snapshot rejects divergent SDK/projection tokens and installation generations
before provider I/O. Token-less invalidations and absent sessions retain the
projection observation; only authenticated SDK exchanges may publish replacement
credentials. The metadata survives ordinary session deletion and uninstall.
Shop erasure removes it under the existing store/tombstone lifecycle fence.

Both runtimes use the reviewed app identity. The privacy HMAC key remains only in
the web runtime and private ignored configuration, never Shopify's environment or
logs. Fresh isolated setup generates a new key. A pre-existing empty environment
can explicitly initialize a missing key once; no existing key field is replaced.
Keep all application writers paused during this operation. An advisory MySQL lock
serializes initializers but does not block arbitrary application writers.

## Isolated commands

Run only from the separate `weletic-room-loyalty-dev` checkout. Commands reject
retained dotenv overlays, foreign credentials, a different database/user, or a
different Docker project/loopback port. No app runtime or provider is started.

```sh
# Default is read-only inventory; no implicit DDL or test execution.
node infra/shopify-development/session-coordination.mjs

# Explicit additive staging: target table absent; all 141 baseline tables empty.
node infra/shopify-development/session-coordination.mjs --apply-isolated-migration

# Only for an older EMPTY isolated environment missing its privacy key.
# Keep runtimes/workers paused. Any existing key field or data causes refusal.
node infra/shopify-development/session-coordination.mjs --initialize-session-privacy

# Read-only Prisma diff against the staged schema; drift fails, never repairs.
node infra/shopify-development/session-coordination.mjs --verify-isolated-schema

# Production coordination helpers, native MySQL transactions, generated fixtures.
node infra/shopify-development/session-coordination.mjs --test-isolated-coordination
```

Tests use a separate Vitest configuration, not the older loyalty suites whose
database-name guards are different. Test cleanup targets only generated IDs from
the current run. Credentials and raw command failures are not printed. A failed
command requires inspection; do not reset databases or bypass its guards.

## Evidence recorded 2026-09-06

- Additive SQL generated from the model diff: one `CREATE TABLE`, no alter/drop.
- Staged only in `weletic_loyalty_dev`: 142 tables after staging.
- Live Prisma schema comparison: no difference from the checked-in model.
- Coordination primitive suite: 11 MySQL tests passed, including 16 competing
  first acquisitions, rollback, stale publication, A/B/A acquisition replay,
  delayed release/renewal, expiry crossed during a row-lock wait, scope isolation,
  and legacy-write/first-promotion contention.
- Signed production API suite: seven MySQL tests passed. Actual transactions
  cover atomic payload/projection publication, competing original observations,
  first unbound session creation, stale deletion/invalidation, divergent tokens,
  generation changes, freezes, tombstones and cross-shop proof rejection. Minimal
  fixtures use generated identifiers; the test HMAC identity provider is stubbed.
- SDK suite: 17 tests passed with the actual Shopify refresh helper and intercepted
  HTTP, including one provider invocation across competing operations. These are
  not real provider calls or deployed multi-process acceptance.
- Input-validation suite: 13 tests passed.
- Full Vitest run: 4,097 passed, six skipped across 270 files. A subsequent privacy
  configuration follow-up passed all 54 isolated-runtime/preflight tests.
- Root formatting/lint, web/Shopify type-checks, both production builds and Prisma
  validation passed. The web build generated 358 static pages against the empty
  isolated database; its earlier inert database URL intentionally could not
  satisfy the existing public-program page generator. Separate CI-style validation
  avoids repeating the independently passed lint/type checks inside that build.
- Nine legacy simulator CLIs passed in mock mode. Referral simulation requires the
  synthetic test privacy key. These do not establish live financial, Shopify Flow,
  email, backfill or merchant acceptance; persisted analytics/backfill gates remain.
- Read-only backfill validation found zero findings in the empty isolated database;
  its `readyToEnableCommits` result is vacuous for merchant history and does not
  authorize enabling commits. Analytics validation correctly stopped because this
  database has no installed `yamaxdev` store or accounting program yet. Neither
  result replaces merchant financial reconciliation or the historical repair gate.
- Privacy initialization: both local app ports were closed and all 142 tables were
  empty before one key was added. Replay was refused and the existing private file
  checksum stayed unchanged. Both runtime configurations passed without startup.
- Independent adversarial review: reported findings fixed and re-reviewed clear.

## Remaining gates

PR [#60](https://github.com/satoshicancode/weletic-room/pull/60) merged with
Hiro's approval on 2026-09-06 as `8cd0ce881471d0eb6f7594b961c2f3baadc9611f`.
Fast Quality and Full Release gates passed before merge; the post-merge Fast
Quality gate also passed. Public endpoints, installation and provider calls
remain separately gated. No retained database migration or live merchant
mutation was performed.

Scheduled renewal, reconnect alerts and real install/reinstall acceptance remain
required parts of package 1, not replaced by the primitive tests above.

## Renewal-readiness follow-up

Local verification on 2026-09-06: 4,146 Vitest tests passed and six skipped across
271 files; 65 focused authority/SDK/response tests passed; 19 isolated MySQL
tests passed, including reconnect-before-renewal rejection and rollback. Web and
Shopify type-checks/builds, root lint, scoped formatting and Prisma validation
passed. The independent review's two findings were fixed and re-reviewed clear.
These tests use synthetic identities/intercepted provider HTTP, not live Shopify.

The signed `GET /api/internal/installed-admin-session?shop=...&generation=...`
endpoint requires the original non-null installation generation captured by a
background job. Its SDK operation refuses an absent installed credential binding,
checks that generation before entering the SDK, and revalidates the original
snapshot at the pre-provider lease renewal and before returning its result.
Publication continues to use the existing transaction fence. A remote call cannot
be made atomic with a later reinstall; the database validation orders the local
operation, and stale publication still fails closed after an in-flight reconnect.

The ordinary interactive authority endpoint remains available. Supplying a
generation to that legacy endpoint is rejected rather than ignored. New callers
select the distinct installed endpoint and validate its generation acknowledgement;
an older runtime without that route fails closed. Deploy the observation-aware
web renewal endpoint before the updated Shopify adapter, then drain old adapters
before activating background work. The optional observation field permits the
previous adapter's heartbeat during this transition, but does not upgrade its
pre-provider checks.

Only a typed `SESSION_MISSING` response is classified as `AUTH_EXPIRED`; installed
responses must also match shop and generation. Lease conflicts, throttling,
unknown 4xx, routing 404s, malformed responses and short-lived returned credentials
remain retryable. Service-auth failures stay separate. Raw SDK/provider errors
never leave the response. The HTTP response body shares the original ten-second
deadline and is limited to 32 KB; null/array/invalid-expiry envelopes fail closed.

This increment does not register a scheduler, persist reconnect incidents, send
alerts, or migrate another schema. Next implementation must add bounded keyset
dispatch through the app-level job infrastructure, generation/observation-fenced
incident writes and merchant visibility, then approved live acceptance. It must
not treat a bare SDK 500 as proof of an invalid refresh token. The installed
Shopify Remix 4.2.1 helper refreshes within five minutes of access-token expiry;
scanning earlier and merely calling it does not prove renewal. Shopify's
[expiring-token guidance](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens)
and [refresh recovery contract](https://shopify.dev/changelog/more-resilient-refreshes-for-expiring-offline-access-tokens)
remain the provider references, not a substitute for live test evidence.
