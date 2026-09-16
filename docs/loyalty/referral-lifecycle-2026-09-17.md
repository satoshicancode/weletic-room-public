# Referral qualification and clawback — September 17, 2026

This checkpoint advances L06 using existing contracts. It is not live referral,
coupon issuance, subscription classification or complete loyalty acceptance.
PR #61's separate anonymous confirmation milestone passed its post-merge run
[35122798043](https://github.com/satoshicancode/weletic-room-public/actions/runs/35122798043).

## Defect reproduced and fixed

The qualification service read the referee account and Shopify order count
before entering its serializable transaction. A paid-order update committed
between that read and transaction admission could make the friend ineligible,
while qualification still awarded both sides using the old count. A real-MySQL
regression changed the count from one to two at this boundary and reproduced an
incorrect successful award.

Qualification now rereads referee identity, program membership, activity,
redaction evidence and order count after acquiring the existing store/program
locks. That transaction already owns referral claims, ledger writes, cap counters
and outbox jobs. No new authorization model, API or migration is introduced.

## Evidence

The isolated suite has 21 passing cases:

- Eight competing binds return one referral identity; eight qualifications award
  once; eight refund attempts reverse once. The terminal referral cannot qualify
  again, and both balances and the advocate counter reconcile.
- Competing advocates preserve one acquisition owner. Different friends competing
  for the last advocate cap slot produce one award, with the other still unpaid.
- Persisted order-line subtotals, not the caller's subtotal, govern exact USD
  minor-unit boundaries at 999/1,000. Manually supplied subscription facts admit
  sequence one and reject renewal two or unknown sequence under the existing
  first-payment policy.
- Spent referral points reverse into exact debt, not replacement points.
- Stale installation generation, a program kill switch, closed accounts and a
  foreign store fail closed. Changes after the optimistic read—second order,
  closure, redaction and different program membership—cannot authorize rewards.
  The second-order case records `fraud_blocked`.
- A failure after domain work but before commit rolls back the referral claim,
  cap, ledger and new outbox effects together.
- A mixed coupon/points qualification freezes the coupon job payload across
  reward edits and replay. Synthetic issued/used redemptions exercise refund
  containment: an unused coupon is cancelled and queues recovery; a used coupon
  stays used and retains the advocate's lifetime cap slot.

No domain service or SQL call is mocked. Test-only hooks schedule the intervening
write and the pre-commit error. Orders and provider states are synthetic; no
Shopify call, real coupon, email or deployment occurs. Raw SQL independently
compares every fixture account balance with the sum of its tenant-bound ledger.

The database is strictly guarded as
`127.0.0.1:3307/weletic_loyalty_it_referral_20260917_a`, not the shared development,
legacy or production schema. The first run exposed a fixture-cleanup problem:
the account self-reference prevented deletion. Cleanup now clears fixture
`referredById` values before deleting those accounts. The 16 identified abandoned
fixture tenants were removed only from this isolated database; an independent
audit then found all 157 tables empty. The complete 21-case rerun also cleaned up
and reconciled all 157 tables empty.

The existing deterministic referral suite passes 49 tests, including four new
transactional-snapshot regressions. Its qualification mocks now return the
account for both reads; assertions are not weakened. Full regression/build/CI
results are recorded in the implementing PR, not inferred from this checkpoint.

Reproduce the database suite with
`pnpm --filter web exec vitest run --config vitest.referral-lifecycle-db.config.ts`
and an independently provisioned fresh database satisfying the suite's exact
host/user/name guard plus `LOYALTY_DATABASE_INTEGRATION=1`. Never substitute a
shared database. Unit runs use CI's dummy Shopify app identity.

## Explicit remaining work

- These direct reversal tests do not prove the webhook's partial-versus-full
  refund decision. Complete named paid-order → partial/full refund journeys and
  independently reconcile their ingested facts on yamaxdev.
- Populating subscription sequence fields is policy-filter evidence, not proof
  that Shopify renewal classification supplies those fields correctly.
- Order-to-referee linkage remains an upstream caller invariant; this suite
  demonstrates cross-store rejection, not every same-store caller linkage.
- Prove coupon worker issuance/recovery, checkout consumption, real Flow workflows
  and communications using the actual installed public app under their separate
  execution gates. Synthetic redemption rows do not close those gates.
- The broader analytics/funnel, appearance and deployment backlog remains open.
  No new appearance defaults, artwork ownership or external execution decision
  is inferred from this work.
