# Isolated local services

Evidence date: 2026-09-06. Scope: the approved local-service and credential setup
within package 1. **Not Shopify installation or end-to-end acceptance.**

## Allocation and boundaries

The separate checkout is `weletic-room-loyalty-dev`, with its own installed
dependencies and ignored private configuration. The retained `weletic-room`
checkout, existing MySQL container/volume on port 3306, and both Shopify stores
remain unchanged by these provisioning commands.

| Service                  | Loopback port        | Isolation                                                                        |
| ------------------------ | -------------------- | -------------------------------------------------------------------------------- |
| MySQL 8.0                | 3307                 | New volume, database `weletic_loyalty_dev`, exact-schema non-root grants         |
| PlanetScale HTTP adapter | 3902                 | Same new database, MySQL user and server UUID as native SQL                      |
| Redis REST adapter       | 8079                 | Fresh token, new Redis volume, raw Redis has no host port                        |
| Local S3                 | 9002                 | Separate private/public buckets; bucket-scoped app key, separate bootstrap admin |
| Web / Shopify            | 8890 / 3002 reserved | Not started by these tools                                                       |

Compose project: `weletic-loyalty-dev`. Images are digest-pinned in
`infra/shopify-development/compose.yaml`. Local S3 uses SeaweedFS 4.45 for protocol
and permission testing, not as a production storage-provider migration.
See the upstream [mini server](https://github.com/seaweedfs/seaweedfs/wiki/Quick-Start-with-weed-mini)
and [credential model](https://github.com/seaweedfs/seaweedfs/wiki/S3-Credentials).
The local [SQL](https://github.com/mattrobenolt/ps-http-sim) and
[Redis REST](https://github.com/hiett/serverless-redis-http) adapters do not prove
hosted-provider equivalence or production performance.

Three backend networks are internal. A separate host-access bridge permits
Docker Desktop port publishing with inter-container communication disabled.
Every published port is explicitly bound to `127.0.0.1`; management/filer ports
are not published. **This is not a container egress firewall.** Never copy
retained transport/cloud credentials into this environment or assume a different
service URL prevents every possible cross-environment write.

## Provisioning commands

Run from the separate checkout root, after explicit local provisioning approval.
Node 24, pnpm 9 and Docker Desktop are prerequisites. Do not use the standard
`dev`, `dev:all`, sync pollers, app auto-link, tunnel or deployment commands.

```sh
node infra/shopify-development/init.mjs --confirm-local-provisioning
docker compose -p weletic-loyalty-dev -f infra/shopify-development/compose.yaml up -d
node infra/shopify-development/verify.mjs --confirm-local-probes
node infra/shopify-development/stage-schema.mjs --confirm-empty-local-schema
```

Initializer refuses existing credentials or active default dotenv overlays; it
does not rotate, copy, overwrite or start anything. Configuration files are
0600 and the secret directory is 0700, all ignored by Git. Preserve these files
alongside their corresponding Docker volumes; regenerating them is not recovery.

Verification is **not read-only**: it writes unique synthetic Redis/media probes,
removes them, and may initialize the public bucket's anonymous GetObject-only
policy when absent. It refuses a different existing policy. Anonymous writes and
private reads must fail; the runtime key must not modify bucket policies. It
checks actual Docker ownership, mounts, loopback mappings, private networks,
native/proxy DB identity, literal schema grants, system-table denial and Redis
authentication. Errors are redacted; failed checks do not authorize a repair.

Schema staging repeats those checks, scrubs inherited application credentials,
refuses nonempty databases, and runs Prisma validation plus `db push` without
reset/data-loss flags. It uses the existing checked-in model, imports nothing
and does not modify any schema source. **It does not prove migration-history
replay or historical backfill correctness.** If interrupted, inspect the new
database privately; do not drop tables or bypass the empty-database guard.

## Existing Shopify credential

```sh
node infra/shopify-development/configure-app-secret.mjs --confirm-local-credential-setup
```

Use only the existing secret for **Weletic Loyalty Reviews Dev**, client ID
`c7d49cebb06e445db345bb200f966a03`. The command opens a random-port, one-use loopback
form for five minutes. Exact Host/Origin and a random URL protect submission; no
external scripts, assets or telemetry are loaded. It writes only the two blank
private env fields and refuses another app or existing values. A partial write
fails closed and requires private inspection, not automatic rotation. Never put
the secret in chat, command arguments, reports, screenshots or Git.

The completed transfer used the Dev Dashboard's existing credential and a local
browser form. No provider secret rotation, app installation, extension publication
or remote configuration change occurred. The one-use listener was closed.

## Recorded result and remaining gates

- Actual local service verification: **13/13 checks passed** after independent
  review corrections, including escaped MySQL grant scope and private env modes.
- Original four-file configuration preflight: **16/16 passed**, including
  different retained authorities and matching new app/webhook secret.
  `liveReady` remains false by design.
- Existing Prisma schema: validated and staged into the initially empty database;
  **141 tables**, all independently checked with zero rows after staging; no
  merchant/session/history import. No migration history claim.
- Credential form: real browser submission succeeded; secret never printed.
- Twelve local-service regression tests cover secret-file permissions, scoped
  grants, policy preservation, unsafe targets, one-use configuration and actual
  HTTP rejection/concurrent-submission behavior using synthetic credentials.
- No application listener, worker, scheduler, email, webhook registration,
  Shopify install, HTTPS tunnel or extension deployment was activated.

Follow-up runtime enforcement, startup commands and evidence are tracked in
[Isolated application runtime](./runtime.md).

Next: token-refresh
concurrency fencing, scheduler rejection/renewal and reconnect alerts; reviewed
public endpoints and app configuration; canonical-shop verification followed by
separately approved install/reinstall and worker/webhook round trips.

For pause/resume, use `docker compose -p weletic-loyalty-dev -f
infra/shopify-development/compose.yaml stop` and `start`. Both preserve data.
Do not run `down -v`, prune volumes or delete credentials as cleanup. Actual
application activation must use a reviewed, scrubbed environment loader, not
the retained runtime's dotenv discovery.
