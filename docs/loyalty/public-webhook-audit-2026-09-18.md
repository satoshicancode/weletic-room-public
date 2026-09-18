# Public webhook ownership audit — September 18, 2026

Source: public main `b579f41e9194a10c071addbce73b39f91a16a5ef` (PR #79).
Its post-merge Fast Quality Gate passed. This is bounded authentication and
read-only subscription evidence, not complete webhook delivery acceptance.

## Authorization and authentication

Hiro approved restarting the isolated public-app preview, updating its temporary
URLs and authenticating normally before the audit. Subscription deletion,
financial repair, new orders, email delivery and deployment remained excluded.

The initial offline session expired at 03:29 JST. No expired credential was sent
to Shopify. The existing Shopify Admin browser session opened the installed
public app, and native SDK token exchange produced a fresh offline session at
approximately 12:20 JST, without changing authentication rules or permissions.
The embedded overview loaded and displayed approved store access.

An authenticated GraphQL `currentAppInstallation` query verified the returned
app API key against the public client ID and the shop's canonical domain against
`montdev.myshopify.com` (the `yamaxdev` store). The app title was **Weletic Loyalty
Reviews Dev**. No CLI Connector or legacy custom-app token was substituted.
Only the retained public SDK session was decrypted in memory; credentials,
embedded URLs and raw callback URLs are excluded from this document.

## Live shop-scoped inventory

At approximately 12:20–12:22 JST, stable Admin API `2026-07` returned 48 canonical
shop-specific subscriptions with `hasNextPage: false`. They form three groups by
exact callback URI. Every group contains all 16 canonical topics once, using
unfiltered JSON and the expected integration-webhook path.

| Callback group | Count | Created September 18, JST | Matches restored preview |
| -------------- | ----: | ------------------------- | ------------------------ |
| 1              |    16 | 00:10:25–00:10:39         | No                       |
| 2              |    16 | 01:28:31–01:28:44         | No                       |
| 3              |    16 | 02:30:56–02:31:09         | No                       |

All three point to older temporary preview URLs and predate this restart.
This confirms redundant historical shop-scoped registrations. It does not prove
that any particular duplicate delivery came from one of these subscriptions.
No subscription was deleted, updated or newly created by the audit queries.
Exact IDs are retained in private local operational evidence, not this public
document. Filtered segment subscriptions were outside the canonical-topic query.

## TOML preview and ingress evidence

- Shopify CLI configuration validation returned `valid: true`, with no issues.
- The CLI reported the public development preview ready. Its generated bundle
  contained 16 canonical `webhook_subscription` modules, all targeting the new
  preview callback and API version `2026-07`.
- Public ingress returned 404 for the internal session route and 401 for an
  unsigned integration webhook. The latter is rejection evidence, not a signed
  Shopify event or successful business processing.
- The shop-scoped GraphQL inventory cannot establish deployed TOML coverage.
  No real platform event was generated to prove delivery during this audit.

## Isolation, unchanged state and shutdown

All 13 isolated service checks passed before preview startup. Local launch issues
were resolved without application changes: the CLI required canonical `montdev`,
the optional GraphiQL listener conflicted with the proxy port, and the tunnel
needed explicit empty configuration plus IPv4-to-IPv6 loopback routing to avoid
inheriting the machine's named-tunnel settings. No named-tunnel configuration,
custom-app configuration or production endpoint was edited.

SQL before and after authentication showed the loyalty program disabled, exactly
10 ledger entries totaling -200 points and zero pending points. The failed-event
inventory retained nine historical rows, including earlier runs; these were not
replayed or marked processed. No financial repair or recovery acceptance is claimed.
Email delivery and workers remained disabled. The CLI, tunnels, loopback bridge,
ingress, backend, five isolated containers and dedicated Lima VM were stopped
after the audit, preserving their data. No theme was published or app uninstalled.

## Remaining gates

1. Restore the preview for a separately scoped real-delivery test and verify the
   TOML-managed replacement before removing any old subscription.
2. Re-audit the current identity and exact subscription IDs; prepare rollback and
   request explicit approval for the bounded cleanup. Do not delete segment hooks.
3. Prove stale/duplicate delivery recovery without fabricated signed events,
   ledger rewrites or manually setting terminal webhook status.

References: [ADR 0039](../adr/0039-public-app-webhook-ownership.md),
[financial retest](yamaxdev-discount-retest-2026-09-18.md),
[Shopify subscription management](https://shopify.dev/docs/apps/build/webhooks/subscribe).
