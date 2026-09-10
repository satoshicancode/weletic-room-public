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

Current status: contract and producer are local drafts; no worker or UI
integration is published. Birthday PR #23 merged as `b4685b5803` and was merged
into this branch without conflicts, retaining purchase and signup variants.
The frozen historical-import stream remains untouched.

## Local contract checkpoint

The strict event/retained-job contract and key helper pass all 45 focused tests,
targeted TypeScript checking and focused lint. Initial tests failed because the
fixture imported its default-policy helper from the wrong module; that import was
corrected. Independent review found the legacy tier-name control-character
compatibility issue described above; normalization and immutability cases now
pass and the correction was re-reviewed without a new blocker.

## Local producer checkpoint

The producer accepts only a fresh threshold-promotion receipt, checks the owned
active account and current target tier, compares persisted latest history to the
receipt, reads tiers through the owned program and verifies the expected active
installation generation. It uses the caller's transaction and propagates enqueue
failure. Policy snapshot selection now accepts `vip_achieved`.

All 62 contract/producer tests and focused lint pass. The first producer test
attempts could not load unbuilt shared workspace packages and the ungenerated
Prisma client; after building/generating those prerequisites, both suites pass.
These are mocked enqueue tests, not proof of database rollback or races.
Full web type-check was started before prerequisites existed and failed; its
post-prerequisite rerun exhausted Node's default heap. With the established 8 GB
allowance, the producer and initial sender snapshot passed full web type-check.

Independent producer review found no tenant/history/generation defect. The
producer was intentionally left unwired at that checkpoint. This is not feature
completion or permission to send messages.

## Local reader/sender checkpoint

The strict shared retained-job union accepts VIP events. The sender preserves
purchase/signup/birthday predicates and uses owned sequenced tier history for
VIP, without fabricated ledger evidence. It renders the captured tier name and
reuses the existing current-policy, consent, privacy, sender and encrypted retry
checks. No merchant readiness claim has been enabled.

Independent review caught a stale-admission window: SQL-only tier writers could
change history after the sender's first check. A shared source verifier now also
checks current tier/latest owned history inside retention's store/program-fenced
transaction before first sends and retries. This is admission-time ordering, not
a claim that external provider delivery is atomic with later database writes.

All 141 focused contract/producer/sender/retention tests pass, including policy
disablement, encrypted retry and same-tier re-promotion winning before admission.
The interleaving tests use mocked transactions; actual SQL race/rollback,
retained privacy scrub, lifecycle integration, merchant UI, browser and live
acceptance remain required. The corrected snapshot passes full web type-check
with the 8 GB allowance, focused lint and formatting. Independent correction
review found the admission gap closed and no new blocker. Birthday post-merge
CI run `34487797175` passed all six checks on `b4685b5803`.

## Local promotion wiring checkpoint

The actual promotion branch now calls the producer immediately after creating
tier history, passing that returned row, the account's program, the existing
transaction and the generation from its locked operational-store guard. Flow
events and skipped-tier entry bonuses remain in the same transaction. Maintenance
and downgrade branches do not call the producer.

All 84 tests across five tier lifecycle/accounting suites pass, along with full
web type-check and focused lifecycle lint. New caller tests verify fresh-history
handoff, maintenance replay exclusion and enqueue-error propagation. Four legacy
accounting-only suites explicitly mock the producer; their existing accounting
assertions remain intact. Initial failures were missing notification fixture
data and a test import removed while unused, both corrected without weakening
production validation. Independent wiring review found no blocker.

Real SQL concurrent promotion, rollback, later opt-in, stale generation,
downgrade/requalification and retained privacy cleanup remain unverified. The
merchant readiness UI, combined full regression/build and live acceptance remain
unfinished; this local wiring is not a published or deployed feature.
