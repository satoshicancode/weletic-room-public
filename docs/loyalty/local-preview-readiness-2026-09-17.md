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

## Public preview and bootstrap — September 17, 21:12 JST

- Protected customer data was saved with only the approved App functionality
  reason. Optional personal-data fields were left unselected; no review submitted.
- PR #71 merged as `e12a2fdb7b`. All six public quality checks passed.
- The CLI accepted the required topics and reported Ready for the public app on
  canonical `montdev`, resolving in Admin to `yamaxdev`. No legacy extension UIDs
  were deployed. Existing custom-app previews were not cleaned or uninstalled.
- The CLI proxy listened on IPv6 loopback while the tunnel targeted IPv4. An
  ephemeral loopback-only IPv4-to-IPv6 bridge restored connectivity; this is not
  yet a durable launcher fix.
- Shared dependency symlinks placed Remix's default browser entry outside Vite's
  allowed filesystem. An app-owned standard hydration entry fixes the observed
  failure without widening filesystem access. After restart the real embedded
  UI successfully fetched signed status and displayed pending company approval.
- Independent SQL confirmed a fresh offline SDK session and one pending public
  installation. The audited operator preview verified the real canonical shop
  and JPY currency. Applying its exact digest created the minimal workspace/store
  mapping and bootstrap audit. SQL confirmed mapped revision 2, store access still
  pending at revision 1, zero Users and zero loyalty programs.
- Opening the mapped app again did not create a store-owned credential. A read-only
  company-approval preview failed with `Store approval requires fresh Shopify
authentication.` The bootstrap revokes coordination but retains the pre-mapping
  SDK session; the snapshot still exposes it, allowing native authentication to
  reuse it without publishing a mapped credential. This is an unresolved lifecycle
  transition, not permission to bypass admission or directly edit credentials.

Authentication into the pending installation is evidenced; active merchant access,
reinstall/stale-worker rejection and the shopper purchase/redemption/refund journey
remain unaccepted. No order, reward, email or production mutation occurred.

## Mapped authentication repair — September 17, 21:39 JST

The mapped public snapshot now reports an SDK cache miss when its validated
store-owned credential is absent. It retains the real persisted session digest,
installation generation and coordination observation. A fresh Shopify SDK exchange
must publish through the existing signed, fenced transaction; this does not create
authority from the old token or relax company approval. No schema changes.

Regression coverage includes pre-mapping session reuse, mapped cache misses with
non-missing persisted digests, changed-digest rejection, native credential mismatch,
and actual SDK exchange after a simulated provider failure. The SDK test's HTTP
transport is synthetic, not live SQL evidence. All 102 focused tests, web typecheck,
focused lint and formatting passed; independent review found no blockers.

Live evidence is separate: the existing mapped `yamaxdev` installation recovered
through its actual embedded app, without reinstall or direct credential edits.
SQL confirmed native credential revision 1 at 12:37:36 UTC under the unchanged
installation generation. Admission remained mapped revision 2 and store access
pending revision 1, with zero Users and zero loyalty programs. The previously
failing audited company-approval **preview** then passed (`applied: false`). No
approval or loyalty activation was applied. The tunnel now targets the observed
IPv6 CLI loopback listener directly, requiring no IPv4 bridge.

Remaining gates: apply reviewed company approval, configure the disabled loyalty
program, reconcile public extension ownership, and run the named shopper lifecycle.
This repair alone does not accept reinstall, financial or shopper journeys.

## Company admission — September 17, 22:16 JST

After Hiro approved continuing, the existing audited operator command was first
previewed, then applied to the exact isolated yamaxdev mapping using its current
installation generation and expected access revision 1. The runtime environment
builder validated the private local configuration and excluded delivery secrets.
No direct credential edit, schema change or external Shopify mutation was used.

Independent SQL confirmed `active` access at revision 2 and one matching audit
entry at 13:16:38.693 UTC. The installation generation was unchanged. There were
still zero Weletic Users and zero loyalty programs: company admission does not
activate loyalty or establish shopper acceptance. PR #73's authentication repair
is merged as `fb5faebe978384f385c57aafd99643dfeae37801`.

### Proposed bounded shopper fixture (not executed)

- Scope: yamaxdev only, public app, isolated local services, no production or
  retained custom-app configuration changes. Run-specific prefix
  `loyalty-acceptance-20260917-a`; retain exact created IDs privately for cleanup.
- Prepare a disabled program and inspect merchant UI. Reconcile public extension
  identities and the actual App Proxy owner before previewing the launcher.
  Stop on a custom-app identity or proxy collision; never replace it implicitly.
- Before enabling purchase earning, verify development test-payment mode and
  prevent customer notifications and real delivery. Use one designated disposable
  customer, one disposable product, and one fixed-amount reward. No real charge,
  existing customer, Gift Card or Store Credit is in this first fixture.
- Execute one test purchase, webhook/replay checks, points reconciliation,
  redemption and wallet verification, a second test checkout using that discount,
  then the relevant refund checks. Capture before/after ledger and Shopify state;
  do not substitute synthetic events for a real checkout result.
- Cleanup only recorded fixture IDs, disable the test program and preview, and
  preserve financial/audit evidence according to existing retention rules.
  Uninstalling either app and broad deletion remain excluded.

This is a proposed mutation scope, not authorization or completed acceptance.
ADR 0038 requires explicit disposable-fixture scope before external test writes.
