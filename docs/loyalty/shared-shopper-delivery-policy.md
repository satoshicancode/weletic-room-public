# Shared shopper delivery policy implementation

Date: 2026-09-23. Decisions: [ADR 0042](../adr/0042-shared-shopper-delivery-policy.md) and [ADR 0043](../adr/0043-shared-email-delivery-budget.md).

## Implemented boundary

`apps/web/lib/weletic/merchant-settings/delivery-policy.ts` provides an internal
strict versioned contract and pure scheduling evaluator. The durable admission
layer now connects existing producers; policy controls are not yet exposed by
merchant settings. This remains draft implementation, not installed acceptance.

- One optional local quiet window, with inclusive start and exclusive end.
  Equal endpoints are rejected so they cannot mean either all day or no window.
- An optional combined rolling 24-hour limit, measured in elapsed time rather
  than calendar days. Separate reservations at the same instant remain separate.
- An explicit validated store timezone for a configured policy; none is inferred.
- Quiet hours evaluated at UTC instants, covering skipped/repeated local times
  and non-hour timezone offsets. Capacity release is evaluated before quiet hours.
- Original message expiry is never extended. An unavailable configuration blocks
  scheduling; explicit null means unconfigured. Pause remains a separate block.
  If current policy leaves no window before a future expiry, the source is
  blocked, not prematurely expired: a later policy revision can reopen a window.

This calculation does not grant consent, reserve capacity, fence a worker, prove
transport delivery, or authorize retries. Every producer must still enforce those
boundaries. The caller must re-evaluate at dispatch because settings and local time
can change after a message becomes due.

## Accepted identity and durable enforcement

Anonymous confirmations share their store/email rolling budget with later
registered-customer messages. Customer limits also apply independently, so an
email change does not reset the customer budget. Customers using the same email
share that email's capacity. No customer identity is inferred for an anonymous
source, and an immutable retry cannot acquire a new identity kind.

Two additive tables retain one reservation per immutable source and rotating
HMAC identity aliases. The store mutation lock serializes policy reads, capacity
counts and reservation creation. Both the reservation and identity subquery use
MySQL locking reads; an older RepeatableRead snapshot cannot miss a concurrent
winner. Uncertain attempts consume capacity. Retries reuse exact content,
provider/source identity, original expiry and original provider deadline.
Admission samples production time after lock acquisition; delayed rendering or
lock waits cannot borrow an earlier quiet-hours/expiry window.

Existing Loyalty communications, both modern and legacy points-expiry templates,
anonymous referral confirmations and product-review invitations use this layer.
Expiry messages require a current installed worker claim, including legacy
messages. Ambiguous legacy evidence without a matching reservation requires
reconciliation rather than a new send. SMTP ambiguity remains terminal.

Anonymous confirmations now enqueue a source-only `ANONYMOUS_REFERRAL_EMAIL`
job. A policy deferral preserves attempts and encrypted rendered bytes. A marked
queued message with zero transport attempts may wait longer than 23 hours before
its first admission; only then is its provider retry window anchored. Once an
attempt is recorded, the original deadline never moves. Coupon expiry never
moves. Paused anonymous work is excluded from the bounded poll page so it cannot
starve financial/cleanup work. No historical confirmations are collected.

## Privacy and rollout

Delivery exports project explicit operational fields, excluding HMAC aliases,
content digests, recipients and transport bytes. Customer ownership includes
customer-ID records and anonymous records matching their email, never another
identified customer's shared-mailbox history. ID-only compliance requests retain
the trusted same-store shopper mailbox before pseudonymization. Erasure removes
owned reservations, then only matching email aliases on foreign owned records;
other customers retain their customer capacity. Store erasure and key-retirement
audit include both tables, including orphan aliases.

Encrypted export checkpoints preserve exact page membership after an ambiguous
artifact write. Compatible workers must understand `export_shopper_delivery`,
`scrub_customer_delivery` and `purge_shopper_delivery` through recovery.

Before enabling writers:

1. Apply `20260923_shopper_delivery_budget.sql` under the separate shared-schema
   gate. It adds two tables, nullable settings JSON and appends the outbox enum;
   existing enum ordinals remain unchanged. Readers require schema compatibility
   even when collection is disabled.
2. Drain existing data exports before rollout, or reconcile/restart their source
   requests. Already-pseudonymized exports without saved delivery identities stop
   for operator review; they must not silently skip the new phase.
3. Keep a compatible worker until all persisted new phases and confirmation jobs
   are drained. A rollback to an older reader/worker is not safe after new writes.
4. Reconcile existing uncertain delivery evidence before resuming it. The new
   budget must not manufacture a reservation for a possibly-sent legacy retry.

## Remaining work

- Revision-fenced merchant settings, signed EN/JA/VI controls and prospective
  activation boundary. Unconfigured policy is explicit null; no default timezone
  or cap is inferred.
- Reconcile the retained collection/reminder draft and store-review invitations
  with the same admission boundary before enabling those writers.
- Complete UI, installed yamaxdev/provider journeys and operational release gates.
  Local SQL/mock-provider evidence does not certify actual delivery.

## Local verification

- Full web units: 10,044 passed, six existing skips, 618 files.
- Complete shopper SQL suite: 187 passed, including 16 shared admission cases
  covering competing identities, old transaction
  snapshots, key rotation, shared-mailbox erasure and clock-boundary lock waits.
- Anonymous confirmation SQL: 21 cases, including 25-hour zero-attempt deferral,
  original uncertain-attempt deadline and later authenticated email competition.
- Communication retention SQL: 59 cases; a separate paused-backlog SQL regression
  proves financial work remains eligible, and another proves policy deferral restores
  the exact worker claim without consuming attempts. Expiry retention SQL: five cases,
  including delayed rendering across quiet-hours start.
- Each SQL run used a fresh restricted database, rehearsed additive migrations,
  removed its exact database/principal and left retained development ledger count
  16 unchanged. Provider calls were mocked. CI/build evidence is tracked in the
  store-review worklog rather than inferred from these tests.

No shared/production migration, provider send, module activation or deployment
occurred. No Loyalty or Reviews release gate is closed by this draft.
