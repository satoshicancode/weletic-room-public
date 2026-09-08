# Isolated loyalty/reviews development: preparation and local services

Updated 2026-09-06. This is package 1 of the
[approved unified 12-package plan](https://www.notion.so/3d2e26097bfd81c0a667ce21978d4fdc),
not completion of its installation or isolation acceptance tests. The newer
Notion baseline supersedes conflicting scope in the historical six-package docs.

## Registration and store responsibilities

- New app: **Weletic Loyalty Reviews Dev**, app ID `419628580865`, public client
  ID `c7d49cebb06e445db345bb200f966a03`, in Yamax (Partner account).
- [Dev Dashboard](https://dev.shopify.com/dashboard/130576043/apps/419628580865)
  and [distribution](https://partners.shopify.com/3206157/apps/419628580865/distribution).
  Public distribution was selected with Hiro's explicit approval. Registration
  created Shopify's automatic placeholder version; no Weletic code deployment,
  store install, protected-data request, or App Store submission occurred.
- `yamaxdev`: implementation/acceptance, with newer customer accounts, Shopify
  identity provider and Shop sign-in observed enabled. Existing Smile/Judge.me
  free plans are not the full-feature reference. Check active automations before
  fixtures; do not assume installation means active sending or rewards.
- `n0pvef-cs`: paid-trial competitor reference. Preserve its apps and data.
- The retained `montdev` mapping still needs fresh API shop-ID verification;
  neither its name nor the admin's alias link authorizes backend rebinding.

## Offline preflight scope

The original templates and file-preflight CLI are preparation only. They do not create databases,
credentials, servers, cache keys or buckets; start workers; apply a schema;
refresh tokens; send email; or call Shopify. Existing runtime entry points are
unchanged. The checker is **not a runtime enforcement boundary** or an install
authorization. It checks only the four explicitly supplied files, not inherited
shell variables, framework dotenv overlays, running processes or remote grants.

The separately approved [local-services slice](./local-services.md) now provisions
isolated Docker resources and stages the existing schema in a new empty database.
It does not activate the web/Shopify runtime, install the app, or prove package 1
acceptance. Its live checks complement, rather than replace, the file preflight.

The Shopify skill informs the signed service boundary and exact financial
arithmetic. Its old alias shortcuts and outdated API examples are not applied:
the approved canonical-shop and installation-generation contracts take priority.

## Preparation topology

Use a clean, separate checkout and a scrubbed process environment when the
runtime setup is approved. Do not copy the existing complete `.env` files: they
contain benchmark transport and infrastructure credentials. Do not use `dev`,
`dev:all`, sync pollers, global workers or CLI auto-link/deploy as a shortcut.

| Resource      | Required preparation                                                                    |
| ------------- | --------------------------------------------------------------------------------------- |
| App identity  | New client ID and secret; preserve the existing registration and TOML                   |
| Web / Shopify | Separate loopback listeners, proposed ports 8890 / 3002                                 |
| MySQL         | Dedicated `weletic_loyalty_dev*` database and non-root user restricted to it            |
| Edge SQL      | Separate local PlanetScale-compatible HTTP proxy targeting that same database           |
| Redis         | Dedicated loopback REST-compatible instance/token; no global Redis override             |
| Media         | Dedicated local S3-compatible endpoint, distinct private/public buckets and credentials |
| Authorities   | Fresh service HMAC, encryption, login and cron secrets; matching app/webhook secret     |
| Delivery      | No SMTP/Resend, QStash signing/publish credentials, tunnel or scheduler activation      |

The local proxy must accept the credential-bearing HTTP URL required by the
existing SQL client. The CLI cannot prove its backend database or user grants.
The allocation and dated local-service evidence are recorded in the linked runbook.
Local media is for initial isolation proof; approved remote private-media and
Resend delivery remain later live gates. No production storage provider or
application dependency is changed by this local setup.

## Read-only file preflight

Copy the templates into **ignored** `.env*.local` files, then populate only
approved isolated-resource credentials. Leave unknowns blank; templates must
fail closed until configured. Keep secret values out of reports and shell args.
Run from `apps/web`, using Node 24 and already installed dependencies:

```sh
pnpm exec tsx scripts/dev/check-shopify-development.ts \
  --web=/absolute/path/to/.env.loyalty-web.local \
  --shopify=/absolute/path/to/.env.loyalty-shopify.local \
  --retained-web=/absolute/path/to/existing/apps/web/.env \
  --retained-shopify=/absolute/path/to/existing/packages/shopify-app/.env
```

All four files must exist and resolve to distinct paths. No implicit dotenv
discovery, interpolation or environment loading is performed. Output contains
fixed check IDs and booleans, never supplied URLs, values or caught exceptions.
Exit 0 means `configuration_consistent`; exit 1 means blocked checks; exit 2
means invalid/unreadable inputs. **`liveReady` is always false.**

Scope validation uses the existing feature inventory, excluding `read_all_orders`.
It does not request/grant scopes. Denied scopes and protected fields still need
review before installation. HTTP loopback URLs deliberately fail Shopify's
external callback requirements; these templates are not deployment manifests.

## Remaining gates, in order

1. Local resources and existing-schema staging have passed their bounded checks.
   Still validate effective environment loading when the isolated runtime starts;
   a file preflight is not enforcement of inherited process credentials.
2. No history, sessions or existing merchant records were copied. Schema staging
   from the current Prisma model does not prove historical migration replay.
   Shared-schema changes retain explicit merge approval.
3. Fresh local authorities and the new app's existing secret are configured.
   Still verify unauthenticated scheduler rejection in the isolated runtime.
   Review public HTTPS origins, callback/webhook/proxy alignment and requested
   access before approved exposure/installation. Obtain fresh canonical Shopify
   shop ID/domain evidence; never manually fill generation/currency proof.
4. Link the new app using a separate reviewed configuration. Existing extension
   UIDs belong to the old app: reconcile ownership before any dev preview or
   publication. Do not replace the default TOML or deploy existing UIDs blindly.
5. Prove install/reinstall and authenticated, generation-fenced worker/webhook
   round trips; implement scheduled offline-token renewal and reconnect alerts.
   Keep schedules and sends off until bounded-store tests are approved.

Gift Card/Store Credit issuance, UI and settlement have separate evidence
levels. Formal development-store settlement remains platform-gated. Timezone
and gift-card earning policy remain unresolved activation decisions; neither is
silently changed by environment preparation.
