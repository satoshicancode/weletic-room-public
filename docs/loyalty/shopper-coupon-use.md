# Shopper coupon use — local settlement implementation

Status: local work in progress, 2026-09-07. The paid-order service is wired in
this branch; it has not been shipped or rolled out to a shared database. No
public review-policy activation or live Shopify acceptance is claimed.

## Contract

The shared reward catalog permits multiple uses. A redemption's first `orderId`
and `usedAt` cannot represent each subsequent use. The additive
`WeleticRewardCouponUse` model reserves one immutable fact per
`(storeId, redemptionId, orderExternalId)`, with shopper ownership, installation
generation, provider source, timestamp and the preceding redemption status.
It does not introduce another coupon generator or a points ledger.

Actual discount cost comes from matching product and shipping discount
allocations in Shopify shop money, not the coupon's face value, the entire
order discount, or presentment money. The parser uses exact integer minor units,
rejects nonzero excess fractional precision and signed-BIGINT overflow, and
returns an unavailable reason instead of inferring zero from missing evidence.
An explicit zero allocation is distinguishable from missing data. Mixed
currencies, ambiguous applications and invalid allocation indexes fail closed.
Application, line and total-allocation counts are bounded. The field shapes are
documented in Shopify's [Order reference](https://shopify.dev/docs/api/admin-rest/latest/resources/order);
this parser reads webhook evidence and adds no REST API requests.

The schema uses store-scoped composite Prisma relations and restrictive deletes.
The repository uses Prisma relation mode, so these declarations are not physical
database foreign keys. The transactional writer proves that the
redemption and shopper are the same owner, not merely two records in one store.
The raw webhook and customer metadata are not persisted in usage rows.

## Settlement and privacy behavior

- The existing store-first SERIALIZABLE settlement boundary checks installation
  generation and ownership, including the immutable claim/policy and original
  provisioning promise. A local reservation or matching code is not sufficient
  remote-issuance evidence. No Shopify I/O occurs inside a retrying transaction.
- Privacy cleanup intentionally scrubs provisioning metadata. Late paid-order
  events can instead use its retained, remotely verified same-owner snapshot,
  with a valid Shopify discount ID and matching installation. Pseudonymous
  shoppers require their existing HMAC ownership tombstone. Neither erased
  customer fields nor review participation evidence is restored.
- Replays cannot rewrite amounts, currency, timestamps or owners. Conflicting
  evidence remains a reconciliation issue. A later order appends another fact
  without replacing the first-use projection. Actual over-limit use is retained
  and flagged, never turned into shopper points debt. Missing cost remains null
  plus a reason. Arbitrary invalid order names are hashed in diagnostics.
- Compatibility and durable customer exports include shopper-scoped use rows;
  the artifact serializer preserves BigInts as decimal strings. Existing
  pseudonymous financial retention remains in force after customer erasure.
- After shop erasure, bounded cleanup uses the store's saved financial-retention
  deadline and verified remote voucher cleanup. Store-locked keyset pages remove
  only eligible coupon-use facts, preserving parent redemptions and ledger rows.
  Durable progress retains cumulative deletion counts across operator rescans.
  Unsafe facts remain for reconciliation; malformed progress is quarantined in
  a separate issue without overwriting its evidence or starving later stores.
  Late settlement cannot recreate facts after the saved deadline has elapsed.

## Local validation

- The exact reviewed additive SQL was applied only to the isolated loopback
  development database. Historical rows were not rewritten. A second staging
  run returned `isolated_schema_already_matches`.
- The focused parser and migration-plan suites passed 39 tests, including
  USD/JPY/VND/BHD, values above JavaScript's safe integer range, aggregate
  overflow, multi-line/shipping allocation, duplicate allocation rejection,
  malformed evidence and input bounds.
- The isolated MySQL suite passed 102 cases, including concurrent use, multiple
  permitted orders, over-limit use, contradictory replay, unknown costs, tenant
  and installation rejection, rollback, pseudonymous frozen-store use, and
  damaged cleanup identity. Source review found duplicate allocations and a
  missing remote-ID guard; both were corrected with regression coverage. An
  additional malformed-GID regression passed. Source rereview also cleared the
  bounded webhook minimization. Retention cases cover durable paging, cumulative
  audit counts, malformed-progress isolation, competing workers, generation
  changes, saved deadlines, missing remote proof and post-purge replay.
  These tests use production services and transactions but controlled
  provider responses; they are not a real checkout proof.
- The focused legacy settlement, durable export and artifact suites passed 116
  cases. The initial full suite found three legacy fixture mismatches; the
  corrected export mock and privacy-minimized route assertions passed a
  68-case targeted run. The full suite passed 4,415 tests with six skips across
  292 files, and the web build passed. Sequential web type-check and the final
  migration regression passed. Root lint, Shopify
  type-check/build, Prisma validation and nine mock/static validators passed;
  no live validator ran.

## Additive rollout

Obtain explicit shared-schema approval before merging or applying this change.
Apply `20260907_reward_coupon_use.sql` before deploying the application: it adds
the table with all indexes and the redemption composite unique index. The
separate `20260907_reward_coupon_use_retention_index.sql` is only for an isolated
database that already received the earlier table shape without that index;
do not apply both to a fresh database. The stager compares the complete diff to
the exact reviewed statements and rejects partial, duplicate or unexpected SQL.
The fresh table statement was also compared directly with Prisma-generated SQL;
the already-expanded isolated database passed the index-only no-op check.
Recovery contains the application writer; it does not drop financial tables.

## Required before this change can ship

1. Complete source review and final automated verification, including the
   malformed-identity changes. Validate the additive shared-schema rollout and
   obtain explicit merge/rollout approval. Local staging grants neither.
2. Finish coupon deactivation, expiry, uncertain provisioning recovery and
   unrecoverable used-benefit accounting before enabling the review caller.
3. Prove the real checkout and privacy lifecycle on the approved development
   store. Keep historical invitation sends and review caller activation gated.

The legacy account-backed settlement path is unchanged. Neither `yamaxdev` nor
the competitor-reference store was modified by this foundation work.
