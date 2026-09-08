# Distributed Discount Saga and Outbox Recovery Runbook

**Document Version:** 2.1.0 (staging-validated implementation reference)

**Last Updated:** 2026-08-30
**Scope:** `apps/web/lib/weletic/loyalty/saga.ts`, `apps/web/lib/weletic/loyalty/shopify-discounts.ts`, `apps/web/lib/weletic/loyalty/outbox-worker.ts`

---

## 1. 4-Phase Distributed Saga Architecture

Reward redemptions span two independent transaction domains: the local MySQL/Prisma loyalty ledger and the remote Shopify GraphQL Admin API (`2026-07`). Because a single database transaction cannot cover Shopify, Weletic employs a **4-Phase Distributed Compensation Saga**:

```
[ PHASE 1: LOCAL RESERVATION & DEBIT ]
  │ - Validate account balance >= pointsCost
  │ - Create WeleticRewardRedemption (status: 'provisioning')
  │ - Append REDEEM_REWARD debit ledger entry (pointsDelta: -pointsCost)
  │ - Enqueue durable REDEMPTION_RECOVERY outbox job (scheduledFor: now + 2 min)
  ▼
[ PHASE 2: SHOPIFY GRAPHQL ADMIN PROVISIONING ]
  │ - Resolve offline store credentials
  │ - Persist a uniquely prepared remote-create attempt marker before dispatch
  │ - Re-check the active program and exact currency generation
  │ - Execute discountCodeBasicCreate / discountCodeFreeShippingCreate / discountCodeBxgyCreate
  │ - If TAKEN collision: lookup codeDiscountNodeByCode; if ours adopt, if foreign generate WL-XXXXXXXXXX suffix
  ├── Success / owned active lookup ───────────────► [ PHASE 3: FINALIZATION ]
  │                                                   - Store Shopify GID
  │                                                   - Mark redemption 'issued'
  │                                                   - Enqueue METAFIELD_SYNC
  ├── Definite pre-create or terminal failure ─────► [ PHASE 4: COMPENSATION ]
  │                                                   - Mark redemption 'failed'
  │                                                   - Restore points exactly once
  └── Create outcome unknown ───────────────────────► [ RECONCILIATION ]
                                                      - Owned active: adopt/finalize
                                                      - Owned inactive: converge cleanup
                                                      - Lookup miss: retry during the
                                                      visibility horizon, then require
                                                      manual reconciliation; never refund
                                                      solely from a lookup miss
```

The create outcome is unknown after a transport timeout, an HTTP failure after
dispatch, top-level GraphQL errors (including partial `data`), mutation payload
`userErrors`, or a missing mutation node. None of those envelopes proves that
Shopify did not commit the deterministic code. If the same invocation fails
the second local fence before dispatch, it conditionally clears only its own
preparation marker and may compensate; a marker replaced by another worker is
left for reconciliation.

Voucher economics are bound to `shopCurrency` plus the exact
`currencyVerifiedAt` generation. Webhook lifecycle replay is separately bound
to `installationGeneration`; routine same-currency catalog verification does
not rotate either lifecycle authority or the monetary generation.

---

## 2. Shopify GraphQL 2026-07 Adapters

All discount creation operates via GraphQL mutations targeting Admin API `2026-07` by default. `SHOPIFY_ADMIN_API_VERSION` may override it for controlled compatibility testing.

### 2.1 Amount Off / Percentage Off (`discountCodeBasicCreate`)

- Target: `apps/web/lib/weletic/loyalty/shopify-discounts.ts:633-780`
- Supports `fixed_amount` and `percentage` discounts.
- Applies usage limits (`usageLimit: 1`, `appliesOncePerCustomer: true`).
- Restricts to specific collections or products if configured.

### 2.2 Free Shipping (`discountCodeFreeShippingCreate`)

- Target: `apps/web/lib/weletic/loyalty/shopify-discounts.ts:781-908`
- Supports maximum shipping price limits and country-specific restrictions.

### 2.3 Buy X Get Y Free Product (`discountCodeBxgyCreate`)

- Target: `apps/web/lib/weletic/loyalty/shopify-discounts.ts:909-1060`
- Configures required purchase quantity and gifted variant discount value.

### 2.4 Code Collision Resolution

If Shopify returns error `"code has already been taken"`:

1. Call `lookupDiscountByCode(shopDomain, accessToken, code)` and require a complete, unambiguous node.
2. Verify ownership from the exact persisted redemption identity: store, redemption, account, reward definition, canonical code, and the persisted ownership fingerprint/title must all match. Code text or a Weletic/Dub-looking title alone never establishes ownership.
3. Before adoption, verify the remote status plus every immutable economic and eligibility field written by Weletic: reward type/value/currency, starts/ends, usage controls, customer selection, minimum requirement, combinations, subscription policy, and product/variant/collection scope.
4. If ownership and configuration match and the node is active, adopt its GID. If the exactly owned node is inactive, converge local compensation. If the marker matches but economics or eligibility were altered, deactivate the exact node before compensation; never give the shopper both restored points and an altered live voucher.
5. If the complete lookup proves the code belongs to another owner, persist a new canonical `WL-XXXXXXXXXX` code and ownership identity before retrying creation. A lookup miss after a remote-create attempt remains an uncertain outcome and cannot authorize compensation.

---

## 3. Outbox Background Recovery Worker (`outbox-worker.ts`)

The background outbox worker (`apps/web/lib/weletic/loyalty/outbox-worker.ts`) sweeps and reconciles asynchronous jobs:

### 3.1 Supported Outbox Job Types

1. `HOLDING_PERIOD_RELEASE`: Releases matured pending points to available balance.
2. `INACTIVITY_EXPIRY`: Writes an `EXPIRATION` debit if no qualifying activity occurred within `pointsExpiryMonths`.
3. `TIER_REVIEW`: Evaluates rolling/calendar tier maintenance and schedules downgrade grace periods.
4. `METAFIELD_SYNC`: Batches and synchronizes the PII-sanitized customer loyalty metafields to Shopify Admin GraphQL.
5. `REDEMPTION_RECOVERY`: Sweeps and reconciles stuck `provisioning` discount redemptions and unused-voucher expiry.
6. `BIRTHDAY_REWARD`: Applies the annual eligibility clock and schedules the next idempotent birthday award.
7. `REFERRAL_REWARD_PROVISION`: Issues an exactly snapshotted, no-points-cost referral voucher.
8. `VOUCHER_PRIVACY_CLEANUP`: Deactivates an exactly owned unused voucher before privacy compensation/cancellation.

`REDEMPTION_RECOVERY` also carries an `expiry` phase. At an unused voucher's `expiresAt`, the handler atomically transitions `issued` to `expired`, restores points once, and deactivates the Shopify discount. A voucher already marked `used` is never refunded or deactivated by expiry.

The worker accepts an exact `storeId` and/or explicit `jobIds` scope for staging validation and manual recovery. A logical clock is permitted only when both the exact `storeId` and an explicit non-empty `jobIds` allowlist are supplied. It controls only scoped candidate eligibility and business-time evaluation. Stale-lock reaping, lease acquisition, completion, failure, and retry timestamps always use wall time, and callers must not combine `logicalNow` with the legacy wall-clock `now` override. Time-travel tests must target only disposable fixture jobs; never advance a broad worker batch over unrelated staging or merchant jobs.

### 3.2 Distributed Lease Locking Pattern

- **Atomic Lease Lock**: Atomically claims candidate jobs via `updateMany` matching `status: pending` and `lockedAt: candidate.lockedAt`, setting `lockedAt: now`, `lockedBy: workerId`, and `status: processing`.
- **Stale Lock Reaper**: Automatically resets stuck locks where $\text{lockedAt} < \text{now} - 300,000\text{ ms}$ (5 minutes) back to `failed` for immediate retry.
- **Dead-Letter Handling**: After 5 failed attempts (`attempts >= maxAttempts`), job transitions to `dead_letter` status with full JSON error audit trail (`errorLog`).

---

## 4. Operational Recovery Runbook

### 4.1 Diagnostic Inspection Commands

```bash
# 1. Count stuck provisioning redemptions and dead-letter jobs
pnpm --filter web exec tsx -e "
import { prisma } from './lib/prisma';
async function main() {
  const stuck = await prisma.weleticRewardRedemption.count({ where: { status: 'provisioning' } });
  const dead = await prisma.weleticLoyaltyOutboxJob.count({ where: { status: 'dead_letter' } });
  console.log({ stuckProvisioning: stuck, deadLetterJobs: dead });
}
main();"

# 2. Trigger an immediate, explicitly scoped outbox worker batch
pnpm --filter web exec tsx -e "
import { processOutboxJobsBatch } from './lib/weletic/loyalty/outbox-worker';
async function main() {
  const result = await processOutboxJobsBatch({
    batchSize: 100,
    storeId: '<exact-internal-store-id>',
    jobIds: ['<audited-job-id>'],
  });
  console.log('Outbox batch result:', result);
}
main();"

# 3. Trigger manual saga redemption sweep
pnpm --filter web exec tsx -e "
import { sweepStuckSagaRedemptions } from './lib/weletic/loyalty/saga';
async function main() {
  const result = await sweepStuckSagaRedemptions({
    olderThanMinutes: 2,
    storeId: '<exact-internal-store-id>',
  });
  console.log('Sweep result:', result);
}
main();"
```

### 4.2 Manual Remediation Procedures

1. **Redemption Stuck in `provisioning`**:
   - Resolve the exact store and redemption, then inspect the persisted ownership identity and immutable provisioning snapshot before querying Shopify.
   - Adopt a Shopify node only when the canonical code, persisted ownership marker, active status, economics, eligibility, currency generation, and installation generation all match. A matching code or title is insufficient.
   - If an exactly owned discount is already inactive, rerun scoped recovery so local cleanup converges without repeating the remote mutation.
   - If the redemption has a remote-create attempt marker and lookup misses: do not refund from that miss. Retry during the visibility horizon, then dead-letter for manual reconciliation. Compensate only after an operator obtains authoritative evidence that Shopify never created the discount.
   - If failure was definite and occurred before any remote create attempt: run `compensateDiscountSaga(redemptionId)` to refund reserved points and mark `failed`.
2. **Dead-Letter Outbox Jobs**:
   - Inspect `errorLog` in `WeleticLoyaltyOutboxJob` record.
   - Fix underlying root cause (e.g. invalid Shopify token).
   - Reset a confirmed retryable job through an audited Prisma/operator script. Verify the exact `storeId` and job ID first; do not run a broad raw SQL update.
