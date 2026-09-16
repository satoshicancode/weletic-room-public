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
node --test infra/cloudflare-release/ingress-policy.test.mjs infra/cloudflare-release/start.test.mjs
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
