# ADR 0038: Local Shopify-first loyalty acceptance

- Date: 2026-09-17
- Status: Accepted
- Stakeholders: Hiro (PO), Codex (impl)

## Context

The release images have bounded local build/boot evidence, but no complete
Shopify shopper journey has been accepted. Waiting for Cloudflare provisioning
would delay that feedback and introduce hosting costs before core acceptance.
Shopify CLI supports store-scoped development previews connected to local apps.

The existing public runtime accepts only fixed cloud origins or a loopback-only
isolated mode. It cannot safely accept arbitrary tunnel origins without a
separate reviewed development configuration. Local execution still receives real
Shopify events and must preserve authentication, tenant and accounting guards.

## Decision

Defer Cloudflare provisioning and first test the purchase, points, redemption,
discount-use and refund journey on `yamaxdev` through Shopify CLI and local
services. Reuse isolated Docker tooling where appropriate, without restarting
Docker Desktop's retained workloads. Keep database, sessions, queues and secrets
separate from the custom app and production. Do not weaken production origin
policy, reuse custom extension identities or introduce unauthenticated APIs.

Approval covers preparation of this development workflow and its store-scoped
preview. Verify store eligibility, public registration and exact test fixtures
before activation. Do not infer permission for paid orders, real customer emails,
production data changes, cloud spending or uninstalling the old app. External
test mutations must have an explicit disposable-fixture scope before execution.

## Alternatives considered

- **Cloudflare staging first** — deferred, not rejected as the eventual hosting
  architecture; provisioning is not needed for the first functional feedback.
- **Local mocks only** — insufficient for real Shopify authentication, webhook
  delivery and checkout discount acceptance.

## Consequences

### Positive

- Earlier end-to-end feedback without first provisioning cloud application hosts.
- Existing Docker and financial test work remains useful.

### Negative / trade-offs accepted

- The computer and tunnel must remain available during live testing.
- CLI does not supply compatible SQL/Redis/QStash services or grant protected
  customer-data access. Their requirements must still be verified.
- Stopping CLI does not remove the store's development preview; cleanup must be
  deliberate because removing preview configuration can remove associated data.

### Follow-ups

- Validate registration/configuration and CLI access before opening a tunnel.
- Implement explicit development origin/namespace admission and test production
  rejection, signed requests, fixture isolation and cleanup.
- Record named real-store results separately from mocks and Docker smoke tests.
- Return to Cloudflare staging for provider, supervision and recovery acceptance.

## References

- Hiro's approval of local + CLI first in this task.
- [Cloudflare architecture](0034-cloudflare-containers-managed-services.md)
- [Isolated Docker](0037-isolated-local-release-verification.md)
- [Shopify local testing](https://shopify.dev/docs/apps/build/cli-for-apps/test-apps-locally)
