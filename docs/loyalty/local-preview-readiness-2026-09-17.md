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
