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

Partner sign-in is complete. With Hiro's explicit approval, Partner API client
`37492` (Weletic core acceptance) was created with Manage apps only; its token is
stored privately outside Git. The exact production `activeSubscription` query
returned HTTP 200, no GraphQL errors and null for this app/shop pair. This proves
API access/query compatibility, not paid or private-free entitlement.

The account is unregistered for the App Store. The observed Manage submission
path reaches a registration form with a one-time USD19 fee and business/associated
account declarations. No registration or payment has been made. Do not generalize
this observed pricing-navigation blocker into a requirement to pay before any
local or development-store test. Actual hosted plan handles remain unknown.
On a subsequent read-only check,
the documented Distribution → Manage submission route still redirected to
registration. Shopify's [current testing documentation](https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing#testing)
says same-organization dev stores can test available plans at no charge and
provides a private test plan in pricing configuration. Those no-charge contracts
do not prove this unregistered account can access pricing configuration. Local
and CLI dev-store testing remain separate from the unresolved hosted-pricing UI.
Hiro explicitly chose to keep registration deferred and continue free tests.
No fee or registration has been approved by that choice.
Protected-data details remain 0/9 complete; Email has no selected reason.

## Local tooling change

The existing local launcher intentionally ignores ambient environment variables.
It therefore also ignored the new core release and billing settings. It now accepts
an explicit `--core-config=/absolute/private/core.json` argument, after validating
the existing isolated resource configuration.

The JSON file must be a regular, nonsymlink file with mode `0600`, at most 8 KiB,
and contain exactly these string keys for normal billing acceptance:

| Key                                   | Required source / destination                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------ |
| `SHOPIFY_PARTNER_APP_ID`              | Verify Partner App GID for app `419628580865`; backend only                                |
| `SHOPIFY_PARTNER_ORGANIZATION_ID`     | Verify Partner API account; do not confuse Partner account with Dev Dashboard organization |
| `SHOPIFY_PARTNER_API_TOKEN`           | Authorized Partner API credential; backend only, never paste into chat or checked-in files |
| `WELETIC_SHOPIFY_PUBLIC_PLAN_HANDLE`  | Confirm configured USD500 monthly plan handle                                              |
| `WELETIC_SHOPIFY_PRIVATE_PLAN_HANDLE` | Confirm configured private company-free plan handle                                        |
| `SHOPIFY_APP_HANDLE`                  | Verified public handle above; embedded app only                                            |
| `WELETIC_SUPPORT_EMAIL`               | Approved support contact; embedded app only                                                |

Hiro approved **Option A: setup-only development mode** on September 27
([ADR 0046](../adr/0046-setup-only-development-mode.md)). For authentication and
identity tests while registration is deferred, use `"mode": "setup-only"` and
omit both plan-handle keys from the table above. The remaining five keys are
required. This variant is accepted only by the isolated development launcher,
which emits `WELETIC_SETUP_ONLY=1` to both roles. Never invent plan handles.

Setup-only mode blocks new benefits even when a retained subscription snapshot
is valid. Refresh still verifies identity but records unavailable entitlement;
company/subscriber provisioning and first-time review awards are blocked.
Existing award recovery, refunds and privacy processing remain available.
Production runtime validation rejects any presence of the setup flag.
The embedded status explains the restriction in EN/JA/VI and hides plan links.
Removing the flag does not grant access: fresh subscription verification is
still required. This mode does not establish real billing acceptance.

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

1. Local services are now verified on explicit SQL ports 13307/13902, preserving
   the SSH listener on 3307. The current core worktree uses a fresh local SQL
   volume with the 177-table current schema; original data and grants are intact.
   All 13 service checks and 16 configuration checks passed. Use the three-file
   Compose invocation in [the current checkpoint](testing-first-plan-reconciliation-2026-09-26.md#reproducible-local-services-checkpoint).
   Application startup requires either verified normal billing configuration or
   the approved private setup-only configuration described above.
2. Use setup-only mode for authentication while hosted pricing remains deferred.
   Resolve required protected-data selections before requesting that data. Partner sign-in and the approved API credential are complete.
   Any further access expansion or registration/payment needs its own approval.
3. After explicit preview approval, create two temporary HTTPS origins: embedded
   app and allowlisted backend ingress. Never tunnel the full Next server;
   internal gateways, cron, SQL, Redis and storage remain loopback-only.
4. Stage the exact public client, required scopes and callback URLs from
   `shopify.app.loyalty-public.toml`; bind the preview only to store `73236414690`.
   Confirm the selected CLI store resolves to yamaxdev before applying a preview.
5. Authenticate, compare immutable app/shop identities, and record the local
   installation generation with unavailable setup-only entitlement. A real
   paid/private-free subscription verification remains a later billing gate.
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

September 27 setup-only extension: 6 configuration tests, 51 focused unit tests,
7 real local billing SQL tests and 2 focused review SQL tests passed. The broader
review suite was not rerun (120 unrelated cases skipped). No public preview has
been started. See the canonical reconciliation record for verification details.
