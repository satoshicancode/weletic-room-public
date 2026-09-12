# Public loyalty configuration validation — September 10, 2026

Scope: ADR 0029 local configuration only. No app dev, deploy, permission
publication, DNS, routing, store installation, transaction, or email was executed.

## Configuration

- Public registration: **Weletic Loyalty Reviews Dev**, client ID
  `c7d49cebb06e445db345bb200f966a03`, confirmed by the earlier isolated CLI link.
- Candidate: `packages/shopify-app/shopify.app.loyalty-public.toml`.
- Required scopes: core loyalty only; Gift Card and Store Credit scopes optional.
- All authentication, app proxy, business webhook and compliance webhook endpoints
  use the reserved isolated origins from ADR 0027.
- `extension_directories = []`: no extension is part of this candidate yet.
- Managed installation enabled; automatic development URL updates disabled.
- Custom manifest SHA-256 remains
  `8b13a2b71d49d58c8001bd37a3370e9aca0ff4c0014ac6549d7f405c8b256aca`.

## Evidence and limits

On September 10, Shopify CLI validation of an isolated copy returned
`{"valid":true,"issues":[]}` using `app config validate --config loyalty-public
--json`. The scratch app contained no extensions or runtime credentials. Validation
was not run against the custom extension directory because CLI validation can
assign missing extension UIDs.

The focused runtime/preflight/configuration suite passed 62 tests across three
files. Tests pin required versus optional scopes, public client ID, endpoint paths,
managed installation, disabled extension discovery, and legacy configuration
compatibility. Independent permission review found no blocking issue and confirmed
existing scope guards accept write grants for equivalent read requirements.

Web and Shopify typechecks, focused ESLint, changed Markdown/TypeScript formatting,
and the Shopify production build passed. The build retains existing source-map,
bundle-size and framework future-flag warnings; it exited successfully.

These are static contracts and CLI schema validation, not proof that endpoints
are reachable, permissions were granted, or shopper journeys work live.

## Remaining execution work

1. Enforce exact public identity/scopes/endpoints and namespace isolation at public
   runtime startup; the existing runtime still uses its unchanged custom fallback
   unless explicitly configured.
2. Reconcile public-owned extension identities and selectively enable reviewed
   surfaces; exclude POS and the Plus-only checkout-reductions target.
3. Verify granted optional scopes and platform capability gates, including absent
   and revoked permissions, before enabling stored-value rewards.
4. Complete approved endpoint deployment, install/reinstall, protected-data/network
   requirements and named `yamaxdev` evidence at their execution gates.

## Sources

- [Shopify app configuration](https://shopify.dev/docs/apps/build/cli-for-apps/app-configuration)
- [Shopify access scopes](https://shopify.dev/docs/apps/build/authentication-authorization/manage-access-scopes)
