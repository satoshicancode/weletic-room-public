# ADR 0043: Shared email delivery budget

- Date: 2026-09-23
- Status: Accepted
- Stakeholders: Hiro (PO), Codex (impl)

## Context

ADR 0042 chose one delivery policy across Loyalty and Reviews. Anonymous referral
confirmations can precede a Shopify customer record, so a customer-only counter
would either miss those messages or hold their confirmations indefinitely.
Authenticated messages also need continuity when a customer changes email.

## Decision

Hiro approved sharing anonymous confirmations' store/email budget with later
authenticated messages. Match reservations by the store-scoped normalized email
identity and, when available, the customer identity. Count each matching message
once even when several identities or privacy keys match. Preserve customer-level
limits alongside email limits. Customers sharing an address share capacity.

Reuse existing HMAC identity normalization and current/previous privacy keys;
do not retain raw addresses in reservation tables or infer mailbox aliases.
Bind durable capacity to immutable source messages so retries cannot buy a second
slot. Include reservation records in privacy export, erasure and store cleanup
before enabling writers. Email matching grants no account access, purchase
verification, marketing consent or reward eligibility.

## Alternatives considered

- **Shared store/email budget with customer continuity** — selected because it
  covers anonymous and authenticated traffic without blocking confirmations.
- **Hold anonymous confirmations until linked** — rejected because linkage may
  never occur and the friend may never receive their confirmation.
- **Independent anonymous counters** — rejected because registration would create
  extra capacity and defeat the approved cross-module budget.

## Consequences

### Positive

- Anonymous and authenticated traffic cannot independently spend the same budget.
- Existing privacy identity handling supports normalization and key rotation.

### Negative / trade-offs accepted

- Distinct customers sharing an email address share capacity.
- Identity joins and privacy cleanup add schema and recovery responsibilities.

### Follow-ups

- Implement durable admission, privacy lifecycle, source leases and signed settings.
- Verify email/customer transitions, rotation, concurrent modules and replay in SQL.
- Retain the existing migration, live-send and release approval gates.

## References

- Hiro's approval in this task: “share anonymous confirmations’ email-based budget
  with later authenticated messages”.
- [ADR 0042](0042-shared-shopper-delivery-policy.md)
- [Implementation checklist](../loyalty/shared-shopper-delivery-policy.md)
