# ADR 0008: Shopify app production security boundary

- Date: 2026-08-17
- Status: Accepted
- Stakeholders: Hiro (PO), Codex (impl)

## Context

PR #1 introduces a standalone Remix process under `packages/shopify-app` for
the embedded Shopify administration experience. Weletic's authoritative tenant,
program, catalog, affiliate, and commerce data remains in `apps/web`.

The prototype connected these processes through unauthenticated public routes.
It accepted an arbitrary workspace slug and shop domain, exposed partner and
performance data with wildcard CORS, and wrote catalog data using demo defaults.
The embedded app also used an in-memory Shopify session store and contained
fallback credentials and URLs. Those choices are unsafe in production: a caller
could cross tenant boundaries, process restarts would invalidate sessions, and a
misconfigured deployment could silently run with placeholder credentials.

The embedded app and core are deployed independently, so sharing Prisma directly
would couple the Shopify runtime to the core database and schema deployment.

## Decision

`packages/shopify-app` will remain the Shopify-facing process and `apps/web`
will remain the authoritative Weletic core. Communication between them will use
an internal HTTP API authenticated with an HMAC-SHA256 signature over the
request timestamp, method, path including query string, and exact body. Requests
outside a five-minute clock window or with an invalid signature will be rejected.

Every internal request will carry the Shopify shop domain obtained from
`authenticate.admin(request)`. The core will resolve the corresponding workspace
from that domain. The embedded app will not send or select a workspace slug, and
the core will not fall back to demo tenants.

Shopify OAuth sessions will be persisted by `apps/web` through the same signed
internal API. Session payloads will be encrypted with the existing AES-256-GCM
`ENCRYPTION_KEY` before database storage. The Remix process will implement
Shopify's `SessionStorage` contract over this API rather than connect directly
to Prisma. The encrypted payload will retain the access-token expiry, refresh
token, and refresh-token expiry required by Shopify's expiring offline access
token flow; the maintained Remix runtime will refresh offline sessions before
their access tokens expire.

The public prototype catalog and statistics routes will be replaced by signed
internal routes. Responses will omit partner email addresses and wildcard CORS.
Catalog uploads will be validated and scoped to an already-connected Shopify
store. Demo products, markets, currencies, counts, store domains, workspace
slugs, and localhost URLs will be removed. Mutating internal routes will reject
request bodies larger than 256 KiB before signature verification to bound
unauthenticated memory use.

Core commerce operations will require a real workspace-scoped installed
integration and encrypted access token. They will not synthesize an installation
from a catalog row, arbitrary platform user, environment-wide token, or dummy
credential. Admin GraphQL requests will accept only validated `myshopify.com`
store domains, reject redirects, and use a proxy only when explicitly configured
in development.

The standalone app will expose the Shopify Remix authentication route at
`/auth/*`; every embedded loader and action will authenticate with Shopify
before reading the session shop or calling the internal API. Its server HTML
entry will attach Shopify's per-shop `frame-ancestors` policy plus baseline
content-type and referrer headers to document responses, and deny framing when
a valid shop context is absent.

Production configuration will fail closed. The Shopify process requires
`SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `WELETIC_API_URL`,
and `WELETIC_SHOPIFY_SERVICE_SECRET`. The core requires the same service secret
and its existing `ENCRYPTION_KEY`. The repository will keep one Shopify CLI app
configuration and one current multi-role web configuration. The standalone app,
webhooks, and core Admin GraphQL client will use the same supported stable
Shopify API version (`2026-07` at the time of this decision).

## Alternatives considered

- **Keep public bridge routes and in-memory sessions** — Rejected because they
  permit cross-tenant access, leak merchant data, and lose authentication state
  whenever the process restarts or scales horizontally.
- **Connect the Remix app directly to the Weletic database** — Rejected because
  it spreads database credentials and Prisma schema coupling into a separately
  deployed edge process.
- **Remove the embedded app until the loyalty phase** — Rejected because Hiro
  approved hardening the already-planned Shopify app in PR #1 rather than
  deferring the unsafe boundary.
- **Trust a caller-provided workspace slug after signing** — Rejected because a
  valid service request should still derive tenancy from Shopify's authenticated
  shop identity and preserve a single ownership mapping.

## Consequences

### Positive

- Internal Shopify calls are authenticated, time-bounded, and tamper-evident.
- A Shopify session cannot select or mutate another Weletic tenant.
- Sessions survive restarts and horizontal scaling while remaining encrypted at
  rest.
- Expiring offline access tokens can be refreshed without merchant
  reauthorization because the refresh-token fields survive persistence.
- Core database credentials and Prisma runtime stay out of the Shopify process.
- Missing deployment configuration causes an explicit failure instead of a
  connection to demo or localhost services.

### Negative / trade-offs accepted

- Shopify authentication now depends on core API availability and adds one
  network round trip to session operations.
- Both deployments must share and rotate an additional HMAC secret.
- Deploying PR #1 requires applying the additive Prisma schema before starting
  the Shopify process.
- Clocks on both deployments must remain synchronized within five minutes.
- Changing the request signing contract requires coordinated releases.

### Deployment contract

- Apply the additive `WeleticShopifyAppSession` schema with the repository's
  reviewed `prisma db push` workflow before deploying the Shopify process.
- Configure the core with `WELETIC_SHOPIFY_SERVICE_SECRET` and the existing
  `ENCRYPTION_KEY`.
- Configure the Shopify process with `SHOPIFY_API_KEY`,
  `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `WELETIC_API_URL`, and the same
  `WELETIC_SHOPIFY_SERVICE_SECRET`.
- Keep the Shopify app runtime, webhook configuration, and core Admin GraphQL
  version aligned on a Shopify-supported stable API release.
- Set the Shopify CLI `application_url` and `/auth/callback` redirect to the
  actual `SHOPIFY_APP_URL` during production deployment.

## References

- Hiro approval of Option A, harden the Shopify production boundary in PR #1,
  on 2026-08-17.
- https://github.com/satoshicancode/weletic-room/pull/1
- `docs/adr/0006-merge-foundation-before-loyalty.md`
- `docs/adr/0007-client-i18n-runtime-in-ui-package.md`
- https://shopify.dev/docs/apps/launch/deployment/deploy-to-hosting-service
- https://shopify.dev/docs/apps/build/cli-for-apps/app-structure
- https://shopify.dev/docs/api/shopify-app-remix/latest/entrypoints/shopifyapp
- `/Users/hironguyen/.codex/memories/project_adr_0008.md`
