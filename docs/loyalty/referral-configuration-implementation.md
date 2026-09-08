# Shared referral configuration

Status: implemented with local evidence; exact-head CI pending. Not live accepted
on yamaxdev.

This follows reward catalog PR #84 (`103fc81d47`). Its post-merge quality gate
passed. Further review features remain deferred in this task; unrelated review
video work in another checkout is untouched.

## Scope and contracts

- Share the referral settings editor between authenticated Shopify staff and
  Weletic workspace users. Keep existing workspace activity/fraud-review controls
  and legacy APIs during the compatibility window. This increment does not add
  a Shopify referral activity/fraud-review screen or a second attribution system.
- Extract the existing transactional rule writer without changing its canonical
  selection, coupon eligibility, program-locking or legacy retry behavior. New
  gateways own fresh authority, operational store/generation fences, Serializable
  transactions and optimistic fingerprints. New clients never retry uncertain
  writes automatically. Reads never initialize a program or rule.
- Points use exact nonnegative signed-64-bit decimal strings. Thresholds retain
  existing **major-unit Decimal(10,2)** storage, unlike reward-catalog minor units.
  Reject excess currency precision rather than round: JPY/VND integral amounts;
  BHD can represent `1.01` (1,010 minor units) but this column cannot represent
  `0.001`. Supporting arbitrary three-decimal thresholds requires a staged schema
  change and is not claimed here.
- Select existing active/provisionable, fixed, store-scoped coupon definitions.
  Selection does not issue a coupon, spend points, write a ledger entry or enqueue
  a delivery. Fingerprints include every definition and rule so edits invalidate
  stale selections. Coupon mode requires zero unused configured point fields;
  unsupported legacy terms remain read-only rather than silently normalized.
- Pause has a separate status-only contract, including when currency/legacy terms
  cannot be edited. With no existing rule, runtime historically creates active
  defaults: the read projection exposes that effective state honestly, and an
  explicit pause persists an inactive canonical default. It does not initialize
  a missing loyalty program.
- Disabling an older active rule can expose a different canonical legacy row.
  Economic saves reject and roll back that mismatch; status-only pause remains
  available. Historical rule rows are not deleted to hide duplicate state.
- The shared in-flight lock survives scope and transport changes; stale results
  cannot populate another visit. Read-only users cannot submit mutations. The
  editor includes English, Japanese and Vietnamese text.

## Existing economics and remaining gates

Issued rewards and recorded history remain unchanged. Referrals not yet qualified
are evaluated using rules current at qualification; previously snapshotted friend
offers retain their terms. The editor discloses this inherited behavior.
Prospective referral-policy snapshots, subscription applicability, acquisition
precedence, broader referral operations and real merchant/customer acceptance
remain separate completion gates. No claim of full Smile parity is made.

No schema migration, deployment, activation, external send, bulk operation or
production repair is part of this increment. Preserve n0pvef-cs as the competitor
reference and use yamaxdev only for separately approved live acceptance.

## Verification checkpoint

- 60 isolated MySQL staff cases passed, including competing saves, exact large
  point values, authority/replay/generation checks, rollback, BHD threshold
  interpretation, cross-store coupon rejection, stale reward selection, durable
  empty-rule pause and preservation of all legacy economic columns during pause.
  Concurrency proves outcomes, not an observed database-lock contention trace.
- 175 focused contract/client/legacy API/RBAC cases passed; ten rendered component
  cases passed, including held mutations across scope/transport changes.
- Shopify types, build and 27 authenticated bootstrap tests passed.
- Adversarial review identified the empty-rule pause defect; the fix and actual
  runtime-acquisition regression passed. Follow-up review found no further
  concrete configuration-scope blocker.
- Full web unit suite: 345 files passed, 5,425 tests passed and six skipped.
- Web type-check, production compilation, root lint, Prisma validation and seven
  mock loyalty validators passed. Exact-head CI remains a merge gate; passing
  local mocks alone does not close live gates above.
- A loopback-only synthetic browser harness exercised the real shared editor and
  Shopify client: exact `9007199254740993` save/readback, confirmed pause, Japanese
  and Vietnamese mobile layouts. The Vietnamese viewport measured 375px content
  in a 375px viewport. This harness uses synthetic transport/state and partial
  local styling, not authenticated Shopify or full embedded-theme acceptance.
