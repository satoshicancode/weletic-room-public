# Shared shopper delivery policy implementation

Date: 2026-09-23. Decision: [ADR 0042](../adr/0042-shared-shopper-delivery-policy.md).

## Implemented boundary

`apps/web/lib/weletic/merchant-settings/delivery-policy.ts` provides an internal
strict versioned contract and pure scheduling evaluator. It has no transport,
database or activation side effects and is not yet exposed by merchant settings.

- One optional local quiet window, with inclusive start and exclusive end.
  Equal endpoints are rejected so they cannot mean either all day or no window.
- An optional combined rolling 24-hour limit, measured in elapsed time rather
  than calendar days. Separate reservations at the same instant remain separate.
- An explicit validated store timezone for a configured policy; none is inferred.
- Quiet hours evaluated at UTC instants, covering skipped/repeated local times
  and non-hour timezone offsets. Capacity release is evaluated before quiet hours.
- Original message expiry is never extended. An unavailable configuration blocks
  scheduling; explicit null means unconfigured. Pause remains a separate block.

This calculation does not grant consent, reserve capacity, fence a worker, prove
transport delivery, or authorize retries. Every producer must still enforce those
boundaries. The caller must re-evaluate at dispatch because settings and local time
can change after a message becomes due.

## Identity decision outstanding

Anonymous referral confirmations have an email identity before a Shopify customer
or shopper record exists. The existing sender is
`apps/web/lib/weletic/loyalty/anonymous-referral-confirmation.ts`. Its immutable
origin retains a store-scoped email digest, and its prepared request is encrypted.
Authenticated Loyalty and Reviews messages also carry shopper/customer identities.

Hiro has been asked to choose between a shared store/email budget that also keeps
customer limits, or holding anonymous confirmations until linked to a customer.
The first option coordinates anonymous and later authenticated sends, but two
customers sharing an address also share capacity. The second can prevent a friend
from receiving their confirmation indefinitely. This choice is separate from the
approved shared-versus-per-module policy. Neither behavior is implemented yet.

## Remaining implementation sequence

1. Resolve the identity decision and define durable reservation/identity records.
   Bind each immutable source message to store, installation, module, provider key,
   content digest and original expiry. Retain uncertain attempts as consumed
   capacity. A retry must reuse its reservation; it cannot claim a fresh slot.
2. Add additive schema/DDL and owner discovery, export, erasure and store cleanup
   before creating records. Reuse the existing store mutation lock order for
   atomic policy read, capacity count and insertion. Include key rotation in the
   email-identity implementation if selected. A read-only count is insufficient.
3. Add revision-fenced shared merchant settings and signed EN/JA/VI controls. Do
   not expose an enforceable setting until all relevant producers use admission.
   Define a prospective activation boundary without sending historical messages.
4. Integrate the producer paths below and the retained collection/reminder draft.
   Policy deferral must preserve the exact source claim and attempt budget. Keep
   original provider retry deadlines, immutable rendered bytes and consent checks.
5. Verify isolated SQL concurrency, crash recovery, source-transaction rollback,
   changed policy/generation, cross-store isolation, privacy races and provider
   uncertainty. Then run UI, CI and scoped installed acceptance gates.

| Producer                           | Existing immutable delivery boundary                                        | Required integration                                                                                   |
| ---------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Loyalty communications             | `communication-delivery-snapshot.ts`, then `points-earned-notifications.ts` | Reserve with retained source ownership; recheck at transport; defer outbox without spending an attempt |
| Points expiry                      | `expiry-delivery-snapshot.ts`, then `points-expiry-notifications.ts`        | Same shared admission while retaining source expiry and provider retry deadline                        |
| Anonymous referral confirmation    | `anonymous-referral-confirmation.ts`                                        | Resolve identity first; preserve exact lease and encrypted request through deferred/uncertain outcomes |
| Product review invitation          | `reviews/email.tsx` and `reviews/prepared-email.ts`                         | Atomic admission with request claim; preserve SMTP ambiguity containment and Resend replay bounds      |
| Review reminders/store invitations | Retained collection draft and unpublished store service                     | Reconcile with this shared boundary before enabling either writer                                      |

## Verification evidence

- Scheduling and existing merchant-settings contract tests: 74 passed in two
  files, including 41 scheduling cases.
- Independent review found a date-range overflow edge case; fixed with a finite
  candidate guard and a regression test.
- Web typecheck, targeted lint and formatting passed.
- The evaluator has no SQL or UI integration, so these unit results do not certify
  reservation concurrency, end-to-end policy enforcement or live delivery.

No shared/production migration, provider send, module activation or deployment is
part of this work. Those existing gates remain separate.
