# Public preview webhook delivery — September 18, 2026

Runtime: public main `42bb5fd6cd2ce6370a45f40dad97d3c4ab2d1910` (PR #80).
Its post-merge CI passed. **Signed delivery passed for `products/update`;
downstream catalog convergence failed.** This is not full webhook acceptance.

## Approved scope

Hiro approved restarting the isolated preview and temporarily adding, then removing,
one unique tag on the existing archived `loyalty-acceptance-20260917-a-product`
fixture on yamaxdev (canonical montdev). No new order, payment, refund, email,
subscription deletion, financial repair, deployment or permission expansion.

The existing seven required scopes were unchanged. Native embedded authentication
refreshed the expired offline session. A read-only `currentAppInstallation` query
verified the public app identity and canonical store. CLI configuration validation
passed, and the preview reported Ready. Tunnels used explicit empty configuration;
the app tunnel targeted the CLI's IPv6 loopback listener directly.

## Named delivery evidence

The original product was archived, priced at JPY 1,000, with an empty tag set.
The test added `weletic-webhook-probe-20260918-1406` and saved in Shopify Admin,
then removed only that tag and saved again.

| Event       | Received, JST | HTTP | Persisted result                                                                  | Catalog result                                                             |
| ----------- | ------------- | ---- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Tag added   | 14:05:34.575  | 200  | Processed, attempt 1, authenticated body digest, matching installation generation | Test tag present at 14:05:40.272                                           |
| Tag removed | 14:06:06.938  | 200  | Processed, attempt 1, authenticated body digest, matching installation generation | Background sync rejected by existing catalog lock; stale test tag remained |

An unsigned ingress probe returned 401. Neither event was synthesized or manually
replayed. Exact webhook identifiers are retained in private local evidence.
Shopify Admin confirmed the restored empty tags, archived status and unchanged
price, with Save disabled. Only the local catalog projection remained stale.

Read-only subscription audits before and after the test still found 48 canonical
shop-scoped subscriptions in the same three old callback groups, none targeting
this preview. This supports delivery through the current TOML-managed preview;
it is not a Shopify subscription-ID attribution trace or evidence for other topics.
No old subscription was removed and no new shop-scoped subscription was created.

## Defect exposed

The development branch of the integration webhook handler starts catalog sync
inside `waitUntil`, catches and logs its failure, and returns success before that
work finishes. The second event hit `A Shopify catalog sync is already running.`
Both event rows nevertheless became `processed` with no stored error. A successful
ingress response and terminal event row therefore do not establish convergence.

The first sync finished successfully at 14:07:24.373 JST, but the local fixture
still contained the temporary tag afterward. Its success did not catch the second
change. No SQL patch, forced lock release or manual event-status change was made.

An additional existing observability limitation appeared: the API-log sink rejected
ingestion as unauthorized. SQL and local request logs supplied this test's evidence;
remote API-log acceptance is not claimed. Delivery credentials remain disabled.

## Financial isolation and shutdown

Independent SQL before and after showed the program disabled, ten ledger entries
totaling -200 points and zero pending points. The nine historical failed paid/refund
event rows and their attempts were unchanged. Neither new product event failed at
the ingress bookkeeping layer; that is precisely why downstream verification matters.

After the first sync finished, the CLI, both tunnels, ingress, backend, five
isolated containers and dedicated VM were stopped, preserving their data. The
remote product was restored; the stale local projection is retained as failure
evidence. No other Shopify product was edited by the operator.

## Remaining work

- Decide and implement a bounded local-preview catalog completion/retry fix, with
  overlapping-event and failure regression tests. Do not silently broaden this into
  a production queue redesign or weaken authentication/generation checks.
- Reconcile the stale local projection through the normal sync path and repeat
  the approved add/remove test after the fix, proving final empty tags in both
  Shopify and the local catalog.
- Keep exact stale-subscription cleanup and financial duplicate recovery behind
  their separate approvals. Do not infer all-topic readiness from this probe.

References: [prior audit](public-webhook-audit-2026-09-18.md),
[ownership decision](../adr/0039-public-app-webhook-ownership.md).
