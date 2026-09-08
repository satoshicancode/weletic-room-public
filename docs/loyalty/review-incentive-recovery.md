# Confirmed-invalid review incentive recovery — local implementation

This package-3 increment extends the existing internal points correction and
voucher-cleanup services. It is not an activated fraud adjudication interface,
automatic refund/moderation caller, or live Shopify acceptance result.

## Decision and recovery contract

- One durable decision per store/order-wide incentive claim, with a separate
  store-scoped decision ID. The actor, allowlisted confirmed-invalidity reason,
  original policy digest, review, award and fulfillment identity are immutable.
  Replays validate the original evidence; conflicting decisions fail closed.
- An unpaid points claim is cancelled without a ledger entry. A fulfilled points
  claim uses the existing exact append-only reversal, including its lifetime/VIP
  correction. No original ledger row is rewritten and no new award is created.
- A direct shopper coupon uses the existing `VOUCHER_PRIVACY_CLEANUP` outbox and
  winning-lease worker with an explicit `review_invalidation` source. The decision,
  claim invalidation, provisioning cancellation, quarantine and cleanup enqueue
  share the store-first transaction. There is no second coupon generator or
  recovery worker. Remote ownership and installation fences still apply.
- Unused coupons are deactivated or proven absent. Zero usage waits through the
  existing provider-reconciliation grace; a reactivated coupon is deactivated
  again. Ambiguous issuance/absence is not silently treated as success.
- Used benefits remain recorded, with no points debt or manufactured monetary
  receivable. Late paid-order usage can advance a completed decision's outcome
  to `coupon_used` without changing the original decision or restoring erased
  review content. The shopper label is “Benefit already used.”
- Star rating, publication, ordinary refunds and privacy requests are not
  confirmed fraud decisions. This service does not edit or hide review content.
  Public callers and trusted participation/adjudication activation remain gated.

## Cost and privacy evidence

The internal cost reader accepts an explicit accounting currency. It sums exact
recorded paid-order discount allocations with BigInt and returns decimal strings.
Missing allocations, mismatched currency/ownership, incomplete provider usage,
pending recovery and expired financial retention return `null` plus a reason.
The bounded reader refuses more than 1,000 usage rows rather than returning a
partial total. This is observed allocated discount cost—not coupon face value,
net-of-refund cost, causal revenue lift or a completed analytics dashboard.

Shopper and durable privacy exports include owned decision evidence, excluding
staff actor IDs and worker leases. Customer/shop erasure removes participation
evidence. Frozen-shop content purge preserves invalidation-linked claims and
policies so it neither cascades away financial evidence nor loops forever on
retained parents. Audit/ledger/fulfillment parents remain retained; this increment
does not implement their eventual physical deletion. Coupon-use detail retains
the existing saved-deadline purge contract, and expired detail cannot become a
false zero-cost report.

## Schema and rollout

Only the isolated loopback MySQL database has been staged. No shared development
database, `yamaxdev`, `n0pvef-cs`, provider coupon or email was changed.

1. `20260907_review_invalidation.sql` adds the decision table, a composite claim
   identity index and the appended cleanup-source enum value.
2. `20260907_review_invalidation_reward_status.sql` appends three review outcome
   labels without reordering the prior enum values or changing its default.

The guarded stager requires exact reviewed DDL, isolated database/principal and
Docker ownership, private credential files, unchanged historical row counts and
an empty post-expansion diff. Fresh Prisma output was compared directly with the
decision table and the exact inline-versus-separate claim index representation.
Already-expanded isolated staging returns a verified no-op. Relation mode is
Prisma; service ownership checks remain essential, not physical foreign keys.

Schema merge, shared-schema application and live activation remain distinct
approval gates. Recovery contains application writers; it does not drop financial
tables or rewrite historical balances.

## Verification status

- 120 isolated MySQL tests passed through production services and real Prisma
  transactions, with controlled provider responses and synthetic stores. Coverage
  includes competing invalidation/fulfillment, exact reversal replay, unattempted,
  used and reactivated coupons, delayed usage, strict evidence rejection, owned
  export, and points/coupon frozen-shop purge with retained audit evidence.
- Web and Shopify type-checks, Shopify build, Prisma validation, exact fresh DDL
  comparison and isolated no-op staging passed. The full unit suite passed 4,426
  tests with six existing skips across 293 files; the final focused rerun passed
  143 tests. Web compile-mode build, root lint (10 tasks), Prettier and nine
  mock/static validators passed. These checks do not replace committed-revision
  CI or live Shopify acceptance.
- Adversarial review found malformed points parsing, insufficient reversal replay
  validation, late-use outcome drift and a financial-parent/content-purge conflict.
  Regression coverage accompanies the fixes; the final source-only rereview
  reported no further concrete findings.

Live end-to-end journeys, authorized caller/UI activation, coupon expiry,
uncertain provisioning recovery beyond existing cleanup, store-review incentives,
financial reporting integration and eventual financial-parent retention cleanup
remain open. No blanket Smile/Judge.me parity claim is made.
