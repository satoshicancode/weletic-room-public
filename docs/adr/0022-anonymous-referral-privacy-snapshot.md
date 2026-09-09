# ADR 0022: Anonymous referral privacy snapshot

- Date: 2026-09-09
- Status: Accepted
- Stakeholders: Hiro (PO), Codex (implementation)

## Context

Friend-coupon referrals can complete without a loyalty account or shopper record.
Their referral-email HMAC uses a different cryptographic context from customer
privacy tombstones, so the stored digest cannot be converted into a tombstone
lookup identity. Requiring an account suppresses a supported shopper journey.

## Decision

Hiro approved a versioned, HMAC-only customer-privacy identity snapshot in existing
referral metadata, created while the canonical email is transiently available.
Store no raw email. Never include this snapshot in the Flow payload. Integrate
erasure, retention and key-retirement handling before activating dispatch.
Legacy rows lacking verifiable identity fail closed; do not fabricate or reverse
identity evidence. The existing installation and tenant boundaries remain.

## Alternatives considered

- Require a referee account: rejected because valid anonymous friends lack one.
- Remove friend privacy checks: rejected because erased subjects could trigger
  further processing.
- Retain raw email: rejected because it expands sensitive data unnecessarily.

## Consequences

### Positive

Anonymous referrals can be checked against the authoritative privacy tombstones
without retaining raw identity or exposing it to Shopify Flow.

### Negative / trade-offs accepted

Pseudonymous identity remains personal data. Key dependencies and erasure must
be tracked. Legacy events may be unavailable when proof cannot be established.

### Follow-ups

Implement and test the snapshot writer/reader, erasure/retention lifecycle,
rotation-aware lookup and key-retirement audit. Prove privacy/refund interleavings
before release. Shopify deployment and live workflows are separate gates.

## References

- [Flow implementation](../loyalty/referral-completed-flow-implementation.md)
- Hiro's explicit approval in the loyalty completion task on 2026-09-09.
