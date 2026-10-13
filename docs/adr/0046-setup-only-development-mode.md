# ADR 0046: Setup-only development mode

- Date: 2026-09-27
- Status: Accepted
- Stakeholders: Hiro (PO), Codex (implementation)

## Context

Hosted-pricing configuration is currently behind App Store registration for this
account. Hiro deferred registration and its fee, while requesting stable testing
before production. The local preview launcher requires both real plan handles,
which prevents authentication and installation-identity testing in that state.

Allowing authentication must not imply a free entitlement or make an old paid
snapshot sufficient to create benefits. Existing financial and privacy obligations
must remain recoverable. Public preview exposure still requires its own packet.

## Decision

Hiro approved Option A: an explicit setup-only mode in the private local core
configuration. It permits authenticated identity and status checks without hosted
plan handles. Backend admission and new-benefit writers reject setup-only work,
even with a previously valid subscription. Refresh retains authenticated identity
but records unavailable entitlement. New review incentive claims are blocked;
existing claims, refunds and privacy recovery retain their current controls.

Only the isolated local launcher may construct this environment. Production
runtime validation rejects the setup flag. Both application roles display the
same setup intent; Partner credentials stay on the backend. No schema change or
new public API is required.

## Alternatives considered

- **Keep complete hosted-pricing configuration mandatory** — rejected as the
  current testing path because registration remains deferred.
- **Invent development plan handles or grant free access** — rejected because
  synthetic configuration cannot establish real subscription authority.

## Consequences

### Positive

- Authentication and installation identity can be tested without registration.
- A retained paid snapshot cannot accidentally enable benefits in setup mode.

### Negative / trade-offs accepted

- This mode cannot prove paid/free subscription or benefit acceptance.
- Every relevant new-benefit path needs a fail-closed guard and negative tests.

### Follow-ups

- Validate configuration, admission, financial boundaries and production rejection.
- Prepare the exact yamaxdev setup preview packet; obtain exposure approval.
- Complete real pricing and installed journeys before release.

## References

- [Core launch checklist](../loyalty/core-launch-checklist.md)
- [Preview packet](../loyalty/yamaxdev-core-preview-packet-2026-09-26.md)
- [Approved planning record](https://www.notion.so/3dde26097bfd811fbd84f212b6d67fe5)
