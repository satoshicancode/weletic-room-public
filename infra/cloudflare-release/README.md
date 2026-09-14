# Cloudflare release preparation

[ADR 0034](../../docs/adr/0034-cloudflare-containers-managed-services.md)
approves the mixed-service topology, not provisioning or deployment.

## Static paired-ingress preflight

`ingress-policy.mjs` checks the existing public-dev registration and origin pair,
production mode, disabled local bypass flags, exact shared Shopify scope policy,
explicit web cron authentication, matching gateway signing secrets and distinct
cron/session/app/gateway secrets. It reuses the existing Shopify runtime validator.
It does not modify either application's existing startup path yet.

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
  manifests. Wire validation into those entrypoints before treating it as a
  runtime guard. Current code is a non-deploying preparation utility only.
- Build fresh images with reviewed public values and inject runtime secrets
  outside image layers. Do not upload the synthetic compatibility images.
- Add lifecycle supervision, bounded execution and authenticated schedules,
  preserving queue-retry ownership of compliance recovery. Test real jobs and
  database transactions at approved limits before any deployment approval.
- Complete the [full acceptance matrix](../../docs/loyalty/unified-acceptance-matrix.md).
  Passing this utility does not authorize deployment or establish launch readiness.

## Tests

```sh
node --test infra/cloudflare-release/ingress-policy.test.mjs
```

All fixtures are synthetic. No database, order, email or Shopify installation is
used by this suite.
