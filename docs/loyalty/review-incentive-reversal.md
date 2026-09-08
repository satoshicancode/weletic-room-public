# Review incentive invalidation — gated points correction

This package-3 service appends a correction for an already fulfilled product-
review points claim. It is not a fraud detector, public fraud-review interface,
coupon recovery service, or activation change. A future authorized caller must
provide a confirmed decision ID, actor ID and allowlisted reason; no shopper
input, star rating, publication change, ordinary refund or privacy request is
treated as that decision.

## Financial and lifecycle contract

- The store/program transaction revalidates ownership, installation generation,
  original policy and the exact original ledger marker. Unpaid, coupon, redacted,
  conflicting or damaged claims fail closed. Earlier-installation and redacted
  claims require operator reconciliation rather than an automatic correction.
- Exactly one negative `REFUND_REVERSAL`, explicitly referenced as
  `REVIEW_INCENTIVE_REVERSAL`, reverses the original positive award. The amount is
  not capped by the remaining balance; spending invalid points can leave a
  negative balance. It is never a `BACKFILL_CORRECTION` or an ordinary refund.
- The append-only correction retains the confirmed decision and original award
  ID. The original ledger, policy, award/validation snapshots and order-wide claim
  remain. Claim/review invalidation markers and the tier-review job commit with
  the correction. Identical retries return the original result; contradictory
  decision or ledger evidence cannot overwrite it or cause another correction.
- Disabling the modules does not erase an existing financial obligation or block
  its correction. Store freeze, installation, maintenance and privacy fences still
  apply. The service does not publish, hide, delete or edit the review's content.
- Only this explicit invalid-review reversal reduces lifetime-earned points.
  Append, independent ledger audit and cache rebuild use the same classification;
  ordinary refunds preserve their previous lifetime-earned behavior.
- VIP qualification removes the invalid original contribution from its earn
  window. It does not subtract a prior-cycle award from unrelated current-cycle
  earnings. Same-store/account reversal lookups use batches of at most 500 claim
  IDs and require the exact original entry, amount and financial key. Damaged
  evidence fails closed. Existing tier grace, lifetime-tier retention and
  historical tier-entry rewards are not rewritten by this correction.

## Local evidence

The isolated MySQL suite passed 80 cases with successful fixture cleanup. Nine
reversal-specific cases cover competing corrections after spending, negative
balances, large integers, changed content/disabled modules, contradictory
decisions, atomic rollback, tenant/generation/privacy/unpaid rejection, damaged
award evidence, actual tier progression plus audit/cache reconciliation, and
original-window matching with ordinary-refund preservation. The focused ledger
and tier suites passed 48 tests. Production services and Prisma transactions are
used, but purchase/participation and confirmed decisions are controlled fixtures.
No real store, merchant balance, provider coupon or shared database was changed.

The full unit suite passed 4,386 tests with six existing skips across 291 files.
Web/Shopify type-checks, root lint (10 tasks), formatting, Prisma validation,
web production compile-mode build, Shopify build and nine mock/static validators
passed. Independent review identified the missing lifetime/VIP effect in the
initial balance-only draft; the corrected projections and DB tests passed
rereview without further concrete findings. Full release CI must still verify
the committed revision before merge. These are not live-store acceptance claims.

## Remaining acceptance gates

Trusted participation and authorized fraud adjudication, invalidation of unpaid
claims, coupon deactivation/used-benefit cost accounting, full privacy/recovery,
store-review participation and `yamaxdev` journeys remain open. The service has
no public or automatic caller. Full unit/build/CI verification is required before
merge; shared schema rollout and live activation remain separately gated.
