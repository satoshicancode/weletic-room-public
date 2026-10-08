# Public Shopify app runtime inventory — September 25, 2026

This is read-only M3 evidence for **Weletic Loyalty Reviews Dev**, the public
app in the Yamax Partner account. It does not establish installed acceptance,
extension ownership, provider readiness or release approval. The source baseline
was public `main` [`5266d588`](https://github.com/satoshicancode/weletic-room-public/commit/5266d58833269bb6b59b57ac065f7b39eddfbda8).

| Surface                                                                                                       | Observed state                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Release implication                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local configuration                                                                                           | Shopify CLI validation returned `valid: true` with zero issues for the default and `loyalty-public` configurations. The latter selects **zero** extension directories through `public-extensions-disabled/*`; `shopify app info --json` returned `allExtensions: []`. The two configurations have different client IDs.                                                                                                                                                                                                                                                                | A successful default-app or temporary staging build cannot prove public-app extension registration or ownership.                                                                                                                                                                        |
| [Active public version](https://dev.shopify.com/dashboard/130576043/apps/419628580865/versions/1117177348097) | `weletic-loyalty-reviews-dev-1`, created September 5, is the only version returned by `shopify app versions list --json`. Its Dev Dashboard detail shows app URL `https://example.com` and webhook API version `2026-07`. The CLI version list does not expose the extension manifest.                                                                                                                                                                                                                                                                                                 | This active version is not a releasable runtime. Reconcile its exact remote configuration and extension identities before proposing a new version or installed journey.                                                                                                                 |
| [Current installs](https://dev.shopify.com/dashboard/130576043/apps/419628580865/installs)                    | The Dev Dashboard current-install table lists one store, **We Dev (Official, non-transferable)**, installed September 17. The app overview displayed zero installs, so its aggregate count does not agree with the detailed table. The [September 24 Yamax inventory](v1-launch-readiness-2026-09-24.md) found only the retained custom app on yamaxdev.                                                                                                                                                                                                                               | Treat the detailed table as the observed public-app install, but verify installation generation and exact store at acceptance time. Neither count proves a public-app install on yamaxdev.                                                                                              |
| [Webhook monitoring](https://dev.shopify.com/dashboard/130576043/apps/419628580865/monitoring/webhooks)       | The dashboard displayed **93.4% failure rate** in its last-seven-day view, with deliveries on September 17–19 and none shown for September 20–24. A [failed `orders/paid` test delivery](https://dev.shopify.com/dashboard/130576043/apps/419628580865/logs/unified_show?highid=117298177054109776&lowid=11521723315422564599&timestamp=2026-09-19T14%3A29%3A01Z&type=WEBHOOK_DELIVERY) to `montdev.myshopify.com` reported **Invalid webhook URL** on attempt 9. Its destination was an old `trycloudflare.com` tunnel, not the checked-in `loyalty-api-dev.weletic.com` webhook URL. | The historical error has a concrete stale-destination example. Inventory every active subscription and establish a durable, signed delivery path with successful receipts before live acceptance. This one sample does not explain every failure or prove a current defect on yamaxdev. |

The checked-in public configuration names
`https://loyalty-shopify-dev.weletic.com` as its app URL and
`https://loyalty-api-dev.weletic.com/api/shopify/integration/webhook` as its
webhook destination. These local values differ from the observed active version
and failed historical subscription. Configuration validation checks the local
file; it does not update the remote app.

## Next executable packet

1. Obtain the authoritative public-app version, extension UID/handle and active
   webhook-subscription inventory. Compare each item with the reviewed
   [13-extension staging build](public-extension-build-2026-09-24.md), retaining
   POS and Plus-only checkout exclusions.
2. Resolve the persistent runtime endpoint, Shopify grants and protected
   customer data requirements. Produce a candidate version manifest and
   rollback-compatible webhook/privacy worker plan. Keep the current custom
   app installed and identify one financial writer for cutover.
3. Rehearse installation, reinstallation, staff revocation, extension placement
   and named Flow workflows on an approved store only after the scoped
   deployment/install packet identifies its version, store, grants, migration
   prerequisites, operation limits and containment.
4. Record the release SHA/image, installation generation, configuration
   revision, expected and actual outcomes, delivery receipts and cleanup for
   every installed journey. Recheck webhook health after the candidate version
   is live; do not extrapolate from the September test traffic.

No Shopify version was deployed, store installation changed, workflow edited,
webhook delivered or provider resource created during this inventory. The
Shopify CLI updated its own global installation from 4.8.0 to 4.8.2 while
running the first read-only validation; repository dependencies were unchanged.
