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
