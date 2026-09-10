# VIP achievement communications — implementation plan

Approved stream: complete loyalty communications. This branch starts from public
main `3427d1e3c6`; birthday PR #23 is a separate dependency for final integration.
No activation, provider send, deployment or new authorization is implied.

## Scope and behavior

- Announce a freshly committed threshold promotion using its sequenced tier
  history, not a balance or mutable tier assignment. One notice names the highest
  tier reached; skipped-tier entry rewards retain their existing accounting.
- A later requalification after a real downgrade has a new history identity and
  may create a fresh notice. Maintenance, grace, downgrade, manual/import placement
  and replay do not announce achievement. This is Weletic behavior: the preserved
  Smile reference has conflicting downgrade-notification descriptions.
- Suppress a delayed notice if a later transition superseded its history or the
  account no longer holds its target tier. Do not announce obsolete achievement.
- Snapshot the earned tier name and communication policy at transition time;
  subsequent text edits do not rewrite queued events. Current policy disablement,
  consent, privacy, pause and installation fences still stop delivery.
- Existing tier names may contain internal control characters. Normalize those
  characters to spaces in the captured message label, trim outside whitespace,
  and use the neutral label `VIP` if no printable content remains. Keep the tier
  record unchanged; notification formatting must not invalidate a valid promotion.
  The normalized snapshot is immutable, and direct event control injection fails.

## Implementation and contracts

1. Add strict internal VIP event/retained-job schemas and deterministic keys.
   Carry store/program/account/generation, history ID and sequence, from/to tier
   identities, captured rank/name, effective time and immutable policy revision.
   No recipient, birth date, points balance, fabricated ledger/order or reward.
2. Enqueue in the existing store/program-fenced promotion transaction after the
   history row is created. Roll back history, account and outbox together on error.
   No retrospective opt-in/backfill. Preserve existing grants and Flow events.
3. Extend the existing leased communication worker/retention contract; validate
   owned history and latest transition before sending or retrying. Render only
   the existing `tier_name`/common variables, with EN/JA/VI and trusted CTA/sender.
4. Expose truthful merchant readiness for VIP, preserving old response meanings.
   Upgrade strict readers before producers, or use a coordinated drained rollout.

Affected subsystems: tier lifecycle, internal communication contracts/producer,
worker/source verification, retained delivery, merchant gateway/shared editor,
privacy tests and acceptance documentation. No database migration, public write
endpoint, billing, provider, tier qualification or reward-policy change.

## Verification and definition of done

- Contract rejection: wrong tenant/account/tier, non-promotion, missing/invalid
  sequence, wrong policy, unsafe names, injected identifiers and malformed dates.
- Actual isolated MySQL: concurrent promotion, replay, opt-in containment,
  downgrade/re-promotion, outbox failure rollback, latest-history invalidation,
  installation generation and privacy before/after worker completion.
- Shared editor EN/JA/VI mobile and keyboard, loading/error/permission states;
  focused and full tests, types/lint/builds/Prisma, adversarial review and public CI.
- Named live inbox evidence and `yamaxdev` lifecycle remain separate execution
  gates. Local schemas or mocked delivery do not complete the journey.

Current status: contract implementation in progress; no producer, worker or UI
integration is published. Birthday must be integrated without losing purchase or
signup variants. The frozen historical-import stream remains untouched.

## Local contract checkpoint

The strict event/retained-job contract and key helper pass all 45 focused tests,
targeted TypeScript checking and focused lint. Initial tests failed because the
fixture imported its default-policy helper from the wrong module; that import was
corrected. Independent review found the legacy tier-name control-character
compatibility issue described above; normalization and immutability cases now
pass and the correction was re-reviewed without a new blocker.

No producer, worker, SQL, browser or live evidence exists for this VIP draft yet.
This checkpoint is not feature completion or permission to send notifications.
