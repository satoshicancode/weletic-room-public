# ADR 0035: Anonymous referral confirmation retention

- Date: 2026-09-17
- Status: Accepted
- Stakeholders: Hiro (PO), Codex (implementation)

## Context

Anonymous friends can request their own referral coupon without a loyalty
account. The legacy sender renders mutable English content on retry and permits
SMTP fallback. Its lease alone cannot preserve provider idempotency, original
installation authority or an immutable recipient/request through recovery.

The account-backed communications path retains encrypted requests but requires
an actual account and marketing consent. Reusing that authority for an anonymous
friend or manufacturing an account would change the meaning of consent.

## Decision

Hiro approved Option A: requested reward confirmations only, fixed EN/JA/VI
content, encrypted exact retry payloads, deletion after confirmed delivery,
privacy erasure or expiry of a 23-hour retry window, and Resend-only idempotent
dispatch. No invitations, marketing or SMTP fallback enter this path. Existing
account-backed consent rules remain unchanged.

Use existing referral JSON metadata with strict versioned original-generation,
recipient/privacy and reward provenance. Never invent authority for legacy
claims. Preserve the provider key and exact prepared bytes across retries;
expired/ambiguous attempts require reconciliation, not a fresh key. Erasure
invalidates lease ownership and physically removes retained ciphertext. Reuse
existing tenant/mutation and privacy locking conventions; no new public API,
schema, installation or deployment is authorized by this decision.

## Alternatives considered

- Defer anonymous delivery and finish account-backed communications first:
  not selected because requested anonymous coupon fulfillment is in scope.
- Use the account-backed marketing journey or invent an account: rejected
  because neither establishes the requested anonymous fulfillment authority.
- Retain mutable content or fall back to SMTP: rejected because retries cannot
  preserve exact provider idempotency semantics.

## Consequences

### Positive

One coherent fulfillment lifecycle can be tested across provenance, sending,
retries, localization and physical erasure without collecting a new account.

### Negative / trade-offs accepted

Encrypted recipient and rendered coupon data are personal data requiring purge.
Legacy claims and unavailable Resend capability fail closed. Automatic recovery
stops after the retry window; uncertain sends require reconciliation.

### Follow-ups

Implement the lifecycle as a batch, verify real-MySQL races and cleanup with
mocked transport, then run the full quality gate. Scheduling/purge supervision,
real inbox delivery and named yamaxdev acceptance remain external release gates.

## References

- [Referral communications](../loyalty/referral-communications-implementation.md)
- [Approved milestone plan](https://www.notion.so/3dde26097bfd811fbd84f212b6d67fe5)
- Hiro approved Option A in this task on September 17, 2026.
