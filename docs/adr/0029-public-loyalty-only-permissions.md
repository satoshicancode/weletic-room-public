# ADR 0029: Public loyalty-only permissions

- Date: 2026-09-10
- Status: Accepted
- Stakeholders: Hiro (PO), Codex (implementation)

## Context

The existing custom app requests review-product writes, legacy PriceRule access,
and stored-value permissions alongside core loyalty permissions. Reusing that
manifest would unnecessarily expand the public app's installation requirements.
The public registration is Weletic Loyalty Reviews Dev; its registration name
does not expand the approved loyalty-only product scope.

The public environment is still local-only. Reserved HTTPS origins are not
evidence of deployed endpoints, installed stores, or approved customer-data access.

## Decision

Add a separate `shopify.app.loyalty-public.toml` for the verified public client ID.
Require only product, market, order and translation reads, customer and native
discount writes, and app-proxy configuration. Shopify write permissions include
the equivalent read permission. Declare Gift Card and Store Credit permissions
as optional; declaration is not a grant or proof of store eligibility.

Preserve the custom manifest and its runtime fallback. Public runtime startup
must explicitly supply the public manifest's required `SCOPES` through the existing
override, never optional scopes. Disable extension discovery in this preparatory
manifest until public-owned identities are reconciled. This prevents accidental
reuse of custom extension UIDs, including the Plus-only checkout target and POS.

## Alternatives considered

- **Reuse the custom manifest** — rejected because it couples identities and
  requests permissions for paused functionality.
- **Require stored-value access at install** — rejected because core native
  discount loyalty must not depend on optional platform capabilities.
- **Replace the global runtime fallback** — rejected because it changes the
  retained custom app and isolated runtime without a public rollout.

## Consequences

### Positive

- The public configuration has a reviewable least-privilege permission boundary.
- Existing custom configuration and runtime remain unchanged.

### Negative / trade-offs accepted

- This is a configuration foundation, not a deployable full loyalty release.
- Optional permission request UX and live capability evidence remain outstanding.

### Follow-ups

- Reconcile public extension UIDs and explicitly enable only reviewed extensions.
- Gate public startup on exact identity, scopes, endpoints and isolated namespaces.
- Verify optional granted-scope and store-capability rejection paths before live
  stored-value rewards; never infer eligibility from this file.
- Deploy endpoints, publish configuration and install only at their execution gates.

## References

- [ADR 0027](0027-isolated-installation-schema-and-hostnames.md)
- [Shopify scope management](https://shopify.dev/docs/apps/build/authentication-authorization/manage-access-scopes)
- [Shopify app configuration](https://shopify.dev/docs/apps/build/cli-for-apps/app-configuration)
- Hiro approved the recommended local loyalty-only configuration on September 10.
