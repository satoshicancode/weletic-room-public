# Cloudflare release preparation

[ADR 0034](../../docs/adr/0034-cloudflare-containers-managed-services.md)
approves the mixed-service topology, not provisioning or deployment.

## Static paired-ingress preflight

`ingress-policy.mjs` checks the existing public-dev registration and origin pair,
production mode, disabled local bypass flags, exact shared Shopify scope policy,
explicit web cron authentication, matching gateway signing secrets and distinct
cron/session/app/gateway secrets. It reuses the existing Shopify runtime validator.
It also verifies the web webhook secret against the embedded app secret. The
existing generic package startup scripts remain unchanged; guarded release
commands are provided below.

The command accepts a private JSON object with exactly `web` and `shopify`
environment maps (string values), at most 1 MiB, on standard input:

```sh
node infra/cloudflare-release/preflight.mjs < /absolute/private/runtime-pair.json
```

Use a private file outside the repository with owner-only permissions. Never put
credentials in arguments, examples, source, PRs or logs. The command does not load
dotenv files or inherit ambient application configuration into the validation.
It prints only fixed failure text or a nonsecret static-check result. No actual
credentials were created or read while implementing this utility.

Do not generate new secrets over retained keys to satisfy this check. Distinct
strings do not prove key entropy, ownership or isolation from the custom app.
Provider names, plans and URLs remain unselected; this check deliberately does
not claim SQL/HTTP endpoint equivalence, Redis/QStash configuration, storage
privacy, webhook-secret rotation correctness or real authentication.

## Remaining implementation and execution gates

- Inventory already-owned providers and approve isolated resources, region and
  total budget. No provider connector was available during this implementation;
  no account inventory or service provisioning is claimed.
- Add provider-specific validators, reviewed production entrypoints and release
  manifests. The guarded commands below enforce role-local ingress admission,
  but provider admission, image wiring and actual deployment remain unfinished.
- Build fresh images with reviewed public values and inject runtime secrets
  outside image layers. Do not upload the synthetic compatibility images.
- Add lifecycle supervision, bounded execution and authenticated schedules,
  preserving queue-retry ownership of compliance recovery. Test real jobs and
  database transactions at approved limits before any deployment approval.
- Complete the [full acceptance matrix](../../docs/loyalty/unified-acceptance-matrix.md).
  Passing this utility does not authorize deployment or establish launch readiness.

## Tests

```sh
node --test infra/cloudflare-release/ingress-policy.test.mjs infra/cloudflare-release/start.test.mjs infra/cloudflare-release/shopify-image.test.mjs
node --test infra/cloudflare-release/shopify-smoke.test.mjs
```

All fixtures are synthetic. No database, order, email or Shopify installation is
used by this suite.

## Guarded release startup (not deployed)

With an already-built, reviewed release artifact and separately injected role
environment, the future image entrypoints must invoke one fixed command:

```sh
node infra/cloudflare-release/start.mjs web
node infra/cloudflare-release/start.mjs shopify
```

These commands start real applications, not probes. Do not run them as a test
against retained local credentials. They never read the paired JSON: each role
receives only its own secrets. Run paired preflight separately to check the
cross-service HMAC/webhook secret relationships. A role-local pass cannot prove
that the other service has matching configuration.

Admission rejects legacy identity, development/build bypasses, missing cron or
webhook authentication, conflicting local secrets and unsafe Node options.
Runtime `.env`, `.env.local`, `.env.production` and `.env.production.local` files
in the application directory are rejected before the framework can load them.
The image must exclude all credential/dotenv files and invoke the wrapper without
Node preloads: no JavaScript guard can prevent a preload that ran before itself.
Only `NODE_OPTIONS=--max-old-space-size=<positive integer MiB>` is supported when
present. This is a heap option, not container resource enforcement.

Both roles bind port 3000 on all interfaces inside their future containers.
Commands are fixed (no shell or arbitrary command arguments). The wrapper forwards
SIGTERM/SIGINT, escalates only its direct child to SIGKILL after 25 seconds, and
preserves failure/signal exit status. Configure the eventual container stop grace
above 25 seconds. There is no restart loop: platform supervision is separate.
Admission/spawn errors use fixed messages, but application stdout/stderr are
inherited and still require their own production logging/privacy review.

Evidence is synthetic unit tests of admission/command selection/lifecycle and
real CLI rejection tests only. No successful production server startup, provider
connection, image build, release manifest, worker supervision, deployment or live
Shopify journey is claimed by these changes. Existing local probe images and
ordinary package start scripts do not use this new wrapper.

## Shopify candidate release image

`Shopify.Dockerfile` is a fresh-build recipe, not a promoted local probe image.
Its dedicated context excludes dotenv/credential files, host dependencies and
build outputs. Dependency installation is lockfile-frozen; subsequent build
steps use `--network=none`. No application secret or live provider endpoint is
supplied at build time. The explicit `WELETIC_SHOPIFY_BUILD_TARGET=node` selector
chooses standard Remix Node output without the Vercel preset. Ordinary builds
still use Vercel, and existing local-probe opt-in behavior remains compatible.
The build selector is rejected if supplied to the runtime guard.

The fresh final stage copies the compiled Shopify build, package manifest,
pnpm dependency directories and the three startup-policy files. It does not
inherit the builder environment or copy first-party web/application source.
It runs as the unprivileged `node` user with the fixed guarded Shopify entrypoint.
Dependencies currently retain the full lockfile-installed root store, including
development dependencies. Dependency pruning, image size and vulnerability
inventory need actual image evidence before deployment; this is not a claim of
a minimal runtime image. No dependency or lockfile was changed for this recipe.

After local container execution is resumed, build a local-only candidate from
the reviewed revision, with the prior two-CPU/2 GiB/no-swap Shopify build bounds:

```sh
docker buildx build --platform linux/amd64 --resource memory=2g --resource memory-swap=2g --resource cpu-quota=200000 --resource cpu-period=100000 -f infra/cloudflare-release/Shopify.Dockerfile --target shopify -t weletic-cloudflare-release:shopify-candidate .
```

This reference command is not deployment/upload authorization. Check current
Docker VM headroom first; never increase its limits implicitly or run concurrent
heavy builds. Record image digest, source revision, architecture, layer/config
inspection and actual guard/boot/HTTP/shutdown evidence with synthetic credentials
and no external network before any provider-connected test. Runtime port 3000 is
not published by the recipe. Do not inject the full paired credential document.

September 16 evidence:

- Explicit Node-target host build passed, producing `build/server/index.js` and
  browser assets, without application credentials or live provider configuration.
  Existing sourcemap warnings remain; they did not fail compilation.
- Default Vercel-target host build also passed, retaining its server-bundle layout.
- Browser asset scan found no `synthetic-container`, `app.localhost:8890`,
  `127.0.0.1:3002`, `WELETIC_SHOPIFY_SERVICE_SECRET` or `SHOPIFY_API_SECRET`.
  This bounded marker scan is not a comprehensive secret scan or browser journey.
- Node policy/static packaging tests and the focused Vitest wrapper passed.
  Static Dockerfile tests verify intended wiring/exclusions, not Docker's actual
  context evaluation, Linux dependencies, layer content or server behavior.
- Docker remained stopped; no candidate image was built, run, tagged or uploaded.
  Linux image verification is **outstanding**, not accepted from the host build.
- Next/web and outbox release images, provider-specific checks, container ingress
  manifests, scheduler/watchdog wiring and live acceptance remain outstanding.

Reference: [Remix Vite build output](https://v2.remix.run/docs/guides/vite/#new-build-output-paths)
and [Cloudflare container image requirements](https://developers.cloudflare.com/containers/get-started/#the-container-image).

## September 17: local Shopify candidate verified

The unchanged candidate recipe was built from public runtime revision
`91450cd57579d85edba3eedd18c9716a572959a4` using the documented
`linux/amd64`, two-CPU, 2 GiB/no-swap build command. The current branch adds
only the smoke runner, its CI wrapper/tests and these notes, not application or
image-recipe changes. No image was uploaded.

- Local image identity:
  `sha256:047f36d66a14b2b70cc789746ebb12fe39a93bf934a75d0bbc931f89c5b9bc14`.
- Docker reports Linux/amd64 and 794,240,578 bytes. The image retains the full
  installed dependency store; neither vulnerability scanning nor dependency
  minimization is complete. Size is not a Cloudflare cost or capacity estimate.
- Fresh final stage has the expected non-root user, SIGTERM and guarded
  entrypoint, with no baked smoke credentials or build-mode flags.
- Actual missing-config startup exits 1 with the fixed admission error.
- Actual configured startup, using synthetic secrets, returns the expected 404
  plus `nosniff` and `frame-ancestors 'none'` for an unknown document route.
  This is server/SSR wiring evidence, not an authenticated merchant journey.
- The runtime used no external network or published host port, a read-only
  filesystem, dropped capabilities, no-new-privileges, two CPUs and 2 GiB with
  no swap. SIGTERM shutdown passed without OOM or forced kill. Both smoke
  containers were removed by their exact invocation identity.
- A separate read-only image scan inspected 69 first-party files for private
  filename patterns and verified web source was absent. Dependency contents,
  image history and all possible secret patterns were not comprehensively
  scanned; do not treat this as a complete supply-chain or secret audit.
- All 77 release-policy/runner unit tests, the existing Vitest CI wrapper and web
  type-check passed. Reviewer-requested local Docker endpoint enforcement and
  interrupted/uncertain-create cleanup were added and retested before the actual
  smoke run. Generic CI runs the pure tests, not Docker integration.

To repeat against the same locally present image:

```sh
node infra/cloudflare-release/shopify-smoke.mjs sha256:047f36d66a14b2b70cc789746ebb12fe39a93bf934a75d0bbc931f89c5b9bc14
```

The runner requires an immutable local image identity. It resolves a local Unix
Docker socket without inherited connection overrides, uses an empty isolated
Docker configuration, and never pulls an image or forwards host application
credentials. Random exact names/labels track cleanup even if creation does not
return an ID. SIGINT/SIGTERM request cleanup; SIGKILL or a failed Docker daemon
still require an operator to reconcile the exact `weletic.release-smoke` label.

Read-only provider discovery found no databases in the accessible PlanetScale
organization. The installed Wrangler CLI reported unauthenticated. No Cloudflare
or Upstash connector was available. No resource inventory beyond those checks,
login, temporary-account deployment, provisioning, spending, DNS or provider
mutation occurred. Cloudflare documentation confirms that `wrangler deploy`
uploads the Worker/image, so it was deliberately not used as a local check.
[Cloudflare deployment behavior](https://developers.cloudflare.com/containers/get-started/)

**Still outstanding:** web and outbox release images, comprehensive image audit,
provider selection/credentials/budget, provider-specific validation, actual
release manifests/routing, scheduler/watchdog/supervision, target schema rollout,
and live public-app acceptance. This checkpoint closes only local Shopify
candidate packaging/boot/shutdown verification, not cloud deployment readiness.

## September 17: loyalty-only web boundary

[ADR 0036](../../docs/adr/0036-loyalty-only-cloudflare-release.md) scopes the
future Cloudflare release to loyalty. `start.mjs web` now invokes
`loyalty-web.mjs`, a production Next custom server. Ordinary package startup
and legacy portal deployments are unchanged.

The authoritative exact route inventory is [loyalty-routes.mjs](loyalty-routes.mjs):

- Signed Shopify installation/session, catalog, merchant and shopper gateways.
- Existing authenticated customer-account/checkout APIs, Shopify commerce/Flow
  webhooks, mandatory privacy callbacks and bounded compliance-export IDs.
- Authenticated loyalty outbox, compliance, catalog-sync, renewal, FX and retry
  callbacks; only the two named Shopify renewal job handlers.

The API origin rejects all other paths, including standalone workspace/admin/
partner pages, NextAuth, reviews, billing, unrelated jobs and framework assets.
Only the reserved API Host is admitted. Encoded/ambiguous paths, framework routing
override headers/query keys, conflicting forwarded origins, Upgrade and CONNECT
are rejected before application dispatch. Request bodies, signatures and ordinary
query strings are passed unchanged; route admission never bypasses existing auth.
The separate embedded Shopify application's OAuth/assets/UI remain its own
release surface and still need installed-app acceptance.

The custom entrypoint sets the runtime-only `WELETIC_RELEASE_PROFILE=loyalty-only`
before loading Next. Queue retry then selects and rechecks only the two approved
renewal job names; it does not publish, delete or increment unrelated job rows.
Its bounded compliance sweep remains authoritative. Legacy startup does not set
this selector and keeps generic retry behavior. This restriction is not permission
to share legacy persistence: isolated public-app resources remain mandatory.

Next's upgrade listener attaches to a separate unbound HTTP server, not the public
listener. The wrapper retains its 25-second shutdown bound. Future web packaging
must include the custom entrypoint and its imports: Next standalone tracing does
not include custom-server files automatically. No standalone output is enabled.
[Next custom server documentation](https://nextjs.org/docs/pages/guides/custom-server)

Evidence: pure route/inventory tests, real loopback HTTP with a **synthetic**
downstream handler (including unchanged 401, binary body and signed query), socket
rejection tests, and mocked queue-retry selection/recovery tests. These do not
prove actual Next production boot/shutdown, installed authentication, scheduler
delivery or Cloudflare routing. Those remain fresh web-image integration gates;
no live services or deployment were started for this boundary verification.

Run `node --test infra/cloudflare-release/*.test.mjs` and the web Vitest tests
`cloudflare-release-ingress.test.ts` and `queue-retry-compliance-recovery.test.ts`.

## Web/outbox candidate recipes (not image acceptance)

`Web.Dockerfile` now defines separate `web` and `outbox` targets, sharing a frozen
dependency install and Linux-generated Prisma client. Fresh runtime stages retain
OpenSSL/CA certificates, full workspace dependencies and package sources. They
run as `node` and use guarded startup. This deliberately favors compatibility
over image minimization; dependency pruning, vulnerability review and actual
image-size evidence are outstanding. Worker source includes UI utilities needed
by transitive server imports, but starts no HTTP listener or unrelated workflow.

The web builder receives a fixed, non-inherited environment: approved public-dev
origins, explicit disabled `.invalid` admin/partner origins and loopback-only
provider placeholders. `WELETIC_WEB_BUILD_PROFILE=loyalty-only` skips enumeration
of excluded partner portals only during Next's production build phase. It does
not alter request-time fetchers, auth, loyalty queries or legacy builds. All
release runtime roles reject this build selector. Application build steps have
network disabled; dependency and OS-package installation still require network.
The build guard rejects host execution, runtime dotenv files, more than two CPUs,
more than 6 GiB memory, enabled swap or unlimited cgroups. Type/lint validation
remains required separately; skipping their duplicate build passes is not a waiver.

The web target explicitly includes the custom server/config, compiled `.next`,
public files and workspace modules rather than relying on standalone tracing.
The outbox target includes the real TSX worker/aliases and no compiled Next output.
Its fixed command requires `WELETIC_OUTBOX_STORE_DOMAIN`, an exact lowercase
Shopify domain; absent/invalid scope fails before spawning. There is no global
fallback and no release CLI passthrough for `--once` or arbitrary Node options.
The store must exist under that exact domain in the isolated database; alias
reconciliation and company approval remain installation gates, not automatic
provisioning. Existing active-store/generation fences remain unchanged.

Outbox currently requires the web-role ingress/auth configuration plus that store
scope. It receives only its role's configuration, not the paired JSON. This is
not a provider-isolation check. SQL, Redis, signing/encryption, email/storage and
all other producer-specific configuration still require reviewed provider setup.
The existing worker's logging/privacy review, restart/watchdog policy and graceful
batch/lease recovery are also pending; the wrapper's 25-second bound alone does
not prove them. Cloudflare wake-up/supervision for a non-HTTP worker is not wired.

Once an isolated local Docker daemon is safely available, build sequentially:

```sh
docker buildx build --platform linux/amd64 --resource memory=2g --resource memory-swap=2g --resource cpu-quota=200000 --resource cpu-period=100000 -f infra/cloudflare-release/Web.Dockerfile --target outbox -t weletic-cloudflare-release:outbox-candidate .
docker buildx build --platform linux/amd64 --resource memory=6g --resource memory-swap=6g --resource cpu-quota=200000 --resource cpu-period=100000 -f infra/cloudflare-release/Web.Dockerfile --target web -t weletic-cloudflare-release:web-candidate .
```

These commands are local builds, not upload/deployment authorization. Check VM
headroom first and do not silently restart unrelated containers or increase VM
limits. Record immutable image identity, source revision, size and architecture;
scan layers for dotenv/private inputs and build placeholders before promotion.
Then run no-network/read-only synthetic smoke checks with temporary `/tmp`, no
published ports, two CPUs and 2 GiB/no swap. Prove missing-config rejection, real
Next auth rejection and excluded-route 404s, worker CLI loading without delivery,
SIGTERM cleanup and no forced kill/OOM. Do not reuse the Shopify-only smoke runner
as proof of these targets. Provider-connected batches and live mutations remain
separately gated.

The original recipe checkpoint had source-level tests only. Subsequent bounded
Linux image results, resource limits and cleanup are recorded in
[isolated verification](ISOLATED-VERIFICATION.md), under [ADR 0037](../../docs/adr/0037-isolated-local-release-verification.md).
That evidence does not establish real authentication, provider-connected delivery,
complete layer/secret auditing or Cloudflare deployment readiness.

References: [Docker build-context exclusions](https://docs.docker.com/build/concepts/context/)
and [Next custom-server packaging](https://nextjs.org/docs/pages/guides/custom-server).
