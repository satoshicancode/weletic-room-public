# ADR 0042: Shared shopper delivery policy

- Date: 2026-09-22
- Status: Accepted
- Stakeholders: Hiro (PO), Codex (impl)

## Context

Loyalty and Reviews can both send messages to the same shopper. Independent
quiet-hour and frequency settings would allow each module to obey its own limit
while their combined traffic exceeds the merchant's intended limit. The existing
shared merchant settings already provide a revision, an explicit nullable IANA
timezone, branding and a shopper-email pause switch. They do not yet coordinate
send capacity across modules.

The collection/reminder draft left this architectural choice open. Store-review
foundation PR #101 provides internal services and privacy/incentive integration,
but does not enable its collection journey or establish provider acceptance.

## Decision

Hiro selected Option A: use one per-store delivery policy shared by Loyalty and
Reviews, with the store's explicit timezone and a combined per-shopper send
budget. Reuse the signed owner-authorized shared merchant settings boundary.
Do not infer timezone from language, currency or customer location.

Coordinate capacity durably and transactionally before transport. A retry of the
same immutable message must not consume a second slot. Preserve each producer's
consent, suppression, eligibility, original expiry and provider-specific recovery
rules. Unknown timezone, uncertain provider outcomes and lost worker ownership
must not become permission for an additional send. Configuration does not enable
a module, authorize historical sends, or prove delivery to an inbox.

## Alternatives considered

- **Shared per-store policy** — selected because it coordinates the actual total
  messages sent to a shopper across modules.
- **Separate module policies** — rejected because independent limits permit
  overlapping sends and require a second cross-module safeguard. The accepted
  trade-off is less independent scheduling control for each module.

## Consequences

### Positive

- One owner-controlled policy governs shopper email across both modules.
- Reservations provide a common concurrency and retry boundary.

### Negative / trade-offs accepted

- All affected producers must use the shared boundary before enforcement is
  described as complete; a settings editor alone is insufficient.
- Durable capacity and privacy/recovery integration add schema and worker rollout
  requirements. Missing settings must not silently activate a restrictive policy.

### Follow-ups

- Implement settings, durable admission, signed EN/JA/VI controls and producer
  integration, preserving independent module switches.
- Verify DST, non-hour offsets, cross-midnight windows, unknown timezone,
  simultaneous sends, policy changes, retries, expiry, privacy and restart.
- Reconcile the retained collection/reminder draft without historical activation.
- Obtain scoped approval for shared/production migrations and actual sends;
  retain separate installed/provider/operational acceptance gates.

## References

- Hiro's approval in this task: “A.” following the shared-policy recommendation.
- [Store-review foundation PR #101](https://github.com/satoshicancode/weletic-room-public/pull/101)
- [Completion checklist](../loyalty/company-store-completion.md)
- [ADR 0040](0040-company-store-loyalty-and-reviews-completion.md)
- [ADR 0041](0041-review-privacy-flow-identities-and-execution.md)
