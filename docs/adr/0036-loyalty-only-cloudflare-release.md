# ADR 0036: Loyalty-only Cloudflare release

- Date: 2026-09-17
- Status: Accepted
- Stakeholders: Hiro (PO), Codex (impl)

## Context

ADR 0034 preserves the existing Node applications and managed persistence.
The inherited web application also contains standalone workspace, platform-admin
and partner portals. Their host-based routing and build-time public URLs cannot
be treated as interchangeable with the reserved loyalty API origin.

The immediate product is loyalty for approved company stores through Shopify,
not a SaaS or affiliate-platform launch. Exposing every inherited route would
expand authentication, domain and acceptance work unrelated to that product.

## Decision

Hiro selected Option A: expose the Shopify embedded loyalty experience and
required loyalty APIs only. Standalone workspace, admin and partner portals and
unrelated APIs are unavailable in this release profile. Preserve their source
and ordinary deployment behavior; do not delete or migrate their data.

Use an explicit default-deny boundary before the web framework dispatches a
request. Admit only reviewed existing routes, preserving their current signed
gateway, shopper, webhook, privacy and scheduler authentication. Admission is
not authorization and creates no public write API. Unknown routes remain closed
until explicitly reviewed. Public-dev origins remain those approved in ADR 0034.

## Alternatives considered

- **Full internal platform** — rejected for this release because it requires
  additional domains and portal-specific authentication and acceptance.
- **Leave inherited defaults and hide navigation** — rejected because direct
  URLs and APIs remain reachable and client assets can retain wrong domains.

## Consequences

### Positive

- Keeps deployment and live acceptance focused on loyalty for company stores.
- Makes route exposure explicit without weakening existing authorization.

### Negative / trade-offs accepted

- Standalone portal workflows are not available in this deployment.
- Additional required routes need a reviewed allowlist change; deny-by-default
  can reveal previously hidden runtime dependencies during acceptance.
- A production custom server must be packaged explicitly; Next standalone
  tracing cannot be assumed to include it. Actual image boot/shutdown remains
  a release gate, separate from synthetic boundary tests.
- The release-specific retry profile restricts outbound jobs as well as inbound
  routes; compliance recovery and ordinary legacy retry behavior are preserved.

### Follow-ups

- Implement and test the release HTTP boundary and publish its route inventory.
- Build web/outbox images with reviewed public values, not legacy defaults.
- Verify provider connectivity, scheduling, install/reinstall and live journeys.
- Resource purchases, DNS, cloud deployment, schema application and live Shopify
  or email actions retain their separate execution gates.

## References

- Hiro's explicit Option A selection in this task.
- [Managed-services topology](0034-cloudflare-containers-managed-services.md)
- [Release preparation](../../infra/cloudflare-release/README.md)
