# ADR 0047: Restricted yamaxdev feature testing

- Date: 2026-09-28
- Status: Accepted
- Stakeholders: Hiro (PO), Codex (implementation)

## Context

Hiro approved Option A after deferring App Store registration and the Support
question. Setup-only authentication cannot exercise loyalty and review benefits.
The required feature journeys must be testable without representing synthetic
billing as a real subscription. Production still requires Shopify App Pricing.

## Decision

Add a separate restricted-development mode to the isolated local launcher. Bind
it to public app c7d49cebb06e445db345bb200f966a03, Partner app
419628580865, immutable shop 73236414690, authenticated domain
montdev.myshopify.com, and an explicitly pinned installation generation.
Require a fresh authenticated Admin API response confirming that identity and
partnerDevelopment. Record a distinct restricted_development status with no
plan handle, never paid/private_free/development subscription status. Reuse the
existing five-minute expiry, refresh race fencing and installation lifecycle.
Revalidate the local-mode configuration when consuming the receipt; stale receipts
cannot grant production access after the mode is removed.

Production admission rejects either development flag, even malformed. Runtime
requires development NODE_ENV, isolated core-v1 configuration and loopback data
services. Preserve suspension, privacy, staff authorization, per-store enrollment,
core feature restrictions, deduplication and existing-obligation recovery.
First review claims on the canonical testing shop require current authority even
after removing the flags; existing recorded claims/replays still recover. Other
stores retain their existing invitation-promise settlement rules.
No schema migration is needed: the existing snapshot status is a string. Status
API/UI explicitly distinguishes testing access from subscription verification.

This supplements ADR 0046; setup-only retains its original no-benefits behavior.
Do not enable both modes. Feature testing does not close billing acceptance.
Configuration/code approval does not authorize paid provisioning, production,
public extension release, historical sends or real payments. A bounded installed
run still records its exact fixtures and temporary ingress before execution.

## Alternatives considered

- **Complete registration first** — deferred by Hiro to continue without the fee.
- **Stay setup-only** — insufficient for the requested feature journeys.
- **Invent a paid/free subscription** — rejected; it would invalidate billing proof.
- **Unrestricted development bypass** — rejected; it could affect other stores or production.

## Consequences

### Positive

- Enables isolated feature acceptance independently of hosted pricing availability.
- Makes the unverified billing boundary explicit and auditable.

### Negative / trade-offs accepted

- Adds a separate test admission path requiring adversarial isolation tests.
- Reinstall requires explicitly pinning the new generation; access expires if identity refresh fails.
- Local and development-store evidence does not prove persistent production hosting or billing.

### Follow-ups

- Verify cross-app/shop/generation denial, expiry, privacy/suspension, refresh races and production rejection.
- Run local SQL and UI regressions before a bounded installed acceptance run.
- Retain real subscription acceptance as a launch gate.

## References

- [Setup-only decision](0046-setup-only-development-mode.md)
- [Core launch checklist](../loyalty/core-launch-checklist.md)
