# Cloudflare launch topology review — September 14, 2026

Status: **proposal, not an accepted architecture or execution approval**.
Subsequent decision: Hiro approved Option A; [ADR 0034](../adr/0034-cloudflare-containers-managed-services.md)
records the accepted topology and its boundaries. The proposal below remains the
historical review; specific providers, sizing, costs and execution are not approved.
Inspected public main `1be898f728fd311d6cfae893551a02fb0a689d19` (PR #51).
This advances the persistent-services review required by ADR 0032. No resources,
credentials, DNS, schemas, installations or delivery settings were changed.

## Recommendation and decision

Retain the existing Node applications and SQL/Redis/QStash contracts. Use
Cloudflare for stateless application containers, ingress/scheduling and R2;
use separately isolated managed persistent services compatible with the current
clients. Do not turn the compatibility images into database hosts.

This is an implementation recommendation, not proof of platform acceptance.
The alternative is a Workers-native/D1/KV/Queues port. That is a substantive
runtime, persistence and queue rewrite requiring renewed financial, transaction,
privacy and concurrency acceptance, not an environment-variable substitution.

Decision needed: approve the mixed-service design for implementation, or choose
the larger Cloudflare-native rewrite. Provider account, database region/plan,
total budget and external execution remain separate gates. Existing company
resources have not been inventoried; do not purchase duplicate services.

## Source-backed dependency map

| Role                     | Current source / dependency                                                            | Proposed disposition and required proof                                                                                                                                                                                                                                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web/API                  | `apps/web/lib/prisma/index.ts`, MySQL schema in `apps/web/prisma/schema/schema.prisma` | Next.js container; external MySQL-compatible database. Preserve interactive transactions, row locks, exact arithmetic and installation fences. Run actual database-backed concurrency cases on the selected provider.                                                                                                                 |
| Authenticated middleware | `apps/web/lib/prisma/edge.ts`, `apps/web/lib/middleware/workspaces.ts`                 | Requires the PlanetScale HTTP protocol as well as native SQL. A generic MySQL URL alone is insufficient. Prefer a managed service supporting both current clients; PlanetScale Vitess is a candidate, not approved/proven. Otherwise review a maintained HTTP bridge separately. Do not silently deploy the local development bridge. |
| Shopify embedded app     | `packages/shopify-app/shopify.app.loyalty-public.toml`                                 | Separate Remix container at the reserved public-dev origin. Keep the signed backend gateway, existing scope/runtime validation and pending-approval installation state.                                                                                                                                                               |
| Redis                    | `apps/web/lib/upstash/redis.ts`                                                        | Isolated Upstash-compatible REST Redis. Explicitly configure or document the existing global-client fallback to this isolated namespace; never inherit custom-app Redis credentials.                                                                                                                                                  |
| General durable jobs     | `apps/web/lib/jobs/index.ts`, renewal sweep handler                                    | Retain QStash publication, signed callbacks and persisted failed-publication recovery. Replacing it with Cloudflare Queues is a separate adapter/semantics project.                                                                                                                                                                   |
| Loyalty outbox           | `apps/web/scripts/loyalty/run-outbox-worker.ts`                                        | Separate supervised Node consumer using existing database leases. This process does not enqueue all periodic sweep work or replace QStash. Prove graceful drain, crash/restart and stale-generation rejection.                                                                                                                        |
| Periodic work            | Loyalty outbox, Shopify compliance/session-renewal and queue-retry routes              | Cloudflare scheduler invokes only reviewed fixed routes using current server-side authentication. Preserve individual scheduling and reconciliation responsibilities; do not copy every unrelated Dub cron.                                                                                                                           |
| Private exports / media  | `apps/web/lib/storage.ts`                                                              | Separate public and private R2 buckets via existing S3-signing client. Private bucket has no public hostname/access. Prove export expiration, erasure, authorization and exact-object cleanup. No FUSE dependency is needed for this client.                                                                                          |

Native MySQL and HTTP SQL must refer to the **same isolated database and schema**.
HTTP protocol compatibility alone does not prove Vitess query/transaction
compatibility. Do not replace MySQL with Postgres or D1 under this proposal.
PlanetScale documents separate Vitess/MySQL-compatible and Postgres products:
[provider plans](https://planetscale.com/docs/planetscale-plans).
Redis and QStash have separate usage pricing:
[Redis](https://upstash.com/pricing/redis),
[QStash](https://upstash.com/pricing/qstash).

## Runtime and scheduler requirements

1. Ingress must preserve the approved Host, query, cookies, raw webhook body and
   request authentication. Deny unknown hosts; do not cache private responses.
   Keep `loyalty-shopify-dev.weletic.com` paired with
   `loyalty-api-dev.weletic.com`. These are reserved configuration values, not
   verified deployed endpoints. Do not substitute the older generic runbook's
   production domains or change the custom-app TOML.
2. Set `WELETIC_ENFORCE_CRON_AUTH=1` and provision an isolated `CRON_SECRET`.
   `should-enforce-cron-auth.ts` otherwise checks `VERCEL=1`; Cloudflare hosting
   alone does not activate that guard. GET currently uses a bearer secret,
   despite the verifier's Vercel-specific name. POST requires a valid QStash
   signature. Keep production QStash signing keys and callback verification;
   never reuse development keys or disable checks to exercise a route.
3. The current Vercel manifest schedules loyalty outbox every five minutes and
   general queue retry every minute. The outbox route enqueues points expiry,
   tier review and reward-expiry reminders before consuming a bounded batch.
   Running the standalone CLI alone would miss those sweeps. Queue retry also
   performs the authoritative compliance recovery sweep (batch size three), so
   preserve that minute-scheduled responsibility. The dedicated compliance route
   is not independently scheduled. Session renewal is absent from the manifest;
   define and test its cadence from renewal deadlines before activation. Birthday
   scheduling and financial webhook recovery also need end-to-end evidence;
   this table does not establish a complete scheduler deployment.
4. Keep one independently supervised outbox consumer initially; scheduling
   requests may still overlap it, so database leases remain authoritative.
   Test duplicate schedules, mid-batch stop, ambiguous delivery, backoff,
   dead letters and independent queue-age alerts. A live PID is not job health.
   Preserve execution-time bounds when moving from Vercel: queue retry's Redis
   lock lasts 600 seconds and assumes the enclosing execution cannot outlive it.
   A Next/Vercel `maxDuration` declaration alone is not a container watchdog.
5. Containers' inactivity behavior must not silently stop the consumer.
   Implement and test lifecycle restart/drain hooks; do not set infinite idle
   life as a substitute for recovery. Cloudflare supports scheduled starts via
   [Cron Triggers](https://developers.cloudflare.com/containers/examples/cron/).
6. Keep optional real email delivery disabled until the separate sender,
   suppression, privacy and live-delivery gates pass. Audit any logger/provider
   initialized by the full application before supplying external credentials.

Cloudflare documents ephemeral container disks, `linux/amd64` images, default
inactivity shutdown and SIGTERM handling. Therefore durable SQL, sessions,
queues and private exports must survive outside those disks.
[Container lifecycle](https://developers.cloudflare.com/containers/concepts/architecture/).
All three locally verified image tags were independently inspected as
`linux/amd64` during this review. No image was uploaded.

## Sizing, placement and cost boundary

The measured 2 GiB/two-CPU runtime profile is **not** a Cloudflare instance
selection. Current custom types require at least one vCPU and at least 3 GiB
memory per vCPU. A proposed sizing experiment is web at one vCPU/3 GiB/4 GB
disk, Shopify at `basic` (quarter vCPU/1 GiB/4 GB), and outbox at `basic`.
None of those reduced-CPU profiles has been tested against real workloads.
The 6 GiB build cap is not a runtime requirement or approved cloud allocation.
[Instance limits](https://developers.cloudflare.com/containers/platform/limits/).

For an illustrative 30-day, continuously active deployment of those three
instances: 5 GiB provisioned memory and 12 GB disk cost about USD 34.58 before
included allowances; add the USD 5 Workers plan. CPU adds up to USD 77.76 at
continuous aggregate capacity of 1.5 vCPU. Thus approximately USD 39.58–117.34
is a **partial container-plus-base-plan sensitivity range**, not a quote,
budget cap or usage forecast. It excludes additional Workers/Durable Objects,
logs, networking, image builds, database, Redis, QStash, R2, email and taxes.
Memory/disk accrue while active even when CPU is idle. Rates checked September
14: memory 0.0000025/GiB-second, disk 0.00000007/GB-second and CPU
0.000020/vCPU-second. Account-wide included allowances are not assumed unused.
[Cloudflare pricing](https://developers.cloudflare.com/containers/platform/pricing/).

APAC placement is a candidate for evaluation beside the selected database;
it does not mean Tokyo-only residency or establish transaction latency.
Cloudflare supports regional placement constraints, which require validating
the chosen production toolchain/configuration rather than copying the older
local-emulator pin. Confirm residency needs and measure database round trips
before choosing location or approving costs.
[Placement](https://developers.cloudflare.com/containers/concepts/placement/).

## Implementation sequence after the design decision

1. Inventory already-owned provider resources read-only; select isolated dev
   namespaces, compatible database service, region and explicit total budget.
   No account credentials or customer data belong in the public repository.
2. Add a reviewed deployment configuration and role-specific production
   entrypoints. The existing probe deliberately supplies synthetic configuration;
   it must never become the production entrypoint. Build fresh release images
   with approved nonsecret public origins and inspect emitted client assets for
   wrong domains; runtime environment injection cannot be assumed to replace
   build-time public values. Never place secrets in image layers or build logs.
   Add fail-closed preflight for
   identity, paired origins, cron auth, SQL endpoint pairing, private storage and
   secret separation. No schema/data contract changes are implied.
3. Repeat bounded startup, request handling, authenticated middleware and real
   isolated database tests using the proposed CPU/memory limits. Resolve local
   emulator resource enforcement before a heavy emulator run. Add cold/warm
   browser, concurrent request, shutdown and no-private-log evidence.
4. Specify scheduler ownership, exact cadence, provider callback paths and
   alert thresholds. Test all required work, including renewal publication and
   failed-publication recovery; do not accept synthetic worker batches as delivery.
5. Review a target-specific schema diff, backup/restore and rollout order using
   the existing runbooks. Only then request a separately bounded cloud canary
   execution approval. No generic schema push or legacy-data reuse.
6. After approved deployment, verify fresh public install/reinstall and extension
   ownership, then named `yamaxdev` loyalty lifecycle and privacy/ops acceptance.
   Production `weletic.com`, listing submission and old-app uninstall stay gated.

## Completion disposition

This review identifies necessary deployment work; it does not check off any
live acceptance item. Full loyalty completion still requires the
[unified matrix](unified-acceptance-matrix.md), including remaining analytics,
imports, merchant/shopper surfaces, communications, real Flow and release gates.
The architecture decision must be recorded as accepted only after Hiro chooses;
this proposal must not be cited as deployment or spending authorization.
