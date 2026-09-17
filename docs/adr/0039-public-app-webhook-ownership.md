# ADR 0039: Public-app webhook ownership

- Date: 2026-09-18
- Status: Accepted
- Stakeholders: Hiro (PO), Codex (impl)

## Context

The public app declares canonical webhooks in Shopify TOML, while backend
provisioning also creates shop-specific subscriptions for the same topics.
Yamaxdev tests observed paired deliveries and transient order-lock failures.
Overlapping registration is a likely contributor, not a completed live audit.
Financial idempotency held; two duplicate records remained unresolved.

Shopify distinguishes app-scoped TOML subscriptions from shop-scoped GraphQL
subscriptions. The latter query does not inventory the former, so absence from
GraphQL cannot justify creating a replacement or prove missing app coverage.

## Decision

TOML owns canonical public-app subscriptions. Validated public runtime identity
and callback policy select this mode; legacy custom-app provisioning remains
unchanged. Report delegated configuration ownership explicitly, never as remotely
registered or verified topics. Retain per-shop filtered segment subscriptions,
which are not declared in the canonical TOML set.

Provide a read-only overlap audit. Do not delete existing subscriptions, repair
financial history, fabricate signed deliveries, or mark failed events processed.
Remote cleanup requires exact ownership, active replacement evidence and separate
approval. Delivery, installation and recovery acceptance remain release gates.

## Alternatives considered

- **GraphQL owns all public canonical topics** — rejected because it duplicates
  lifecycle management already provided by the public app configuration.
- **Keep both and rely on idempotency** — rejected because intentional duplicate
  subscriptions add avoidable traffic and contention; idempotency remains required
  for ordinary retries regardless of subscription ownership.

## Consequences

### Positive

- Public authentication/catalog paths no longer create overlapping subscriptions.
- Custom-app behavior and signed financial ingress safeguards remain intact.

### Negative / trade-offs accepted

- Runtime GraphQL cannot verify TOML deployment; release evidence must do so.
- Existing shop-scoped subscriptions are not removed by this code change.

### Follow-ups

- Audit the public registration and yamaxdev subscriptions without mutation.
- Verify active TOML coverage before approving exact shop-scoped cleanup.
- Complete named duplicate-delivery recovery and installation acceptance.

### Read-only audit procedure

The server-side `auditPublicShopifyWebhooks` helper in
`apps/web/lib/weletic/shopify/audit-public-webhooks.ts` accepts an exact shop domain
and access token from a verified public-app installation. Do not pass tokens on a
command line, publish them, or substitute legacy custom-app credentials. Runtime
configuration validation does not authenticate the supplied token's app identity;
the helper labels that identity `not_verified` and disables SDK credential fallback.

The bounded query returns shop-specific canonical subscriptions only. An empty
inventory does not prove TOML coverage. `complete: false` means more than one page
is present and the inventory cannot support cleanup. Callback URLs and filters
are reduced to booleans; `cleanupAuthorized` is always false. This batch provides
the helper and synthetic tests, not a live audit result or a deletion command.

Before any separately approved cleanup, verify public installation/token ownership,
inspect the active Shopify configuration and its canonical topics, establish real
delivery through the configured endpoint, and prepare the exact shop-specific IDs
with rollback/recovery steps. Do not include filtered segment subscriptions.

## References

- Hiro approved Option A in this task.
- [Shopify subscription management](https://shopify.dev/docs/apps/build/webhooks/subscribe).
- [Live retest](../loyalty/yamaxdev-discount-retest-2026-09-18.md).
