# Local preview readiness — September 17, 2026

Authority: [ADR 0038](../adr/0038-local-shopify-first-acceptance.md).
This is preparation evidence, not a successful install or shopper journey.

## Verified

- Shopify CLI validates `shopify.app.loyalty-public.toml` with no issues.
- Authenticated organization store discovery lists the canonical `montdev`
  development store. Browser inspection of `/store/yamaxdev` shows the matching
  development-store name and canonical `montdev` links. No store mutation occurred.
- An existing Weletic Room dev preview is present. It was not cleaned, replaced
  or uninstalled. The new public app must not reuse its extension identities.
- The existing private isolated configuration identifies the public client and
  contains an app secret. Only presence/format was checked; validity against
  Shopify and a fresh session remain unverified. No secret values were printed.

## Extension discovery defect fixed

Actual `shopify app info --config loyalty-public --json` discovered 12 app
extensions despite `extension_directories = []`. Installed CLI source confirms
an empty array falls back to `extensions/*`. Configuration validation alone did
not catch this semantic mismatch. The inspection also generated a local UID in
the UID-less referral manifest; the staging hash guard detected that change and
the generated line was removed, restoring the exact source. No UID was deployed.

The public config now uses `public-extensions-disabled/*`, with a README-only
directory. Actual CLI discovery reports `allExtensions.length === 0`. Its
`realExtensions` field still includes built-in configuration modules, so that
field must not be mistaken for the app-extension inventory. Regression coverage
requires the directory to contain only its README, and the staging transformer
explicitly replaces the new discovery anchor. Existing custom config is unchanged.

## Required before starting the preview

1. Prepare a separate development configuration/launcher for the selected HTTPS
   tunnel origins. Preserve fixed-origin production rejection and signed gateways.
   Current paired loopback launcher and public webhook policy do not admit tunnels.
2. Keep isolated services and schema verified before writers. The September 17
   local checkpoint below passes; this does not replace live installation checks.
3. Stage only reviewed loyalty extensions without legacy UIDs. Reconcile ownership
   with the public registration. Verify the installed App Proxy path rather than
   assuming `/apps/weletic` still belongs to this app while the custom app remains.
4. Verify protected-data access, install/authenticate the public preview, approve
   only the company store and confirm stale-generation rejection. No auth bypass.
5. Create named disposable fixtures, verify test-payment mode and disabled real
   email delivery, then run purchase → points → redeem → use → refund. Reconcile
   ledger/discount state and record cleanup for the exact fixtures.

Neither zero-extension discovery nor a valid TOML proves public extension
ownership, tunnel readiness, database readiness or successful Shopify installation.

## Isolated runtime checkpoint — September 17, 18:36 JST

- Started the dedicated no-host-mount Lima daemon. Copied only Compose and fresh
  service configuration into its guest-local checkout-equivalent path, preserving
  the verifier's exact read-only mount ownership boundary. No host directory was
  mounted and the default Docker context was not changed.
- The pinned media image drops to UID 1000. Its guest-only S3 configuration needed
  ownership 1000:1000 while retaining mode 0600. Host credentials were unchanged.
  An initial probe ran before media readiness; the subsequent complete run passed.
- All 13 service checks passed: private files, container ownership, loopback ports,
  internal networks, matching native/HTTP SQL server, database-scoped grants and
  denied system-table access, authenticated/anonymous Redis, private/public media
  permissions, and denied runtime policy administration. Synthetic probes cleaned
  up their own objects and keys.
- Empty-schema staging created 157 tables, imported zero records and installed no
  app. This proves current-schema creation, not migration history or live acceptance.
- The launcher now preserves explicit Docker selection only for the verifier;
  application environments still exclude all Docker settings and ambient secrets.
- The backend starts with the standard Next development bundler. Turbopack rejected
  this worktree's externally linked dependencies. Release builds are unchanged.
- Both development servers started on loopback. Anonymous HTTP probes returned
  307 from the backend root and 410 from the authenticated Shopify root. These are
  reachability observations, not authenticated merchant UI acceptance.

The retained-baseline comparison must use the original custom-app environment
files, not an earlier public-app development environment. The latter correctly
fails app-identity and namespace separation checks. Never weaken these checks.

No HTTPS tunnel, Shopify preview, installation, order, redemption, refund, real
email or Cloudflare resource was created during this checkpoint. The tunnel-aware
launcher and callback policy remain required before store acceptance.

## Development ingress boundary

`infra/shopify-development/preview-ingress.mjs` is a local backend proxy, not a
complete Shopify preview launcher. It listens only on 127.0.0.1:8891 and forwards
to the fixed backend at 127.0.0.1:8890. It requires explicit development mode,
confirmation and the exact selected HTTPS `trycloudflare.com` origin.

Only the existing `/api/shopify/` allowlist subset is admitted. Internal merchant
gateways, cron, workspace pages and framework assets/RPC stay private. The existing
production origin policy is unchanged. The proxy preserves signed body bytes and
query strings; downstream signature, session, approval and generation checks remain
mandatory. It is not an authentication substitute.

The development proxy intentionally supports JSON/plain-text responses and empty
204 responses only. Binary compliance-export downloads are not accepted through
this preview boundary. Redirects, HTML and upstream server errors are suppressed.
Limits are 10 MiB per body, eight active requests, 32 server connections and a
30-second upstream absolute deadline. Slow incoming requests also have a server
request timeout. These bounds are development constraints, not production sizing.

Before exposure, the paired runtime must explicitly accept the selected preview
origins and the private Shopify configuration must point callbacks at this boundary.
Do not point a tunnel directly at the full Next development server or claim this
standalone proxy completes installation, extension ownership or shopper acceptance.

## Paired preview attempt — September 17, 19:33 JST

The paired launcher now accepts a separate mode-0600 origins JSON file. It first
validates the unchanged isolated base configuration, then applies two distinct,
explicit HTTPS development origins. Internal Shopify-to-backend calls remain on
loopback. Preview markers are rejected outside isolated development, including
production. The webhook policy requires the same selected pair and callback path.

Private CLI staging preserves the public manifest and custom app, excludes legacy
extensions, pins the frontend port and refuses to overwrite prior staging. Shopify
CLI configuration validation passed. The real backend tunnel returned 404 for the
internal session route and 401 for an unsigned integration webhook. No shopper
or financial fixture was created.

Actual `app dev` selected Weletic Loyalty Reviews Dev and the canonical development
store, but Shopify rejected preview creation because the app is not approved for
webhook topics containing protected customer data. This is a platform access gate,
not successful authentication or an accepted shopper journey. Do not remove the
required order/customer subscriptions to disguise it.

[Shopify's protected-data documentation](https://shopify.dev/docs/apps/launch/protected-customer-data)
states that development-only installations need the data/field selection but do
not need review submission. That permission setup must be resolved before retrying
preview creation. Public App Store submission and production data access remain
separate gates. CLI dependency installation was interrupted before retrying with
the existing dependencies; no tracked package or lockfile changes were produced.

Verification: 57 isolated-runtime, public-webhook-policy and scope tests and 62
central webhook tests passed. Web and Shopify typechecks, focused lint and the
Shopify build passed. Real webhook route compilation exposed a pre-existing
invalid Next route export; the catalog debounce helper and Lua script were moved
unchanged into a library module, preserving behavior and test coverage. Independent
review found no blockers. These checks do not establish live installation,
authenticated storefront behavior, HMR or financial acceptance.
