# Points Accounting Guide: Weletic Loyalty Engine

**Document Version:** 2.0.1 (implementation reference; see capability matrix for validation status)

**Last Updated:** 2026-08-30
**Scope:** `apps/web/lib/weletic/loyalty/earn.ts`, `apps/web/lib/weletic/loyalty/ledger.ts`, `apps/web/lib/weletic/loyalty/holding-period.ts`

---

## 1. Core Principles of Loyalty Points Accounting

In enterprise e-commerce, customer loyalty points can represent a financial liability. Incorrect rounding, lost concurrent updates, and untraceable manual changes make that liability difficult to reconcile.

The Weletic Loyalty Engine implements an **append-only signed-delta event ledger**. It is not double-entry bookkeeping because it does not maintain paired debit and credit accounts:

1. **Append-Only Event Ledger**: Domain mutations append a `WeleticPointsLedgerEntry`; cached account totals are projections of those events.
2. **Derived Cached Projections**: Account balances (`cachedPointsBalance`, `cachedPendingPoints`, `lifetimePointsEarned`, `lifetimePointsRedeemed`) are derived projections updated atomically under Optimistic Concurrency Control (`ledgerVersion`).
3. **Exact Rational Integer Arithmetic**: Currency amounts and point multipliers are computed using BigInt rational fractions `{ num: bigint, den: bigint }`, completely eliminating IEEE-754 floating-point drift.

---

## 2. BigInt Rational Fraction Arithmetic

JavaScript `Number` (IEEE-754 64-bit float) cannot accurately represent fractions like $0.1$ or $0.2$, causing cumulative balance errors in high-volume transaction environments.

Weletic implements exact rational fraction arithmetic:

```typescript
// apps/web/lib/weletic/loyalty/earn.ts
export interface RationalFraction {
  num: bigint;
  den: bigint;
}

export function parseDecimalToFraction(
  value: string | number | bigint | Prisma.Decimal | null | undefined,
): RationalFraction {
  if (value == null) return { num: BigInt(1), den: BigInt(1) };
  if (typeof value === "bigint") return { num: value, den: BigInt(1) };
  const str =
    typeof value === "object" && "toFixed" in value
      ? (value as Prisma.Decimal).toFixed()
      : String(value).trim();
  const negative = str.startsWith("-");
  const unsigned = negative ? str.slice(1) : str;
  const [whole, fraction = ""] = unsigned.split(".");
  const den = powerOfTenBigInt(fraction.length);
  const num = BigInt(`${whole}${fraction}`);
  return { num: negative ? -num : num, den };
}
```

### Multiplier Multiplication

When multiple rates compound ($\text{Base Rate} \times \text{Rule Multiplier} \times \text{Campaign Multiplier} \times \text{VIP Tier Multiplier}$):
$$\text{Combined Fraction} = \left(\frac{N_1}{D_1}\right) \times \left(\frac{N_2}{D_2}\right) \times \left(\frac{N_3}{D_3}\right) \times \left(\frac{N_4}{D_4}\right) = \frac{N_1 \cdot N_2 \cdot N_3 \cdot N_4}{D_1 \cdot D_2 \cdot D_3 \cdot D_4}$$

---

## 3. Zero-Decimal Currency Scaling

Currency minor units differ globally:

- **Two-Decimal Currencies** (USD, EUR, CAD, GBP, AUD): $1.00 = 100\text{ minor units (cents)}$. $\text{Scale} = 10^2 = 100$.
- **Zero-Decimal Currencies** (JPY, VND, KRW, CLP, PYG, RWF, UGX): $1\text{ unit} = 1\text{ minor unit}$. $\text{Scale} = 10^0 = 1$.

### Gross Points Formula

$$\text{Gross Points} = \left\lfloor \frac{\text{Eligible Net (Minor Units)} \times N_{\text{combined}}}{\text{Scale}(\text{Currency}) \times D_{\text{combined}}} \right\rfloor$$

_Example (JPY)_: Order of ¥10,000 with 1 pt/¥100 rate $\to \lfloor (10000 \times 1) / (1 \times 100) \rfloor = 100\text{ points}$. Zero-decimal scale prevents dividing by 100 twice.

---

## 4. Penny-Conserving Hare-Niemeyer Line Allocation

When allocating gross points across multiple order lines, standard proportional rounding can produce penny drift ($\sum \text{allocated} \neq \text{grossPoints}$). Weletic employs the **Hare-Niemeyer (Largest Remainder) algorithm**:

1. **Integer Base Allocation**: For each eligible line $i$:
   $$\text{Base}_i = \left\lfloor \frac{\text{grossPoints} \times \text{netAmount}_i}{\text{totalEligibleNet}} \right\rfloor$$
   $$\text{Remainder}_i = (\text{grossPoints} \times \text{netAmount}_i) \pmod{\text{totalEligibleNet}}$$
2. **Leftover Distribution**: Compute leftover points $L = \text{grossPoints} - \sum \text{Base}_i$. Sort lines descending by $\text{Remainder}_i$ (with deterministic `orderLineId` tie-breaker) and award $+1\text{ point}$ to the top $L$ lines.
3. **Mathematical Guarantee**: $\sum_{i=1}^{K} \text{awardedPoints}_i \equiv \text{grossPoints}$.

---

## 5. Dual-Bucket Holding Period Lifecycle

```
Order Paid (Holding Period > 0)
    │
    ▼
[WeleticLoyaltyEarnGrant (status: pending, grossPoints: 500, pendingPoints: 500)]
[WeleticLoyaltyAccount: cachedPendingPoints += 500, cachedPointsBalance: unchanged]
[WeleticLoyaltyOutboxJob: HOLDING_PERIOD_RELEASE scheduled at availableAt]
    │
    ├── (Scenario A: Holding Period Elapses) ──────────────────────────┐
    │   ▼                                                            │
    │   Outbox Worker executes handleHoldingPeriodRelease()           │
    │   [WeleticPointsLedgerEntry (EARN_ORDER, pointsDelta: +500)]   │
    │   [Account: cachedPendingPoints -= 500, cachedPointsBalance += 500]
    │                                                                │
    └── (Scenario B: Order Refunded Before Maturity) ─────────────────┘
        ▼
        Dual-Bucket Refund Handler: Void Pending First!
        [Grant: pendingPoints -= 500, reversedPoints += 500, status: voided]
        [Account: cachedPendingPoints -= 500]
        (Zero ledger debit required; available balance untouched)
```

---

## 6. Exact Source-Based Proportional Refunds & Negative Balance Debt

When an order refund occurs:

1. Lookup original `WeleticLoyaltyEarnGrant` and `WeleticLoyaltyOrderLineEarn` records.
2. For each refunded line $k$ with refund amount $R_k$:
   $$\text{Line Clawback}_k = \min\left(\text{round}\left(\frac{R_k \times \text{Awarded}_k}{\text{Line Net}_k}\right), \; \text{Awarded}_k - \text{Reversed}_k\right)$$
3. **Dual-Bucket Priority**:
   - $\text{Void Pending} = \min(\text{Total Clawback}, \; \text{Grant.pendingPoints})$
   - $\text{Debit Settled} = \text{Total Clawback} - \text{Void Pending}$
4. **Negative Balance Tolerance (ADR 0004)**:
   - If points were already redeemed, $\text{Debit Settled}$ is deducted from `cachedPointsBalance` via `REFUND_REVERSAL` ledger entry.
   - The ledger **never caps at zero** or discards valid reversals. The account enters negative balance (`cachedPointsBalance < 0`), representing points debt amortized automatically by future purchases.

---

## 7. Optimistic Concurrency Control (OCC) & Audit Reconciliation

- `WeleticLoyaltyAccount.ledgerVersion` tracks the atomic sequence number.
- `appendPointsLedgerEntry()` executes within a transaction with OCC version check:
  ```typescript
  const updateResult = await client.weleticLoyaltyAccount.updateMany({
    where: { id: accountId, ledgerVersion: currentVersion },
    data: updateData,
  });
  if (updateResult.count === 0) {
    throw new OptimisticConcurrencyError(
      `OCC version conflict at ${currentVersion}`,
    );
  }
  ```
- If conflict occurs, worker applies exponential backoff with decorrelated jitter ($25\text{ms} \times 2^{\text{attempt}} + \text{jitter}$) up to 10 retries.
- `reconcileAccountPoints(accountId)` audits one account sequentially:
  - Verifies $e_i.\text{sequenceNumber} == i + 1$ (zero sequence gaps).
  - Asserts $\sum \text{pointsDelta} == \text{cachedPointsBalance}$.
  - Repairs cached available/lifetime totals if desynchronized. Pending balance reconciliation is grant-driven and is not handled by this function.
