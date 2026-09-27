# Yamaxdev setup-only preview evidence — September 27, 2026

Hiro explicitly approved the temporary setup-only preview. The bounded session
ran against source `7d914547aa92fb7e59c45cc3489139f96e7bdced`; it is now stopped.
Authentication and immutable identity were verified. A subsequent bounded cold
start passed at `5b17457cfaf4bd1aac49f539ca3bfdbb99ca69df` after the development
dependency scan fix. This is not billing, customer-journey, sustained reliability
or persistent-runtime acceptance.

## Target and observations

- Public client: `c7d49cebb06e445db345bb200f966a03`.
- Partner app: `gid://shopify/App/419628580865`.
- Shop: `gid://shopify/Shop/73236414690`, We Dev (Official, non-transferable).
- Admin display domain: `yamaxdev`; authenticated session and CLI domain:
  `montdev.myshopify.com`. The CLI rejected `yamaxdev.myshopify.com`; its known
  alias opened the same store and the backend confirmed the immutable shop ID.
- Local installation generation: `26d58bff-ee10-4fcd-84d4-030a2e49ec87`.
- Local database: `weletic_loyalty_dev`, owned loopback MySQL port 13307.
- Authenticated installation remains `pending_approval`, with no mapped store.
  The subscription snapshot is `unavailable`, with expired verification authority.
  A browser-triggered second billing refresh preserved this state and generation.
- Before and after: zero activated store rows, points ledger entries, review
  requests and incentive claims. An encrypted offline session and pending
  installation were created; no synthetic entitlement was inserted.
- Embedded UI displayed: “Development setup only. New points, coupons and review
  rewards are disabled. Registration remains deferred.” The existing installation
  notice reported pending company approval; no onboarding/activation was invoked.

All 13 local ownership/isolation probes passed. Shopify CLI configuration
validation returned `valid: true`, no issues. The preview selected no theme,
account or Flow extensions; only the configured app proxy and privacy webhook
capabilities appeared in the developer console. The CLI reported the manifest's
required scopes auto-granted on this development store; no additional optional
scopes or protected-customer-data declaration was requested.

## Routing and reliability findings

The first tunnel attempt inherited an existing Cloudflare configuration and
returned 404. The CLI proxy also listened on IPv6 loopback, while the initial
origin targeted IPv4. Both initial processes were stopped. The successful retry
used an explicit private empty tunnel configuration and `http://[::1]:3003` for
the app proxy, with backend ingress at `http://127.0.0.1:8891`. Do not rely on
ambient Cloudflare configuration or assume the CLI proxy's address family.

The successful retry used these temporary origins (now inactive):

- App: `https://comm-fame-boots-stakeholders.trycloudflare.com`.
- Restricted API ingress: `https://oklahoma-amino-technical-craps.trycloudflare.com`.

The first browser load encountered a React invalid-hook-call error during Vite
dependency optimization. A reload after optimization rendered the setup UI and
completed billing/status requests. This observation does **not** prove the cause
or establish reliable cold startup. Reproduce and resolve the initial-load issue
before claiming stable installed testing; a successful reload is bounded evidence.

The subsequent loopback investigation reproduced the invalid-hook-call errors
with an empty Vite cache, immediately after late dependency optimization. The
initial server-rendered page appeared healthy before client hydration failed;
visible HTML alone must not count as successful browser startup. Enabling Remix's
documented `future.unstable_optimizeDeps` route scan eliminated the late
optimization/reload and hook errors in the same fresh-cache local probe. The
probe then reached the expected App Bridge error outside Shopify Admin (missing
shop context). This verifies the local startup change, not authenticated
interaction or a repeated installed cold start. This development-only setting
does not change production builds; see
[Remix dependency optimization](https://v2.remix.run/docs/guides/dependency-optimization/).

The installed repeat at `5b17457cfaf4bd1aac49f539ca3bfdbb99ca69df` used a new
temporary origin and an empty Vite dependency cache. The first authenticated
browser load rendered the pending-approval/setup-only UI without a manual reload.
The overview language selector updated Japanese, Vietnamese and English content,
proving client interaction rather than server HTML alone. No invalid-hook-call
errors or late optimization reloads were observed. The subscription banner kept
its browser locale (English); this was not a full translated-billing UI
acceptance. A second billing refresh retained unavailable access, the same shop
identity and installation generation, and zero store/ledger/request/claim counts.

All 325 Shopify unit tests, Shopify type-check, production build, changed-file
ESLint and Prettier checks passed. The build retained existing source-map warnings.
The build-policy predicate import was aliased to avoid its non-hook `use` name
triggering the React hook lint rule. No dependencies, API contracts or schema
were changed. Exact-head CI is tracked on draft PR #176.

The repeat was stopped with `shopify app dev clean`; Shopify confirmed the active
version was restored. Both tunnels, backend, restricted ingress and app process
were stopped, with no listeners on ports 3002, 3003, 8890 or 8891. Private repeat
evidence includes `before-fixed.json`, `after-fixed.json`, `cli-fixed.log` and
`setup-only-cold-fixed.png` in the evidence directory below.

The CLI's automatic sample `APP_UNINSTALLED` delivery targeted `/api/webhooks`,
which this app does not expose, and failed. It did not prove registered webhook
routing or delivery. No manual webhook event, test order or external email was
sent by this session.

Public containment probes observed:

| Request                                            | Status | Evidence scope                       |
| -------------------------------------------------- | ------ | ------------------------------------ |
| GET `/api/internal/shopify/sessions`               | 404    | Internal session gateway not exposed |
| POST `/api/cron/weletic/loyalty/outbox`            | 404    | Internal cron not exposed            |
| POST `/api/shopify/integration/webhook`, unsigned  | 401    | Signature required; no trusted event |
| POST `/api/shopify/loyalty/admin/adjust`, unsigned | 404    | Route rejected at public ingress     |

The pending-installation UI and signed status/billing requests were exercised.
A separately authorized merchant-data/staff-role matrix was not exercised.

## Cleanup and remaining gates

The CLI preview was stopped. `shopify app dev clean` confirmed that the selected
store's active app version was restored. Read-only version inventory still showed
`weletic-loyalty-reviews-dev-1`, version `1117177348097`, as the only active version.
No new app version was released. Both tunnels, ingress, web runtime and CLI app
process were stopped; ports 3002, 3003, 8890 and 8891 had no listeners afterward.
Local services, encrypted session evidence, previous apps and provider data remain.

Registration/payment, hosted plans, external inbox, checkout/refunds, public Flow
publication, shared-schema application and production activation remain open and
outside this packet. Existing release approvals are not replaced by this result.

Private local evidence: `/tmp/weletic-yamaxdev-setup-20260927/` contains before/after
SQL summaries, containment results, version inventory, runtime logs and the
`setup-only-installed.png` screenshot. Credentials and session payloads are not
included in this document or Git. Raw local logs are private diagnostics, not
public artifacts.
