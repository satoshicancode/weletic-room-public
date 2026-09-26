# Yamaxdev core preview preparation — September 26, 2026

Status: prepared locally; not an executed preview or approval to expose services.
The [core checklist](core-launch-checklist.md) remains authoritative.

## Read-only identity inventory

Observed in Shopify's authenticated developer dashboard on September 26:

| Item                       | Observed value                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------- |
| Partner account            | Yamax; Partner dashboard account `3206157`, Dev Dashboard organization `130576043` |
| Public app                 | Weletic Loyalty Reviews Dev; app `419628580865`                                    |
| Public client ID           | `c7d49cebb06e445db345bb200f966a03`                                                 |
| Active version             | `weletic-loyalty-reviews-dev-1`, version `1117177348097`, September 6              |
| Active application URL     | `https://example.com`                                                              |
| Installed store            | We Dev (Official, non-transferable), Development legacy; installed September 17    |
| Canonical acceptance store | `yamaxdev.myshopify.com`, dashboard store ID `73236414690`                         |
| Alias observed             | Store login passed through `montdev` and resolved to `yamaxdev`                    |
| Public app handle          | `weletic-loyalty-reviews-dev`, visible in the store's Admin app link               |

Sources: [active version](https://dev.shopify.com/dashboard/130576043/apps/419628580865/versions/1117177348097),
[installs](https://dev.shopify.com/dashboard/130576043/apps/419628580865/installs),
[stores](https://dev.shopify.com/dashboard/130576043/stores).
These UI identities must still be matched against authenticated API identities
and the new local installation generation before benefit tests. Do not substitute
the separately installed custom app, Weletic Room.

The Partner distribution page requested account selection/sign-in. Hosted plans,
their actual handles, Partner API credential access and current protected-data
permissions were not verified in this pass. Do not infer an active subscription
from the install row or the store's development label.

## Local tooling change

The existing local launcher intentionally ignores ambient environment variables.
It therefore also ignored the new core release and billing settings. It now accepts
an explicit `--core-config=/absolute/private/core.json` argument, after validating
the existing isolated resource configuration.

The JSON file must be a regular, nonsymlink file with mode `0600`, at most 8 KiB,
and contain exactly these string keys:

| Key                                   | Required source / destination                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------ |
| `SHOPIFY_PARTNER_APP_ID`              | Verify Partner App GID for app `419628580865`; backend only                                |
| `SHOPIFY_PARTNER_ORGANIZATION_ID`     | Verify Partner API account; do not confuse Partner account with Dev Dashboard organization |
| `SHOPIFY_PARTNER_API_TOKEN`           | Authorized Partner API credential; backend only, never paste into chat or checked-in files |
| `WELETIC_SHOPIFY_PUBLIC_PLAN_HANDLE`  | Confirm configured USD500 monthly plan handle                                              |
| `WELETIC_SHOPIFY_PRIVATE_PLAN_HANDLE` | Confirm configured private company-free plan handle                                        |
| `SHOPIFY_APP_HANDLE`                  | Verified public handle above; embedded app only                                            |
| `WELETIC_SUPPORT_EMAIL`               | Approved support contact; embedded app only                                                |

Both halves validate the full configuration before starting. The launcher selects
`WELETIC_FEATURE_PROFILE=core-v1` and `WELETIC_RELEASE_PROFILE=loyalty-only`.
The Partner token is not passed to the embedded app and is included in backend
log redaction. No synthetic subscription snapshot is permitted for live-store
acceptance. Missing credentials must fail closed.

`stagePreview(root, origins, retainedWeb, retainedShopify, coreConfigPath)` carries
only the private file path into the CLI's Shopify process command. Use that same
file for the backend process. Origins and billing configuration remain separate.
This stage still disables extensions; the nine-capability extension candidate
requires its own public-ownership review before use.

## Next setup packet and remaining prerequisites

The intended first remote step is setup and authentication only:

1. Resolve the local service layout while retaining ownership checks. Port 3307
   is currently occupied by an existing SSH listener. Do not terminate it or point
   a schema/probe command at it. The previous free tests used a separate owned
   Docker MySQL port; the standard launcher does not yet accept that layout.
2. Complete Partner sign-in and read the existing hosted-pricing and protected-data
   settings. Prepare any required plan/credential changes as specific actions.
   New credential creation/access expansion requires its own confirmation.
3. After explicit preview approval, create two temporary HTTPS origins: embedded
   app and allowlisted backend ingress. Never tunnel the full Next server;
   internal gateways, cron, SQL, Redis and storage remain loopback-only.
4. Stage the exact public client, required scopes and callback URLs from
   `shopify.app.loyalty-public.toml`; bind the preview only to store `73236414690`.
   Confirm the selected CLI store resolves to yamaxdev before applying a preview.
5. Authenticate, compare immutable app/shop identities, obtain a fresh real Partner
   subscription verification, and record the local installation generation.
   No order, benefit award, coupon, review invitation or external email belongs
   to this setup-only packet. No App Store release or production activation.
6. Stop the preview/tunnels after the bounded session, retaining evidence and
   prior apps/provider data. Preview availability is not persistent hosting.

The exact live journey packet follows setup: named test customer/recipient,
test-payment orders and amounts, coupon limits, private photos, delay/expiry test
method and cleanup. Those details are not implied by this preparatory document.

## Validation scope

Local role/file/redaction tests: 3 passed. Existing isolated runtime and preview
tests, including role isolation and core-path staging: 24 passed. Independent review found no
actionable blockers. Exact-head type/lint/CI results are recorded in PR 176.
No resource ownership checks, shared schema, Shopify settings, credentials,
public routing or installed extensions were changed by this tooling patch.
