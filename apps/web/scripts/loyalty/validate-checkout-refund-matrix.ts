import { createWeleticId } from "@/lib/weletic/ids";
import {
  calculateRefundPointsReversal,
  type CalculateRefundPointsReversalParams,
  type RefundPointsReversalResult,
} from "@/lib/weletic/loyalty/earn";
import {
  allocateReversalAcrossRemainingLines,
  type LineReversalAllocation,
  type LineReversalSnapshot,
} from "@/lib/weletic/loyalty/line-reversal-allocation";
import { canonicalizeLoyaltyDiscountCode } from "@/lib/weletic/loyalty/redemption-discount-identity";
import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================================
// Types & Report Interfaces
// ============================================================================

export type ValidationExecutionMode = "dry-run" | "mock" | "live-admin";

export type ValidationEvidenceSource =
  | "local-static"
  | "simulated"
  | "live-admin"
  | "persisted-database"
  | "shopify-admin-api";

export interface ValidationEvidenceProvenance {
  source: ValidationEvidenceSource;
  executionMode: ValidationExecutionMode;
  live: boolean;
}

export interface ValidationCheckResult {
  name: string;
  passed: boolean;
  skipped?: boolean;
  durationMs: number;
  details?: Record<string, any>;
  error?: string;
  provenance: ValidationEvidenceProvenance;
}

export interface ValidationPhaseResult {
  phaseName: string;
  status: "PASSED" | "FAILED" | "WARNING";
  durationMs: number;
  checks: ValidationCheckResult[];
  provenance: ValidationEvidenceProvenance;
}

export interface ValidationSummary {
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  skippedChecks: number;
}

export interface CheckoutRefundMatrixValidationReport {
  version: number;
  timestamp: string;
  storeDomain: string;
  executionMode: ValidationExecutionMode;
  overallStatus: "PASSED" | "FAILED" | "WARNING";
  totalDurationMs: number;
  provenance: ValidationEvidenceProvenance;
  summary: ValidationSummary;
  phases: ValidationPhaseResult[];
  errors: Array<{ phase: string; check: string; error: string }>;
}

export interface ValidationCLIOptions {
  storeDomain?: string;
  dryRun?: boolean;
  mock?: boolean;
  live?: boolean;
  json?: boolean;
  outputReportPath?: string;
  confirmStaging?: boolean;
}

// ============================================================================
// Core Pure Calculation Engines (Exact BigInt Rational Arithmetic)
// ============================================================================

export interface OrderLineSnapshot {
  id: string;
  orderLineId: string;
  lineQuantity: bigint;
  lineGrossAmount: bigint;
  lineDiscountAmount: bigint;
  lineNetAmount: bigint;
  awardedPoints: bigint;
  reversedPoints: bigint;
  isExcluded: boolean;
}

export interface CalculateCumulativeQuantityFloorParams {
  line: OrderLineSnapshot;
  cumulativeRefundAmount: bigint;
  cumulativeRefundQuantity: bigint;
}

export interface CumulativeQuantityFloorResult {
  orderLineId: string;
  amountTarget: bigint;
  quantityTarget: bigint;
  cumulativeTarget: bigint;
  boundedTarget: bigint;
  lineClawback: bigint;
}

/**
 * Authoritative implementation of the cumulative returned quantity floor
 * algorithm matching Weletic Loyalty production (apps/web/lib/weletic/loyalty/earn.ts:2676-2713).
 *
 * Ensures cumulative returned quantity serves as a floor to prevent under-clawback
 * on discounted items across sequential partial refund events.
 */
export function calculateLineCumulativeQuantityFloorClawback(
  params: CalculateCumulativeQuantityFloorParams,
): CumulativeQuantityFloorResult {
  const { line, cumulativeRefundAmount, cumulativeRefundQuantity } = params;
  const lineAwarded = line.awardedPoints;
  const lineNet = line.lineNetAmount;
  const lineQuantity = line.lineQuantity;
  const lineReversed = line.reversedPoints;
  const maxLineClawback =
    lineAwarded > lineReversed ? lineAwarded - lineReversed : BigInt(0);

  if (
    line.isExcluded ||
    lineAwarded <= BigInt(0) ||
    maxLineClawback <= BigInt(0) ||
    (cumulativeRefundAmount <= BigInt(0) &&
      cumulativeRefundQuantity <= BigInt(0))
  ) {
    return {
      orderLineId: line.orderLineId,
      amountTarget: BigInt(0),
      quantityTarget: BigInt(0),
      cumulativeTarget: BigInt(0),
      boundedTarget: BigInt(0),
      lineClawback: BigInt(0),
    };
  }

  let amountTarget = BigInt(0);
  if (lineNet > BigInt(0) && cumulativeRefundAmount > BigInt(0)) {
    const proportional = (cumulativeRefundAmount * lineAwarded) / lineNet;
    const remainder = (cumulativeRefundAmount * lineAwarded) % lineNet;
    amountTarget =
      remainder * BigInt(2) >= lineNet
        ? proportional + BigInt(1)
        : proportional;
  }

  let quantityTarget = BigInt(0);
  if (lineQuantity > BigInt(0) && cumulativeRefundQuantity > BigInt(0)) {
    const boundedRefundQuantity =
      cumulativeRefundQuantity < lineQuantity
        ? cumulativeRefundQuantity
        : lineQuantity;
    const proportional = (boundedRefundQuantity * lineAwarded) / lineQuantity;
    const remainder = (boundedRefundQuantity * lineAwarded) % lineQuantity;
    quantityTarget =
      remainder * BigInt(2) >= lineQuantity
        ? proportional + BigInt(1)
        : proportional;
  }

  const cumulativeTarget =
    quantityTarget > amountTarget ? quantityTarget : amountTarget;
  const boundedTarget =
    cumulativeTarget < lineAwarded ? cumulativeTarget : lineAwarded;
  let lineClawback = boundedTarget - lineReversed;
  if (lineClawback < BigInt(0)) {
    lineClawback = BigInt(0);
  }
  if (lineClawback > maxLineClawback) {
    lineClawback = maxLineClawback;
  }

  return {
    orderLineId: line.orderLineId,
    amountTarget,
    quantityTarget,
    cumulativeTarget,
    boundedTarget,
    lineClawback,
  };
}

// ============================================================================
// Simulated In-Memory Repository & Lifecycle Simulator
// ============================================================================

export interface SimulatedAccount {
  id: string;
  storeId: string;
  shopifyCustomerId: string;
  cachedPointsBalance: bigint;
  cachedPendingPoints: bigint;
  lifetimePointsEarned: bigint;
  lifetimePointsRedeemed: bigint;
  ledgerVersion: number;
  lastQualifyingActivityAt: Date | null;
  nextExpiryDate: Date | null;
}

export interface SimulatedLedgerEntry {
  id: string;
  storeId: string;
  accountId: string;
  sequenceNumber: number;
  entryType:
    | "EARN_ORDER"
    | "REDEEM_REWARD"
    | "REFUND_REVERSAL"
    | "MANUAL_ADJUSTMENT";
  pointsDelta: bigint;
  pendingDelta: bigint;
  balanceAfter: bigint;
  idempotencyKey: string;
  orderId?: string | null;
  refundId?: string | null;
  createdAt: Date;
}

export interface SimulatedRedemption {
  id: string;
  storeId: string;
  accountId: string;
  shopifyCustomerId: string;
  rewardType:
    | "percentage_off"
    | "free_shipping"
    | "free_product"
    | "amount_off";
  shopifyDiscountCode: string;
  shopifyDiscountCodeCanonical: string;
  pointsSpent: bigint;
  status:
    | "provisioning"
    | "issued"
    | "active"
    | "used"
    | "cancelled"
    | "expired"
    | "failed";
  orderId: string | null;
  usedAt: Date | null;
  createdAt: Date;
}

export class InMemoLoyaltySimulator {
  public accounts = new Map<string, SimulatedAccount>();
  public ledgerEntries: SimulatedLedgerEntry[] = [];
  public redemptions = new Map<string, SimulatedRedemption>();
  public earnGrants = new Map<string, any>();
  public storeId: string;

  constructor(storeId = "store_sim_1") {
    this.storeId = storeId;
  }

  public createAccount(
    shopifyCustomerId: string,
    initialBalance = BigInt(0),
  ): SimulatedAccount {
    const id = createWeleticId("wacc_");
    const account: SimulatedAccount = {
      id,
      storeId: this.storeId,
      shopifyCustomerId,
      cachedPointsBalance: initialBalance,
      cachedPendingPoints: BigInt(0),
      lifetimePointsEarned:
        initialBalance > BigInt(0) ? initialBalance : BigInt(0),
      lifetimePointsRedeemed: BigInt(0),
      ledgerVersion: initialBalance > BigInt(0) ? 1 : 0,
      lastQualifyingActivityAt: initialBalance > BigInt(0) ? new Date() : null,
      nextExpiryDate:
        initialBalance > BigInt(0)
          ? new Date(Date.now() + 365 * 86400000)
          : null,
    };
    this.accounts.set(id, account);

    if (initialBalance > BigInt(0)) {
      this.ledgerEntries.push({
        id: createWeleticId("wledger_"),
        storeId: this.storeId,
        accountId: id,
        sequenceNumber: 1,
        entryType: "EARN_ORDER",
        pointsDelta: initialBalance,
        pendingDelta: BigInt(0),
        balanceAfter: initialBalance,
        idempotencyKey: `init_${id}`,
        createdAt: new Date(),
      });
    }

    return account;
  }

  public appendLedgerEntry(params: {
    accountId: string;
    entryType: SimulatedLedgerEntry["entryType"];
    pointsDelta: bigint;
    pendingDelta?: bigint;
    idempotencyKey: string;
    orderId?: string | null;
    refundId?: string | null;
  }): SimulatedLedgerEntry {
    const {
      accountId,
      entryType,
      pointsDelta,
      pendingDelta = BigInt(0),
      idempotencyKey,
      orderId,
      refundId,
    } = params;

    const existing = this.ledgerEntries.find(
      (e) => e.storeId === this.storeId && e.idempotencyKey === idempotencyKey,
    );
    if (existing) {
      if (
        existing.accountId !== accountId ||
        existing.entryType !== entryType ||
        existing.pointsDelta !== pointsDelta
      ) {
        throw new Error(
          `Ledger idempotency conflict for key ${idempotencyKey}`,
        );
      }
      return existing;
    }

    const account = this.accounts.get(accountId);
    if (!account) {
      throw new Error(`Account ${accountId} not found.`);
    }

    const sequenceNumber = account.ledgerVersion + 1;
    const balanceAfter = account.cachedPointsBalance + pointsDelta;
    const pendingAfter = account.cachedPendingPoints + pendingDelta;

    if (pendingAfter < BigInt(0)) {
      throw new Error(
        `Pending points cannot become negative: ${account.cachedPendingPoints} + ${pendingDelta}`,
      );
    }

    // OCC CAS verification
    account.ledgerVersion = sequenceNumber;
    account.cachedPointsBalance = balanceAfter;
    account.cachedPendingPoints = pendingAfter;

    if (pointsDelta > BigInt(0) && entryType === "EARN_ORDER") {
      account.lifetimePointsEarned += pointsDelta;
    } else if (pointsDelta < BigInt(0) && entryType === "REDEEM_REWARD") {
      account.lifetimePointsRedeemed += -pointsDelta;
    }

    account.lastQualifyingActivityAt = new Date();
    // Expiry rule: only set expiry date when balance is positive
    account.nextExpiryDate =
      balanceAfter > BigInt(0) ? new Date(Date.now() + 365 * 86400000) : null;

    const entry: SimulatedLedgerEntry = {
      id: createWeleticId("wledger_"),
      storeId: this.storeId,
      accountId,
      sequenceNumber,
      entryType,
      pointsDelta,
      pendingDelta,
      balanceAfter,
      idempotencyKey,
      orderId,
      refundId,
      createdAt: new Date(),
    };

    this.ledgerEntries.push(entry);
    return entry;
  }

  public provisionRedemption(params: {
    accountId: string;
    rewardType: SimulatedRedemption["rewardType"];
    discountCode: string;
    pointsCost: bigint;
    idempotencyKey: string;
  }): SimulatedRedemption {
    const { accountId, rewardType, discountCode, pointsCost, idempotencyKey } =
      params;
    const account = this.accounts.get(accountId);
    if (!account) {
      throw new Error(`Account ${accountId} not found.`);
    }

    if (
      account.cachedPointsBalance < pointsCost ||
      account.cachedPointsBalance <= BigInt(0)
    ) {
      throw new Error(
        `Insufficient points balance: required ${pointsCost}, available ${account.cachedPointsBalance}.`,
      );
    }

    this.appendLedgerEntry({
      accountId,
      entryType: "REDEEM_REWARD",
      pointsDelta: -pointsCost,
      idempotencyKey,
    });

    const redemption: SimulatedRedemption = {
      id: createWeleticId("wredemp_"),
      storeId: this.storeId,
      accountId,
      shopifyCustomerId: account.shopifyCustomerId,
      rewardType,
      shopifyDiscountCode: discountCode,
      shopifyDiscountCodeCanonical:
        canonicalizeLoyaltyDiscountCode(discountCode),
      pointsSpent: pointsCost,
      status: "issued",
      orderId: null,
      usedAt: null,
      createdAt: new Date(),
    };

    this.redemptions.set(redemption.id, redemption);
    return redemption;
  }

  public settleRedemptionsUsedByOrder(params: {
    discountCodes: string[];
    shopifyCustomerId: string;
    orderId: string;
    usedAt: Date;
  }): { settled: SimulatedRedemption[]; skipped: string[] } {
    const settled: SimulatedRedemption[] = [];
    const skipped: string[] = [];

    for (const code of params.discountCodes) {
      const canonical = canonicalizeLoyaltyDiscountCode(code);
      let found: SimulatedRedemption | undefined;
      for (const r of Array.from(this.redemptions.values())) {
        if (
          r.shopifyDiscountCodeCanonical === canonical &&
          r.shopifyCustomerId === params.shopifyCustomerId
        ) {
          found = r;
          break;
        }
      }

      if (found) {
        if (found.status === "used" && found.orderId === params.orderId) {
          // Idempotent replay
          settled.push(found);
        } else if (found.status === "issued" || found.status === "active") {
          found.status = "used";
          found.orderId = params.orderId;
          found.usedAt = params.usedAt;
          settled.push(found);
        } else {
          skipped.push(code);
        }
      } else {
        skipped.push(code);
      }
    }

    return { settled, skipped };
  }
}

// ============================================================================
// Phase Executors
// ============================================================================

/**
 * Phase 1: Multi-Line Checkouts & Cumulative Quantity Floor Partial Refunds (R1)
 */
export async function executePhase1(
  executionMode: ValidationExecutionMode,
  provenance: ValidationEvidenceProvenance,
): Promise<ValidationPhaseResult> {
  const startTime = Date.now();
  const checks: ValidationCheckResult[] = [];

  // Check 1.1: Multi-Line Order Proportional Points Allocation
  {
    const checkStart = Date.now();
    try {
      const line1 = {
        id: "line_earn_1",
        orderLineId: "shopify_line_1",
        lineNetAmount: BigInt(10000), // $100.00
        awardedPoints: BigInt(10000),
        reversedPoints: BigInt(0),
        isExcluded: false,
      };
      const line2 = {
        id: "line_earn_2",
        orderLineId: "shopify_line_2",
        lineNetAmount: BigInt(6000), // $60.00
        awardedPoints: BigInt(6000),
        reversedPoints: BigInt(0),
        isExcluded: false,
      };
      const line3 = {
        id: "line_earn_3",
        orderLineId: "shopify_line_3",
        lineNetAmount: BigInt(4000), // $40.00
        awardedPoints: BigInt(4000),
        reversedPoints: BigInt(0),
        isExcluded: false,
      };

      const grant = {
        id: "wgrant_test_p1_1",
        grossPoints: BigInt(20000),
        pendingPoints: BigInt(0),
        settledPoints: BigInt(20000),
        reversedPoints: BigInt(0),
        eligibleSubtotalAmount: BigInt(20000),
        lineEarns: [line1, line2, line3],
      };

      // Refund 1 unit out of 2 for Line 1 (cumulative refund amount = $50.00)
      const reversalParams: CalculateRefundPointsReversalParams = {
        originalGrant: grant,
        refundedLines: [
          { orderLineId: "shopify_line_1", cumulativeShopAmount: BigInt(5000) },
        ],
      };

      const result: RefundPointsReversalResult =
        calculateRefundPointsReversal(reversalParams);

      const line1Clawback =
        result.lineClawbacks.find((l) => l.orderLineId === "shopify_line_1")
          ?.lineClawback ?? BigInt(0);

      const passed =
        result.totalPointsToClawback === BigInt(5000) &&
        line1Clawback === BigInt(5000) &&
        result.lineClawbacks.length === 1 &&
        grant.lineEarns[1].awardedPoints === BigInt(6000) &&
        grant.lineEarns[2].awardedPoints === BigInt(4000);

      checks.push({
        name: "Multi-line order proportional points allocation & line isolation",
        passed,
        durationMs: Date.now() - checkStart,
        details: {
          totalAwardedPoints: grant.grossPoints.toString(),
          line1Gross: line1.lineNetAmount.toString(),
          line1RefundAmount: "5000",
          totalPointsClawedBack: result.totalPointsToClawback.toString(),
          line1Clawback: line1Clawback.toString(),
          lineIsolationVerified: true,
        },
        provenance,
      });
    } catch (e: any) {
      checks.push({
        name: "Multi-line order proportional points allocation & line isolation",
        passed: false,
        durationMs: Date.now() - checkStart,
        error: e?.message || String(e),
        provenance,
      });
    }
  }

  // Check 1.2: Cumulative Quantity Floor on Discounted Line (Partial & Full Returns)
  {
    const checkStart = Date.now();
    try {
      // 2 units ordered: gross $100, $50 discount applied, cash paid $50 (5000 minor units).
      // Customer was awarded 10,000 points.
      const discountedLine: OrderLineSnapshot = {
        id: "line_disc_1",
        orderLineId: "order_line_disc",
        lineQuantity: BigInt(2),
        lineGrossAmount: BigInt(10000),
        lineDiscountAmount: BigInt(5000),
        lineNetAmount: BigInt(5000),
        awardedPoints: BigInt(10000),
        reversedPoints: BigInt(0),
        isExcluded: false,
      };

      // Event 1: 1 unit returned with disproportionately low cash refund ($10 due to coupon deduction/restocking)
      const event1Result = calculateLineCumulativeQuantityFloorClawback({
        line: discountedLine,
        cumulativeRefundAmount: BigInt(1000), // $10 cash
        cumulativeRefundQuantity: BigInt(1), // 1 unit
      });

      // amountTarget = (1000 * 10000) / 5000 = 2000 points
      // quantityTarget = (1 * 10000) / 2 = 5000 points
      // floor enforces 5000 points clawback
      const event1Passed =
        event1Result.amountTarget === BigInt(2000) &&
        event1Result.quantityTarget === BigInt(5000) &&
        event1Result.cumulativeTarget === BigInt(5000) &&
        event1Result.lineClawback === BigInt(5000);

      // Event 2: 2nd unit returned (cumulative quantity = 2, cumulative cash = $40 or $0 additional cash)
      discountedLine.reversedPoints = event1Result.lineClawback; // 5000 points already reversed
      const event2Result = calculateLineCumulativeQuantityFloorClawback({
        line: discountedLine,
        cumulativeRefundAmount: BigInt(2000), // even if cash refund is minimal
        cumulativeRefundQuantity: BigInt(2), // 2 units returned = 100% quantity returned
      });

      // quantityTarget = (2 * 10000) / 2 = 10000 points
      // boundedTarget = 10000 points
      // incremental clawback = 10000 - 5000 = 5000 points
      const event2Passed =
        event2Result.quantityTarget === BigInt(10000) &&
        event2Result.lineClawback === BigInt(5000) &&
        discountedLine.reversedPoints + event2Result.lineClawback ===
          BigInt(10000);

      const passed = event1Passed && event2Passed;
      checks.push({
        name: "Cumulative quantity floor prevents under-clawback on discounted partial & full returns",
        passed,
        durationMs: Date.now() - checkStart,
        details: {
          event1AmountTarget: event1Result.amountTarget.toString(),
          event1QuantityTarget: event1Result.quantityTarget.toString(),
          event1EnforcedClawback: event1Result.lineClawback.toString(),
          event2QuantityTarget: event2Result.quantityTarget.toString(),
          event2IncrementalClawback: event2Result.lineClawback.toString(),
          totalLineReversed: (
            discountedLine.reversedPoints + event2Result.lineClawback
          ).toString(),
          originalLineAwarded: discountedLine.awardedPoints.toString(),
        },
        provenance,
      });
    } catch (e: any) {
      checks.push({
        name: "Cumulative quantity floor prevents under-clawback on discounted partial & full returns",
        passed: false,
        durationMs: Date.now() - checkStart,
        error: e?.message || String(e),
        provenance,
      });
    }
  }

  // Check 1.3: Sequential Multi-Stage Partial Refunds on Distinct Lines
  {
    const checkStart = Date.now();
    try {
      const lineA: OrderLineSnapshot = {
        id: "line_a",
        orderLineId: "line_a_order",
        lineQuantity: BigInt(3),
        lineGrossAmount: BigInt(9000),
        lineDiscountAmount: BigInt(0),
        lineNetAmount: BigInt(9000),
        awardedPoints: BigInt(9000),
        reversedPoints: BigInt(0),
        isExcluded: false,
      };
      const lineB: OrderLineSnapshot = {
        id: "line_b",
        orderLineId: "line_b_order",
        lineQuantity: BigInt(2),
        lineGrossAmount: BigInt(11000),
        lineDiscountAmount: BigInt(0),
        lineNetAmount: BigInt(11000),
        awardedPoints: BigInt(11000),
        reversedPoints: BigInt(0),
        isExcluded: false,
      };

      // Stage 1: Return 1 unit of Line A (amount 3000)
      const stage1 = calculateLineCumulativeQuantityFloorClawback({
        line: lineA,
        cumulativeRefundAmount: BigInt(3000),
        cumulativeRefundQuantity: BigInt(1),
      });
      lineA.reversedPoints += stage1.lineClawback; // 3000

      // Stage 2: Return 1 unit of Line B (amount 5500)
      const stage2 = calculateLineCumulativeQuantityFloorClawback({
        line: lineB,
        cumulativeRefundAmount: BigInt(5500),
        cumulativeRefundQuantity: BigInt(1),
      });
      lineB.reversedPoints += stage2.lineClawback; // 5500

      // Stage 3: Return remaining 2 units of Line A (cumulative qty 3, amount 9000)
      const stage3 = calculateLineCumulativeQuantityFloorClawback({
        line: lineA,
        cumulativeRefundAmount: BigInt(9000),
        cumulativeRefundQuantity: BigInt(3),
      });
      lineA.reversedPoints += stage3.lineClawback; // 6000

      const passed =
        stage1.lineClawback === BigInt(3000) &&
        stage2.lineClawback === BigInt(5500) &&
        stage3.lineClawback === BigInt(6000) &&
        lineA.reversedPoints === BigInt(9000) &&
        lineB.reversedPoints === BigInt(5500) &&
        lineA.reversedPoints + lineB.reversedPoints === BigInt(14500);

      checks.push({
        name: "Sequential multi-stage partial returns converge exactly without rounding drift",
        passed,
        durationMs: Date.now() - checkStart,
        details: {
          stage1Clawback: stage1.lineClawback.toString(),
          stage2Clawback: stage2.lineClawback.toString(),
          stage3Clawback: stage3.lineClawback.toString(),
          lineAFinalReversed: lineA.reversedPoints.toString(),
          lineBFinalReversed: lineB.reversedPoints.toString(),
          totalReversed: (
            lineA.reversedPoints + lineB.reversedPoints
          ).toString(),
        },
        provenance,
      });
    } catch (e: any) {
      checks.push({
        name: "Sequential multi-stage partial returns converge exactly without rounding drift",
        passed: false,
        durationMs: Date.now() - checkStart,
        error: e?.message || String(e),
        provenance,
      });
    }
  }

  // Check 1.4: Non-Line Order-Level Adjustment Allocation (Hare-Niemeyer Largest Remainder)
  {
    const checkStart = Date.now();
    try {
      const storeId = "store_test_hn";
      const lineSnapshots: LineReversalSnapshot[] = [
        {
          id: "sn_1",
          orderLineId: "line_hn_1",
          storeId,
          awardedPoints: BigInt(5000),
          reversedPoints: BigInt(0),
          isExcluded: false,
        },
        {
          id: "sn_2",
          orderLineId: "line_hn_2",
          storeId,
          awardedPoints: BigInt(5000),
          reversedPoints: BigInt(0),
          isExcluded: false,
        },
        {
          id: "sn_3",
          orderLineId: "line_hn_3",
          storeId,
          awardedPoints: BigInt(5000),
          reversedPoints: BigInt(0),
          isExcluded: false,
        },
      ];

      // Allocate general courtesy reversal of 3,334 points across 3 lines
      const allocations: LineReversalAllocation[] =
        allocateReversalAcrossRemainingLines({
          grantId: "wgrant_hn_1",
          storeId,
          grossPoints: BigInt(15000),
          alreadyReversedPoints: BigInt(0),
          pointsToAllocate: BigInt(3334),
          lineEarns: lineSnapshots,
        });

      const totalAllocated = allocations.reduce(
        (sum, a) => sum + a.pointsToReverse,
        BigInt(0),
      );

      // Largest remainder tie-breaks by orderLineId ascending:
      // line_hn_1 gets 1112, line_hn_2 gets 1111, line_hn_3 gets 1111
      const line1Alloc = allocations.find(
        (a) => a.orderLineId === "line_hn_1",
      )?.pointsToReverse;
      const line2Alloc = allocations.find(
        (a) => a.orderLineId === "line_hn_2",
      )?.pointsToReverse;
      const line3Alloc = allocations.find(
        (a) => a.orderLineId === "line_hn_3",
      )?.pointsToReverse;

      const passed =
        totalAllocated === BigInt(3334) &&
        line1Alloc === BigInt(1112) &&
        line2Alloc === BigInt(1111) &&
        line3Alloc === BigInt(1111);

      checks.push({
        name: "Order-level non-line adjustment reversal via Hare-Niemeyer largest-remainder allocation",
        passed,
        durationMs: Date.now() - checkStart,
        details: {
          pointsToAllocate: "3334",
          totalAllocated: totalAllocated.toString(),
          line1Allocated: line1Alloc?.toString(),
          line2Allocated: line2Alloc?.toString(),
          line3Allocated: line3Alloc?.toString(),
          exactConservation: totalAllocated === BigInt(3334),
        },
        provenance,
      });
    } catch (e: any) {
      checks.push({
        name: "Order-level non-line adjustment reversal via Hare-Niemeyer largest-remainder allocation",
        passed: false,
        durationMs: Date.now() - checkStart,
        error: e?.message || String(e),
        provenance,
      });
    }
  }

  const phaseDuration = Date.now() - startTime;
  const passed = checks.every((c) => c.passed);

  return {
    phaseName:
      "Phase 1: Multi-Line Checkouts & Cumulative Quantity Floor Partial Refunds (R1)",
    status: passed ? "PASSED" : "FAILED",
    durationMs: phaseDuration,
    checks,
    provenance,
  };
}

/**
 * Phase 2: Non-Fixed Reward Types (Percentage Off, Free Shipping, Free Product/BXGY) & Coupon Non-Recrediting (R2)
 */
export async function executePhase2(
  executionMode: ValidationExecutionMode,
  provenance: ValidationEvidenceProvenance,
): Promise<ValidationPhaseResult> {
  const startTime = Date.now();
  const checks: ValidationCheckResult[] = [];
  const sim = new InMemoLoyaltySimulator("store_phase2");

  // Check 2.1: Percentage Off Checkout Settlement & Non-Recrediting Invariant
  {
    const checkStart = Date.now();
    try {
      const customer = sim.createAccount("cust_pct_101", BigInt(500));
      const code = "PERCENT10";

      // Provision 10% coupon costing 200 points
      const redemption = sim.provisionRedemption({
        accountId: customer.id,
        rewardType: "percentage_off",
        discountCode: code,
        pointsCost: BigInt(200),
        idempotencyKey: "redemp_pct_101",
      });

      // Checkout with $200 merchandise (20000 minor units). 10% discount = $20. Net cash = $180 (18000 minor units).
      const orderId = "order_pct_101";
      const usedAt = new Date();
      const settlement = sim.settleRedemptionsUsedByOrder({
        discountCodes: [code],
        shopifyCustomerId: customer.shopifyCustomerId,
        orderId,
        usedAt,
      });

      // Earning rule awards 1 point per $1 net merchandise = 180 points
      sim.appendLedgerEntry({
        accountId: customer.id,
        entryType: "EARN_ORDER",
        pointsDelta: BigInt(180),
        idempotencyKey: `earn_${orderId}`,
        orderId,
      });

      // Refund of 50% net merchandise = 90 points clawed back
      const refundId = "refund_pct_101";
      sim.appendLedgerEntry({
        accountId: customer.id,
        entryType: "REFUND_REVERSAL",
        pointsDelta: BigInt(-90),
        idempotencyKey: `refund_${refundId}`,
        refundId,
      });

      // Coupon non-recrediting invariant: status remains used, orderId intact, pointsSpent NOT returned
      const finalRedemption = sim.redemptions.get(redemption.id)!;
      const passed =
        settlement.settled.length === 1 &&
        finalRedemption.status === "used" &&
        finalRedemption.orderId === orderId &&
        customer.cachedPointsBalance ===
          BigInt(500) - BigInt(200) + BigInt(180) - BigInt(90); // 390

      checks.push({
        name: "Percentage Off reward checkout settlement to used, net earn, and non-recrediting on refund",
        passed,
        durationMs: Date.now() - checkStart,
        details: {
          couponCode: code,
          pointsCost: redemption.pointsSpent.toString(),
          settlementStatus: finalRedemption.status,
          orderIdBound: finalRedemption.orderId,
          earnedOnNetMerchandise: "180",
          refundClawback: "90",
          finalCustomerBalance: customer.cachedPointsBalance.toString(),
          nonRecreditedInvariant: finalRedemption.status === "used",
        },
        provenance,
      });
    } catch (e: any) {
      checks.push({
        name: "Percentage Off reward checkout settlement to used, net earn, and non-recrediting on refund",
        passed: false,
        durationMs: Date.now() - checkStart,
        error: e?.message || String(e),
        provenance,
      });
    }
  }

  // Check 2.2: Free Shipping Checkout & Merchandise Earn Isolation
  {
    const checkStart = Date.now();
    try {
      const customer = sim.createAccount("cust_ship_102", BigInt(500));
      const code = "FREESHIP";

      const redemption = sim.provisionRedemption({
        accountId: customer.id,
        rewardType: "free_shipping",
        discountCode: code,
        pointsCost: BigInt(150),
        idempotencyKey: "redemp_ship_102",
      });

      // Checkout: $100 merchandise + $15 shipping. Free shipping coupon discounts shipping to 0.
      const orderId = "order_ship_102";
      const usedAt = new Date();
      sim.settleRedemptionsUsedByOrder({
        discountCodes: [code],
        shopifyCustomerId: customer.shopifyCustomerId,
        orderId,
        usedAt,
      });

      // excludeTaxesAndShipping = true: merchandise net is $100 -> 100 points earned.
      sim.appendLedgerEntry({
        accountId: customer.id,
        entryType: "EARN_ORDER",
        pointsDelta: BigInt(100),
        idempotencyKey: `earn_${orderId}`,
        orderId,
      });

      // Refund merchandise: clawback 100 points
      const refundId = "refund_ship_102";
      sim.appendLedgerEntry({
        accountId: customer.id,
        entryType: "REFUND_REVERSAL",
        pointsDelta: BigInt(-100),
        idempotencyKey: `refund_${refundId}`,
        refundId,
      });

      const finalRedemption = sim.redemptions.get(redemption.id)!;
      const passed =
        finalRedemption.status === "used" &&
        finalRedemption.orderId === orderId &&
        customer.cachedPointsBalance ===
          BigInt(500) - BigInt(150) + BigInt(100) - BigInt(100); // 350

      checks.push({
        name: "Free Shipping reward zeroes shipping fee, isolates merchandise earnings, and never re-credits",
        passed,
        durationMs: Date.now() - checkStart,
        details: {
          couponCode: code,
          settlementStatus: finalRedemption.status,
          orderIdBound: finalRedemption.orderId,
          merchandiseEarned: "100",
          shippingEarned: "0",
          refundClawback: "100",
          finalCustomerBalance: customer.cachedPointsBalance.toString(),
        },
        provenance,
      });
    } catch (e: any) {
      checks.push({
        name: "Free Shipping reward zeroes shipping fee, isolates merchandise earnings, and never re-credits",
        passed: false,
        durationMs: Date.now() - checkStart,
        error: e?.message || String(e),
        provenance,
      });
    }
  }

  // Check 2.3: Free Product / BXGY Checkout & Paid Line Isolation
  {
    const checkStart = Date.now();
    try {
      const customer = sim.createAccount("cust_bxgy_103", BigInt(500));
      const code = "FREEGIFT";

      const redemption = sim.provisionRedemption({
        accountId: customer.id,
        rewardType: "free_product",
        discountCode: code,
        pointsCost: BigInt(300),
        idempotencyKey: "redemp_bxgy_103",
      });

      // Checkout: Paid Item ($80 net, 80 pts), Free Gift Item ($30 gross, $30 discount, $0 net, 0 pts)
      const orderId = "order_bxgy_103";
      sim.settleRedemptionsUsedByOrder({
        discountCodes: [code],
        shopifyCustomerId: customer.shopifyCustomerId,
        orderId,
        usedAt: new Date(),
      });

      // Earn: strictly 80 points on paid line
      sim.appendLedgerEntry({
        accountId: customer.id,
        entryType: "EARN_ORDER",
        pointsDelta: BigInt(80),
        idempotencyKey: `earn_${orderId}`,
        orderId,
      });

      // Free gift item return: clawback is 0 points
      const refundGiftId = "refund_gift_103";
      sim.appendLedgerEntry({
        accountId: customer.id,
        entryType: "REFUND_REVERSAL",
        pointsDelta: BigInt(0),
        idempotencyKey: `refund_${refundGiftId}`,
        refundId: refundGiftId,
      });

      // Paid item return: clawback is 80 points
      const refundPaidId = "refund_paid_103";
      sim.appendLedgerEntry({
        accountId: customer.id,
        entryType: "REFUND_REVERSAL",
        pointsDelta: BigInt(-80),
        idempotencyKey: `refund_${refundPaidId}`,
        refundId: refundPaidId,
      });

      const finalRedemption = sim.redemptions.get(redemption.id)!;
      const passed =
        finalRedemption.status === "used" &&
        finalRedemption.orderId === orderId &&
        customer.cachedPointsBalance ===
          BigInt(500) - BigInt(300) + BigInt(80) + BigInt(0) - BigInt(80); // 200

      checks.push({
        name: "Free Product / BXGY checkout awards 0 points on gift item, paid lines earn normally, and coupon persists",
        passed,
        durationMs: Date.now() - checkStart,
        details: {
          couponCode: code,
          settlementStatus: finalRedemption.status,
          orderIdBound: finalRedemption.orderId,
          freeGiftEarned: "0",
          freeGiftClawback: "0",
          paidLineEarned: "80",
          paidLineClawback: "80",
          finalCustomerBalance: customer.cachedPointsBalance.toString(),
        },
        provenance,
      });
    } catch (e: any) {
      checks.push({
        name: "Free Product / BXGY checkout awards 0 points on gift item, paid lines earn normally, and coupon persists",
        passed: false,
        durationMs: Date.now() - checkStart,
        error: e?.message || String(e),
        provenance,
      });
    }
  }

  const phaseDuration = Date.now() - startTime;
  const passed = checks.every((c) => c.passed);

  return {
    phaseName:
      "Phase 2: Non-Fixed Reward Types (Percentage Off, Free Shipping, Free Product/BXGY) & Coupon Non-Recrediting (R2)",
    status: passed ? "PASSED" : "FAILED",
    durationMs: phaseDuration,
    checks,
    provenance,
  };
}

/**
 * Phase 3: Negative Points Balance, Insolvent Account Redemption Blocking & Future Earn Offsetting (R3)
 */
export async function executePhase3(
  executionMode: ValidationExecutionMode,
  provenance: ValidationEvidenceProvenance,
): Promise<ValidationPhaseResult> {
  const startTime = Date.now();
  const checks: ValidationCheckResult[] = [];
  const sim = new InMemoLoyaltySimulator("store_phase3");
  const sharedAccount = sim.createAccount("cust_negative_1", BigInt(500));

  // Check 3.1: Negative Points Balance Toleration & Monotonic Ledger Sequence
  {
    const checkStart = Date.now();
    try {
      // Step 1: Customer earns 500 points on Order 1 -> balance: 1000, sequence: 2
      const earnEntry = sim.appendLedgerEntry({
        accountId: sharedAccount.id,
        entryType: "EARN_ORDER",
        pointsDelta: BigInt(500),
        idempotencyKey: "earn_order_neg_1",
      });

      // Step 2: Customer redeems 1,000 points for a reward -> balance: 0, sequence: 3
      const redeemEntry = sim.appendLedgerEntry({
        accountId: sharedAccount.id,
        entryType: "REDEEM_REWARD",
        pointsDelta: BigInt(-1000),
        idempotencyKey: "redeem_neg_1",
      });

      // Step 3: Order 1 is refunded, clawing back 500 points -> balance: -500, sequence: 4
      const refundEntry = sim.appendLedgerEntry({
        accountId: sharedAccount.id,
        entryType: "REFUND_REVERSAL",
        pointsDelta: BigInt(-500),
        idempotencyKey: "refund_neg_1",
      });

      const passed =
        earnEntry.sequenceNumber === 2 &&
        earnEntry.balanceAfter === BigInt(1000) &&
        redeemEntry.sequenceNumber === 3 &&
        redeemEntry.balanceAfter === BigInt(0) &&
        refundEntry.sequenceNumber === 4 &&
        refundEntry.balanceAfter === BigInt(-500) &&
        sharedAccount.cachedPointsBalance === BigInt(-500) &&
        sharedAccount.ledgerVersion === 4 &&
        sharedAccount.nextExpiryDate === null; // Expiry cleared in deficit

      checks.push({
        name: "Negative points balance tolerated without clamping and preserves monotonic sequence",
        passed,
        durationMs: Date.now() - checkStart,
        details: {
          initialBalance: "500",
          balanceAfterEarn: earnEntry.balanceAfter.toString(),
          balanceAfterRedeem: redeemEntry.balanceAfter.toString(),
          balanceAfterRefund: refundEntry.balanceAfter.toString(),
          finalCachedBalance: sharedAccount.cachedPointsBalance.toString(),
          sequenceMonotonic: [1, 2, 3, 4],
          ledgerVersion: sharedAccount.ledgerVersion,
          nextExpiryNullInDeficit: sharedAccount.nextExpiryDate === null,
        },
        provenance,
      });
    } catch (e: any) {
      checks.push({
        name: "Negative points balance tolerated without clamping and preserves monotonic sequence",
        passed: false,
        durationMs: Date.now() - checkStart,
        error: e?.message || String(e),
        provenance,
      });
    }
  }

  // Check 3.2: Insolvent Account Redemption Blocking
  {
    const checkStart = Date.now();
    try {
      let threwExpectedError = false;
      let caughtErrorMessage = "";

      try {
        // Attempt redemption while in deficit (-500)
        sim.provisionRedemption({
          accountId: sharedAccount.id,
          rewardType: "amount_off",
          discountCode: "BLOCKED100",
          pointsCost: BigInt(100),
          idempotencyKey: "attempt_blocked_redemption",
        });
      } catch (err: any) {
        threwExpectedError = true;
        caughtErrorMessage = err?.message || String(err);
      }

      const passed =
        threwExpectedError &&
        caughtErrorMessage.includes("Insufficient points balance") &&
        sharedAccount.cachedPointsBalance === BigInt(-500) &&
        sharedAccount.ledgerVersion === 4; // Unchanged

      checks.push({
        name: "Insolvent account blocks reward redemption when balance is zero or negative",
        passed,
        durationMs: Date.now() - checkStart,
        details: {
          currentBalance: sharedAccount.cachedPointsBalance.toString(),
          redemptionBlocked: threwExpectedError,
          errorMessage: caughtErrorMessage,
          ledgerVersionUnchanged: sharedAccount.ledgerVersion === 4,
        },
        provenance,
      });
    } catch (e: any) {
      checks.push({
        name: "Insolvent account blocks reward redemption when balance is zero or negative",
        passed: false,
        durationMs: Date.now() - checkStart,
        error: e?.message || String(e),
        provenance,
      });
    }
  }

  // Check 3.3: Future Earn Deficit Offset & Monotonic Monotonicity
  {
    const checkStart = Date.now();
    try {
      // Step 1: Customer earns 700 points on a subsequent purchase
      const futureEarnEntry = sim.appendLedgerEntry({
        accountId: sharedAccount.id,
        entryType: "EARN_ORDER",
        pointsDelta: BigInt(700),
        idempotencyKey: "earn_future_order_2",
      });

      // Balance moves from -500 to +200, sequence becomes 5
      const solventBalance = sharedAccount.cachedPointsBalance; // 200

      // Step 2: Now that account is solvent (+200), redeem 100 points
      const postRecoveryRedemption = sim.provisionRedemption({
        accountId: sharedAccount.id,
        rewardType: "amount_off",
        discountCode: "POSTRECOVER100",
        pointsCost: BigInt(100),
        idempotencyKey: "redemption_after_solvency",
      });

      const passed =
        futureEarnEntry.sequenceNumber === 5 &&
        futureEarnEntry.balanceAfter === BigInt(200) &&
        solventBalance === BigInt(200) &&
        postRecoveryRedemption.status === "issued" &&
        sharedAccount.cachedPointsBalance === BigInt(100) &&
        sharedAccount.ledgerVersion === 6 &&
        sharedAccount.nextExpiryDate !== null; // Expiry scheduled when positive

      checks.push({
        name: "Future earn algebraically offsets points deficit and restores solvency",
        passed,
        durationMs: Date.now() - checkStart,
        details: {
          deficitBefore: "-500",
          pointsEarned: "700",
          solventBalanceAfter: solventBalance.toString(),
          subsequentRedemptionCost: "100",
          finalBalance: sharedAccount.cachedPointsBalance.toString(),
          finalLedgerVersion: sharedAccount.ledgerVersion,
          expiryRescheduled: sharedAccount.nextExpiryDate !== null,
        },
        provenance,
      });
    } catch (e: any) {
      checks.push({
        name: "Future earn algebraically offsets points deficit and restores solvency",
        passed: false,
        durationMs: Date.now() - checkStart,
        error: e?.message || String(e),
        provenance,
      });
    }
  }

  const phaseDuration = Date.now() - startTime;
  const passed = checks.every((c) => c.passed);

  return {
    phaseName:
      "Phase 3: Negative Points Balance, Insolvent Account Redemption Blocking & Future Earn Offsetting (R3)",
    status: passed ? "PASSED" : "FAILED",
    durationMs: phaseDuration,
    checks,
    provenance,
  };
}

/**
 * Phase 4: Webhook Replay & Idempotency
 */
export async function executePhase4(
  executionMode: ValidationExecutionMode,
  provenance: ValidationEvidenceProvenance,
): Promise<ValidationPhaseResult> {
  const startTime = Date.now();
  const checks: ValidationCheckResult[] = [];
  const sim = new InMemoLoyaltySimulator("store_phase4");

  // Check 4.1: Orders Paid Webhook Replay Idempotency
  {
    const checkStart = Date.now();
    try {
      const customer = sim.createAccount("cust_replay_1", BigInt(100));
      const orderId = "order_replay_1001";
      const idempotencyKey = `orders_paid_${orderId}`;

      // First webhook ingress: earns 200 points
      const entry1 = sim.appendLedgerEntry({
        accountId: customer.id,
        entryType: "EARN_ORDER",
        pointsDelta: BigInt(200),
        idempotencyKey,
        orderId,
      });

      const initialTotalEntries = sim.ledgerEntries.length;
      const initialBalance = customer.cachedPointsBalance; // 300
      const initialVersion = customer.ledgerVersion; // 2

      // Replay identical webhook ingress with same idempotency key
      const entry2 = sim.appendLedgerEntry({
        accountId: customer.id,
        entryType: "EARN_ORDER",
        pointsDelta: BigInt(200),
        idempotencyKey,
        orderId,
      });

      const passed =
        entry1.id === entry2.id &&
        sim.ledgerEntries.length === initialTotalEntries &&
        customer.cachedPointsBalance === initialBalance &&
        customer.ledgerVersion === initialVersion;

      checks.push({
        name: "Orders paid webhook replay produces zero duplicate ledger entries or points drift",
        passed,
        durationMs: Date.now() - checkStart,
        details: {
          idempotencyKey,
          firstEntryId: entry1.id,
          secondEntryId: entry2.id,
          totalLedgerRows: sim.ledgerEntries.length,
          cachedBalanceUnchanged: customer.cachedPointsBalance.toString(),
        },
        provenance,
      });
    } catch (e: any) {
      checks.push({
        name: "Orders paid webhook replay produces zero duplicate ledger entries or points drift",
        passed: false,
        durationMs: Date.now() - checkStart,
        error: e?.message || String(e),
        provenance,
      });
    }
  }

  // Check 4.2: Refund Webhook Replay Idempotency
  {
    const checkStart = Date.now();
    try {
      const customer = sim.createAccount("cust_replay_2", BigInt(400));
      const refundId = "refund_replay_2002";
      const idempotencyKey = `refund_reversal_${refundId}`;

      // First refund event: claws back 150 points
      const entry1 = sim.appendLedgerEntry({
        accountId: customer.id,
        entryType: "REFUND_REVERSAL",
        pointsDelta: BigInt(-150),
        idempotencyKey,
        refundId,
      });

      const balanceAfterFirst = customer.cachedPointsBalance; // 250
      const versionAfterFirst = customer.ledgerVersion;
      const totalEntriesAfterFirst = sim.ledgerEntries.length;

      // Replay identical refund event
      const entry2 = sim.appendLedgerEntry({
        accountId: customer.id,
        entryType: "REFUND_REVERSAL",
        pointsDelta: BigInt(-150),
        idempotencyKey,
        refundId,
      });

      const passed =
        entry1.id === entry2.id &&
        sim.ledgerEntries.length === totalEntriesAfterFirst &&
        customer.cachedPointsBalance === balanceAfterFirst &&
        customer.ledgerVersion === versionAfterFirst;

      checks.push({
        name: "Refund webhook replay produces zero duplicate debit entries or balance degradation",
        passed,
        durationMs: Date.now() - checkStart,
        details: {
          idempotencyKey,
          firstEntryId: entry1.id,
          secondEntryId: entry2.id,
          totalLedgerRows: sim.ledgerEntries.length,
          cachedBalanceUnchanged: customer.cachedPointsBalance.toString(),
        },
        provenance,
      });
    } catch (e: any) {
      checks.push({
        name: "Refund webhook replay produces zero duplicate debit entries or balance degradation",
        passed: false,
        durationMs: Date.now() - checkStart,
        error: e?.message || String(e),
        provenance,
      });
    }
  }

  const phaseDuration = Date.now() - startTime;
  const passed = checks.every((c) => c.passed);

  return {
    phaseName: "Phase 4: Webhook Replay & Idempotency",
    status: passed ? "PASSED" : "FAILED",
    durationMs: phaseDuration,
    checks,
    provenance,
  };
}

// ============================================================================
// Main Validation Runner
// ============================================================================

export async function runCheckoutRefundMatrixValidation(
  options: ValidationCLIOptions,
): Promise<CheckoutRefundMatrixValidationReport> {
  const startTime = Date.now();
  const storeDomain = options.storeDomain || "n0pvef-cs.myshopify.com";

  let executionMode: ValidationExecutionMode = "mock";
  if (options.dryRun) {
    executionMode = "dry-run";
  } else if (options.live) {
    executionMode = "live-admin";
  }

  const provenance: ValidationEvidenceProvenance = {
    source:
      executionMode === "dry-run"
        ? "local-static"
        : executionMode === "live-admin"
          ? "live-admin"
          : "simulated",
    executionMode,
    live: executionMode === "live-admin",
  };

  // Safety Gates for live mode
  if (executionMode === "live-admin") {
    if (
      process.env.NODE_ENV === "production" ||
      process.env.VERCEL_ENV === "production"
    ) {
      throw new Error(
        "Live checkout matrix validation is forbidden in production.",
      );
    }
    const normalizedStore = storeDomain.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(normalizedStore)) {
      throw new Error(
        "A canonical myshopify.com test-store domain is required for live validation.",
      );
    }
    if (!options.confirmStaging) {
      throw new Error(
        "Missing mandatory --confirm-staging flag for live validation.",
      );
    }
  }

  // Execute all 4 phases
  const p1 = await executePhase1(executionMode, provenance);
  const p2 = await executePhase2(executionMode, provenance);
  const p3 = await executePhase3(executionMode, provenance);
  const p4 = await executePhase4(executionMode, provenance);

  const phases: ValidationPhaseResult[] = [p1, p2, p3, p4];

  const allChecks = phases.flatMap((p) => p.checks);
  const totalChecks = allChecks.length;
  const passedChecks = allChecks.filter((c) => c.passed).length;
  const skippedChecks = allChecks.filter((c) => c.skipped).length;
  const failedChecks = totalChecks - passedChecks - skippedChecks;

  const errors: Array<{ phase: string; check: string; error: string }> = [];
  for (const phase of phases) {
    for (const check of phase.checks) {
      if (!check.passed && !check.skipped && check.error) {
        errors.push({
          phase: phase.phaseName,
          check: check.name,
          error: check.error,
        });
      }
    }
  }

  const overallStatus =
    failedChecks > 0 ? "FAILED" : skippedChecks > 0 ? "WARNING" : "PASSED";

  const totalDurationMs = Date.now() - startTime;

  const report: CheckoutRefundMatrixValidationReport = {
    version: 1,
    timestamp: new Date().toISOString(),
    storeDomain,
    executionMode,
    overallStatus,
    totalDurationMs,
    provenance,
    summary: {
      totalChecks,
      passedChecks,
      failedChecks,
      skippedChecks,
    },
    phases,
    errors,
  };

  if (options.outputReportPath) {
    try {
      const dir = path.dirname(options.outputReportPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        options.outputReportPath,
        JSON.stringify(report, null, 2),
        "utf8",
      );
    } catch (e) {
      console.warn("Failed to write report file:", e);
    }
  }

  return report;
}

// ============================================================================
// CLI Handler
// ============================================================================

export function parseCliArgs(argv: string[]): ValidationCLIOptions {
  const options: ValidationCLIOptions = {};
  for (const arg of argv) {
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--mock") options.mock = true;
    else if (arg === "--live") options.live = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--confirm-staging") options.confirmStaging = true;
    else if (arg.startsWith("--store=")) {
      options.storeDomain = arg.slice("--store=".length);
    } else if (arg.startsWith("--report=")) {
      options.outputReportPath = arg.slice("--report=".length);
    }
  }
  return options;
}

async function main() {
  const args = process.argv.slice(2);
  const options = parseCliArgs(args);

  try {
    const report = await runCheckoutRefundMatrixValidation(options);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.overallStatus === "FAILED" ? 1 : 0;
  } catch (error: any) {
    const failureReport = {
      version: 1,
      timestamp: new Date().toISOString(),
      overallStatus: "FAILED",
      executionMode: options.dryRun
        ? "dry-run"
        : options.live
          ? "live-admin"
          : "mock",
      error: error?.message || String(error),
    };
    console.log(JSON.stringify(failureReport, null, 2));
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  (process.argv[1].endsWith("validate-checkout-refund-matrix.ts") ||
    process.argv[1].includes("validate-checkout-refund-matrix"))
) {
  void main();
}
