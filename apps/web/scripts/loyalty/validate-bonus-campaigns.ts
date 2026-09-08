import {
  assertNoCampaignOverlap,
  assertRunningCampaignImmutability,
  BonusCampaignPolicyError,
  bonusCampaignsOverlap,
  doesOrderLineMatchBonusCampaign,
  isTierEligibleForBonusCampaign,
  normalizeBonusCampaignTargets,
  normalizeEligibleCollectionIds,
  normalizeEligibleSkus,
  normalizeEligibleTierIds,
  parseBonusCampaignSchedule,
  resolveActiveBonusCampaign,
} from "@/lib/weletic/loyalty/bonus-campaign-policy";
import { calculateOrderEarn } from "@/lib/weletic/loyalty/earn";
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

export interface BonusCampaignsValidationReport {
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
// Phase 1: Campaign Lifecycle & Scheduling Policies
// ============================================================================

async function executePhase1(
  executionMode: ValidationExecutionMode,
  provenance: ValidationEvidenceProvenance,
): Promise<ValidationPhaseResult> {
  const phaseStartTime = Date.now();
  const checks: ValidationCheckResult[] = [];

  // Check 1: Multiplier bounds [1.5, 10.0] inclusive
  {
    const start = Date.now();
    let passed = true;
    let error: string | undefined;
    try {
      const low = parseBonusCampaignSchedule({
        startAt: "2026-09-01T00:00:00.000Z",
        endAt: "2026-09-05T00:00:00.000Z",
        multiplier: 1.5,
      });
      const high = parseBonusCampaignSchedule({
        startAt: "2026-09-01T00:00:00.000Z",
        endAt: "2026-09-05T00:00:00.000Z",
        multiplier: 10.0,
      });
      if (low.multiplier !== 1.5 || high.multiplier !== 10.0) {
        passed = false;
        error = "Multiplier bounds parsing mismatch";
      }

      let lowRejected = false;
      try {
        parseBonusCampaignSchedule({
          startAt: "2026-09-01T00:00:00.000Z",
          endAt: "2026-09-05T00:00:00.000Z",
          multiplier: 1.49,
        });
      } catch {
        lowRejected = true;
      }

      let highRejected = false;
      try {
        parseBonusCampaignSchedule({
          startAt: "2026-09-01T00:00:00.000Z",
          endAt: "2026-09-05T00:00:00.000Z",
          multiplier: 10.01,
        });
      } catch {
        highRejected = true;
      }

      if (!lowRejected || !highRejected) {
        passed = false;
        error = "Out of bound multipliers were not rejected";
      }
    } catch (e: any) {
      passed = false;
      error = e.message || String(e);
    }
    checks.push({
      name: "Multiplier bounds [1.5, 10.0] inclusive",
      passed,
      durationMs: Date.now() - start,
      error,
      provenance,
    });
  }

  // Check 2: Max duration <= 31 days
  {
    const start = Date.now();
    let passed = true;
    let error: string | undefined;
    try {
      parseBonusCampaignSchedule({
        startAt: "2026-09-01T00:00:00.000Z",
        endAt: "2026-10-02T00:00:00.000Z", // 31 days
        multiplier: 2.0,
      });

      let overRejected = false;
      try {
        parseBonusCampaignSchedule({
          startAt: "2026-09-01T00:00:00.000Z",
          endAt: "2026-10-02T00:00:00.001Z",
          multiplier: 2.0,
        });
      } catch {
        overRejected = true;
      }
      if (!overRejected) {
        passed = false;
        error = "Schedule exceeding 31 days was not rejected";
      }
    } catch (e: any) {
      passed = false;
      error = e.message || String(e);
    }
    checks.push({
      name: "Max duration <= 31 days enforced",
      passed,
      durationMs: Date.now() - start,
      error,
      provenance,
    });
  }

  // Check 3: Half-open scheduling window [startAt, endAt) adjacent touch logic
  {
    const start = Date.now();
    let passed = true;
    let error: string | undefined;
    try {
      const campA = {
        startAt: new Date("2026-09-01T00:00:00.000Z"),
        endAt: new Date("2026-09-08T00:00:00.000Z"),
      };
      const campB = {
        startAt: campA.endAt,
        endAt: new Date("2026-09-15T00:00:00.000Z"),
      };
      if (
        bonusCampaignsOverlap(campA, campB) ||
        bonusCampaignsOverlap(campB, campA)
      ) {
        passed = false;
        error = "Adjacent touching campaigns falsely reported as overlapping";
      }
    } catch (e: any) {
      passed = false;
      error = e.message || String(e);
    }
    checks.push({
      name: "Half-open scheduling window boundary touch non-overlap",
      passed,
      durationMs: Date.now() - start,
      error,
      provenance,
    });
  }

  // Check 4: Store non-overlapping invariant (assertNoCampaignOverlap)
  {
    const start = Date.now();
    let passed = true;
    let error: string | undefined;
    try {
      const existing = [
        {
          id: "camp_active_1",
          startAt: new Date("2026-09-01T00:00:00.000Z"),
          endAt: new Date("2026-09-08T00:00:00.000Z"),
          isActive: true,
          deletedAt: null,
        },
      ];
      let overlapBlocked = false;
      try {
        assertNoCampaignOverlap({
          proposed: {
            id: "camp_new",
            startAt: new Date("2026-09-05T00:00:00.000Z"),
            endAt: new Date("2026-09-12T00:00:00.000Z"),
            isActive: true,
          },
          existingCampaigns: existing,
        });
      } catch (e: any) {
        if (e instanceof BonusCampaignPolicyError) {
          overlapBlocked = true;
        }
      }
      if (!overlapBlocked) {
        passed = false;
        error =
          "Overlapping campaign was not rejected by assertNoCampaignOverlap";
      }
    } catch (e: any) {
      passed = false;
      error = e.message || String(e);
    }
    checks.push({
      name: "Store non-overlapping invariant enforced (assertNoCampaignOverlap)",
      passed,
      durationMs: Date.now() - start,
      error,
      provenance,
    });
  }

  // Check 5: Running campaign immutability mid-flight updates rejected
  {
    const start = Date.now();
    let passed = true;
    let error: string | undefined;
    try {
      const running = {
        startAt: new Date("2026-09-01T00:00:00.000Z"),
        endAt: new Date("2026-09-10T00:00:00.000Z"),
        multiplier: 2.0,
        isActive: true,
      };
      const now = new Date("2026-09-05T12:00:00.000Z");

      let multiplierBlocked = false;
      try {
        assertRunningCampaignImmutability({
          existing: running,
          updates: { multiplier: 3.0 },
          now,
        });
      } catch (e: any) {
        if (e instanceof BonusCampaignPolicyError) multiplierBlocked = true;
      }

      let dateBlocked = false;
      try {
        assertRunningCampaignImmutability({
          existing: running,
          updates: { startAt: "2026-09-02T00:00:00.000Z" },
          now,
        });
      } catch (e: any) {
        if (e instanceof BonusCampaignPolicyError) dateBlocked = true;
      }

      if (!multiplierBlocked || !dateBlocked) {
        passed = false;
        error = "Running campaign mid-flight updates were not blocked";
      }
    } catch (e: any) {
      passed = false;
      error = e.message || String(e);
    }
    checks.push({
      name: "Running campaign immutability mid-flight mutations rejected",
      passed,
      durationMs: Date.now() - start,
      error,
      provenance,
    });
  }

  // Check 6: Early deactivation permitted mid-flight
  {
    const start = Date.now();
    let passed = true;
    let error: string | undefined;
    try {
      const running = {
        startAt: new Date("2026-09-01T00:00:00.000Z"),
        endAt: new Date("2026-09-10T00:00:00.000Z"),
        multiplier: 2.0,
        isActive: true,
      };
      assertRunningCampaignImmutability({
        existing: running,
        updates: { isActive: false },
        now: new Date("2026-09-05T12:00:00.000Z"),
      });
    } catch (e: any) {
      passed = false;
      error = e.message || String(e);
    }
    checks.push({
      name: "Early deactivation permitted mid-flight",
      passed,
      durationMs: Date.now() - start,
      error,
      provenance,
    });
  }

  const durationMs = Date.now() - phaseStartTime;
  const status = checks.every((c) => c.passed) ? "PASSED" : "FAILED";
  return {
    phaseName: "Phase 1: Campaign Lifecycle & Scheduling Window Policies",
    status,
    durationMs,
    checks,
    provenance,
  };
}

// ============================================================================
// Phase 2: VIP Tier Targeting & Broadcast Resolution
// ============================================================================

async function executePhase2(
  executionMode: ValidationExecutionMode,
  provenance: ValidationEvidenceProvenance,
): Promise<ValidationPhaseResult> {
  const phaseStartTime = Date.now();
  const checks: ValidationCheckResult[] = [];

  // Check 7: Broadcast campaign matches all shoppers
  {
    const start = Date.now();
    let passed = true;
    let error: string | undefined;
    try {
      const broadcast = { eligibleTierIds: null };
      if (
        !isTierEligibleForBonusCampaign(broadcast, "wtier_gold") ||
        !isTierEligibleForBonusCampaign(broadcast, null)
      ) {
        passed = false;
        error = "Broadcast campaign failed to match shopper";
      }
    } catch (e: any) {
      passed = false;
      error = e.message || String(e);
    }
    checks.push({
      name: "Broadcast campaign matches all shoppers (including null tier)",
      passed,
      durationMs: Date.now() - start,
      error,
      provenance,
    });
  }

  // Check 8: Targeted tier filtering strictly admits qualified VIP tiers
  {
    const start = Date.now();
    let passed = true;
    let error: string | undefined;
    try {
      const targeted = { eligibleTierIds: ["wtier_gold", "wtier_platinum"] };
      if (!isTierEligibleForBonusCampaign(targeted, "wtier_gold")) {
        passed = false;
        error = "Qualified gold tier rejected";
      }
      if (isTierEligibleForBonusCampaign(targeted, "wtier_silver")) {
        passed = false;
        error = "Unqualified silver tier admitted";
      }
      if (isTierEligibleForBonusCampaign(targeted, null)) {
        passed = false;
        error = "Null tier admitted to targeted campaign";
      }
    } catch (e: any) {
      passed = false;
      error = e.message || String(e);
    }
    checks.push({
      name: "Targeted tier filtering strictly admits qualified tiers",
      passed,
      durationMs: Date.now() - start,
      error,
      provenance,
    });
  }

  // Check 9: Tier normalization and ID format validation
  {
    const start = Date.now();
    let passed = true;
    let error: string | undefined;
    try {
      const normalized = normalizeEligibleTierIds(["wtier_vip", "wtier_vip"]);
      if (normalized.length !== 1 || normalized[0] !== "wtier_vip") {
        passed = false;
        error = "Normalization deduplication failed";
      }
      let invalidRejected = false;
      try {
        normalizeEligibleTierIds(["invalid_slug"]);
      } catch {
        invalidRejected = true;
      }
      if (!invalidRejected) {
        passed = false;
        error = "Invalid tier slug was not rejected";
      }
    } catch (e: any) {
      passed = false;
      error = e.message || String(e);
    }
    checks.push({
      name: "Tier normalization & deduplication with ID validation",
      passed,
      durationMs: Date.now() - start,
      error,
      provenance,
    });
  }

  // Check 10: Event-time active campaign resolution with tier filtering
  {
    const start = Date.now();
    let passed = true;
    let error: string | undefined;
    try {
      const campaigns = [
        {
          id: "camp_active",
          multiplier: 3.0,
          startAt: new Date("2026-09-01T00:00:00.000Z"),
          endAt: new Date("2026-09-10T00:00:00.000Z"),
          isActive: true,
          eligibleTierIds: ["wtier_gold"],
        },
      ];
      const match = resolveActiveBonusCampaign({
        campaigns,
        occurredAt: new Date("2026-09-05T00:00:00.000Z"),
        customerTierId: "wtier_gold",
      });
      const noMatch = resolveActiveBonusCampaign({
        campaigns,
        occurredAt: new Date("2026-09-05T00:00:00.000Z"),
        customerTierId: "wtier_bronze",
      });
      if (!match || match.id !== "camp_active" || noMatch !== null) {
        passed = false;
        error = "resolveActiveBonusCampaign resolution mismatch";
      }
    } catch (e: any) {
      passed = false;
      error = e.message || String(e);
    }
    checks.push({
      name: "Event-time active campaign resolution with tier filtering",
      passed,
      durationMs: Date.now() - start,
      error,
      provenance,
    });
  }

  {
    const start = Date.now();
    let passed = true;
    let error: string | undefined;
    try {
      const targets = normalizeBonusCampaignTargets({
        eligibleSkus: [" SKU-BONUS ", "SKU-BONUS"],
        eligibleCollectionIds: ["gid://shopify/Collection/42"],
      });
      const skuMatch = doesOrderLineMatchBonusCampaign({
        targets,
        line: { sku: "SKU-BONUS", collectionExternalIds: [] },
      });
      const collectionMatch = doesOrderLineMatchBonusCampaign({
        targets,
        line: {
          sku: "SKU-BASE",
          collectionExternalIds: ["gid://shopify/Collection/42"],
        },
      });
      const missingSnapshotMatch = doesOrderLineMatchBonusCampaign({
        targets,
        line: {},
      });
      if (
        targets.eligibleSkus.length !== 1 ||
        !skuMatch ||
        !collectionMatch ||
        missingSnapshotMatch
      ) {
        passed = false;
        error = "Normalized match-any targeting invariant failed";
      }
      normalizeEligibleSkus(Array.from({ length: 100 }, (_, i) => `SKU-${i}`));
      normalizeEligibleCollectionIds(["gid://shopify/Collection/42"]);
    } catch (e: unknown) {
      passed = false;
      error = e instanceof Error ? e.message : String(e);
    }
    checks.push({
      name: "SKU/collection targets normalize and use match-any snapshots",
      passed,
      durationMs: Date.now() - start,
      error,
      provenance,
    });
  }

  {
    const start = Date.now();
    let passed = true;
    let error: string | undefined;
    try {
      const result = calculateOrderEarn({
        currency: "USD",
        orderOccurredAt: "2026-09-05T00:00:00.000Z",
        campaigns: [
          {
            id: "camp_targeted",
            multiplier: 2,
            startAt: "2026-09-01T00:00:00.000Z",
            endAt: "2026-09-10T00:00:00.000Z",
            eligibleTierIds: ["wtier_gold"],
            eligibleSkus: ["SKU-BONUS"],
          },
        ],
        customerTierId: "wtier_gold",
        lines: [
          {
            orderLineId: "line_bonus",
            lineNetAmount: BigInt(10_000),
            sku: "SKU-BONUS",
          },
          {
            orderLineId: "line_base",
            lineNetAmount: BigInt(10_000),
            sku: "SKU-BASE",
          },
        ],
      });
      if (
        result.grossPoints !== BigInt(300) ||
        result.lineAllocations?.[0].awardedPoints !== BigInt(200) ||
        result.lineAllocations?.[1].awardedPoints !== BigInt(100)
      ) {
        passed = false;
        error = "Partial-line multiplier allocation mismatch";
      }
    } catch (e: unknown) {
      passed = false;
      error = e instanceof Error ? e.message : String(e);
    }
    checks.push({
      name: "VIP-qualified product campaign preserves base points on nonmatches",
      passed,
      durationMs: Date.now() - start,
      error,
      provenance,
    });
  }

  const durationMs = Date.now() - phaseStartTime;
  const status = checks.every((c) => c.passed) ? "PASSED" : "FAILED";
  return {
    phaseName: "Phase 2: VIP and Product Targeting Resolution",
    status,
    durationMs,
    checks,
    provenance,
  };
}

// ============================================================================
// Phase 3: Exact Rational Order Earn & Multi-Currency Settlement
// ============================================================================

async function executePhase3(
  executionMode: ValidationExecutionMode,
  provenance: ValidationEvidenceProvenance,
): Promise<ValidationPhaseResult> {
  const phaseStartTime = Date.now();
  const checks: ValidationCheckResult[] = [];

  // Check 11: USD 2-decimal calculation
  {
    const start = Date.now();
    let passed = true;
    let error: string | undefined;
    try {
      const res = calculateOrderEarn({
        netAmountCents: 10000, // $100.00
        currency: "USD",
        campaignMultiplier: 2.0,
      });
      if (
        res.grossPoints !== BigInt(200) ||
        res.eligibleSubtotal !== BigInt(10000)
      ) {
        passed = false;
        error = `USD earn points mismatch: got ${res.grossPoints}, expected 200`;
      }
    } catch (e: any) {
      passed = false;
      error = e.message || String(e);
    }
    checks.push({
      name: "USD 2-decimal rational calculation ($100 with 2.0x -> 200 pts)",
      passed,
      durationMs: Date.now() - start,
      error,
      provenance,
    });
  }

  // Check 12: JPY 0-decimal calculation
  {
    const start = Date.now();
    let passed = true;
    let error: string | undefined;
    try {
      const res = calculateOrderEarn({
        netAmountCents: 10000, // ¥10,000
        currency: "JPY",
        campaignMultiplier: 1.5,
      });
      if (res.grossPoints !== BigInt(15000)) {
        passed = false;
        error = `JPY earn points mismatch: got ${res.grossPoints}, expected 15000`;
      }
    } catch (e: any) {
      passed = false;
      error = e.message || String(e);
    }
    checks.push({
      name: "JPY 0-decimal rational calculation (¥10,000 with 1.5x -> 15,000 pts)",
      passed,
      durationMs: Date.now() - start,
      error,
      provenance,
    });
  }

  // Check 13: VND 0-decimal calculation
  {
    const start = Date.now();
    let passed = true;
    let error: string | undefined;
    try {
      const res = calculateOrderEarn({
        netAmountCents: 500000, // 500,000₫
        currency: "VND",
        campaignMultiplier: 3.5,
      });
      if (res.grossPoints !== BigInt(1750000)) {
        passed = false;
        error = `VND earn points mismatch: got ${res.grossPoints}, expected 1750000`;
      }
    } catch (e: any) {
      passed = false;
      error = e.message || String(e);
    }
    checks.push({
      name: "VND 0-decimal rational calculation (500,000₫ with 3.5x -> 1,750,000 pts)",
      passed,
      durationMs: Date.now() - start,
      error,
      provenance,
    });
  }

  // Check 14: BHD 3-decimal calculation
  {
    const start = Date.now();
    let passed = true;
    let error: string | undefined;
    try {
      const res = calculateOrderEarn({
        netAmountCents: 25500, // 25.500 BHD
        currency: "BHD",
        campaignMultiplier: 2.0,
      });
      if (res.grossPoints !== BigInt(51)) {
        passed = false;
        error = `BHD earn points mismatch: got ${res.grossPoints}, expected 51`;
      }
    } catch (e: any) {
      passed = false;
      error = e.message || String(e);
    }
    checks.push({
      name: "BHD 3-decimal rational calculation (25.500 BHD with 2.0x -> 51 pts)",
      passed,
      durationMs: Date.now() - start,
      error,
      provenance,
    });
  }

  // Check 15: Penny-conserving line-item allocation
  {
    const start = Date.now();
    let passed = true;
    let error: string | undefined;
    try {
      const res = calculateOrderEarn({
        currency: "USD",
        campaignMultiplier: 2.0,
        lines: [
          { orderLineId: "l1", lineNetAmount: BigInt(6000) },
          { orderLineId: "l2", lineNetAmount: BigInt(4000) },
        ],
      });
      const sum = res.lineAllocations!.reduce(
        (acc, l) => acc + l.awardedPoints,
        BigInt(0),
      );
      if (sum !== res.grossPoints || sum !== BigInt(200)) {
        passed = false;
        error = "Line-item allocation failed penny conservation";
      }
    } catch (e: any) {
      passed = false;
      error = e.message || String(e);
    }
    checks.push({
      name: "Penny-conserving line-item allocation across order lines",
      passed,
      durationMs: Date.now() - start,
      error,
      provenance,
    });
  }

  // Check 16: Excluded item handling
  {
    const start = Date.now();
    let passed = true;
    let error: string | undefined;
    try {
      const res = calculateOrderEarn({
        currency: "USD",
        campaignMultiplier: 2.0,
        lines: [
          {
            orderLineId: "l1",
            lineNetAmount: BigInt(5000),
            isExcluded: true,
          },
          {
            orderLineId: "l2",
            lineNetAmount: BigInt(5000),
            isExcluded: false,
          },
        ],
      });
      if (
        res.eligibleSubtotal !== BigInt(5000) ||
        res.grossPoints !== BigInt(100)
      ) {
        passed = false;
        error = "Excluded line earned points or contaminated subtotal";
      }
    } catch (e: any) {
      passed = false;
      error = e.message || String(e);
    }
    checks.push({
      name: "Excluded items receive 0 points and do not contaminate subtotal",
      passed,
      durationMs: Date.now() - start,
      error,
      provenance,
    });
  }

  const durationMs = Date.now() - phaseStartTime;
  const status = checks.every((c) => c.passed) ? "PASSED" : "FAILED";
  return {
    phaseName: "Phase 3: Exact Rational Order Earn & Multi-Currency Settlement",
    status,
    durationMs,
    checks,
    provenance,
  };
}

// ============================================================================
// Phase 4: Ledger Audit Provenance & Immutability Verification
// ============================================================================

async function executePhase4(
  executionMode: ValidationExecutionMode,
  provenance: ValidationEvidenceProvenance,
): Promise<ValidationPhaseResult> {
  const phaseStartTime = Date.now();
  const checks: ValidationCheckResult[] = [];

  // Check 17: Campaign selection and multiplier tracking in calculation result
  {
    const start = Date.now();
    let passed = true;
    let error: string | undefined;
    try {
      const campaigns = [
        {
          id: "camp_promo_verified",
          multiplier: 3.5,
          startAt: new Date("2026-09-01T00:00:00.000Z"),
          endAt: new Date("2026-09-10T00:00:00.000Z"),
          isActive: true,
        },
      ];
      const res = calculateOrderEarn({
        netAmountCents: 10000,
        currency: "USD",
        campaigns,
        orderOccurredAt: new Date("2026-09-05T00:00:00.000Z"),
      });

      if (
        res.selectedCampaignId !== "camp_promo_verified" ||
        res.campaignMultiplier !== 3.5 ||
        res.grossPoints !== BigInt(350)
      ) {
        passed = false;
        error = "Campaign metadata was not preserved in calculation result";
      }
    } catch (e: any) {
      passed = false;
      error = e.message || String(e);
    }
    checks.push({
      name: "Calculation preserves selectedCampaignId and campaignMultiplier tracking",
      passed,
      durationMs: Date.now() - start,
      error,
      provenance,
    });
  }

  // Check 18: Step boundary at exact startAt and endAt
  {
    const start = Date.now();
    let passed = true;
    let error: string | undefined;
    try {
      const startMs = new Date("2026-09-01T00:00:00.000Z").getTime();
      const endMs = new Date("2026-09-10T00:00:00.000Z").getTime();
      const campaign = {
        id: "camp_timing",
        multiplier: 2.0,
        startAt: new Date(startMs),
        endAt: new Date(endMs),
        isActive: true,
      };

      const resBefore = calculateOrderEarn({
        netAmountCents: 10000,
        currency: "USD",
        campaigns: [campaign],
        orderOccurredAt: new Date(startMs - 1),
      });
      const resAtStart = calculateOrderEarn({
        netAmountCents: 10000,
        currency: "USD",
        campaigns: [campaign],
        orderOccurredAt: new Date(startMs),
      });
      const resAtEnd = calculateOrderEarn({
        netAmountCents: 10000,
        currency: "USD",
        campaigns: [campaign],
        orderOccurredAt: new Date(endMs),
      });

      if (
        resBefore.selectedCampaignId !== null ||
        resAtStart.selectedCampaignId !== "camp_timing" ||
        resAtEnd.selectedCampaignId !== null
      ) {
        passed = false;
        error = "Step transition failed at boundary timestamps";
      }
    } catch (e: any) {
      passed = false;
      error = e.message || String(e);
    }
    checks.push({
      name: "Exact millisecond step-transitions at campaign start and end boundaries",
      passed,
      durationMs: Date.now() - start,
      error,
      provenance,
    });
  }

  const durationMs = Date.now() - phaseStartTime;
  const status = checks.every((c) => c.passed) ? "PASSED" : "FAILED";
  return {
    phaseName: "Phase 4: Ledger Audit Provenance & Immutability Verification",
    status,
    durationMs,
    checks,
    provenance,
  };
}

// ============================================================================
// Main Runner & CLI Execution
// ============================================================================

export async function runBonusCampaignsValidation(
  options: ValidationCLIOptions,
): Promise<BonusCampaignsValidationReport> {
  const startTime = Date.now();
  const executionMode: ValidationExecutionMode = options.mock
    ? "mock"
    : options.live
      ? "live-admin"
      : "dry-run";

  const provenance: ValidationEvidenceProvenance = {
    source: "simulated",
    executionMode,
    live: false,
  };

  const storeDomain =
    options.storeDomain || "simulated-bonus-campaigns-store.myshopify.com";

  // Mandatory safety guardrail for live validation
  if (executionMode === "live-admin") {
    if (
      process.env.NODE_ENV === "production" ||
      process.env.VERCEL_ENV === "production"
    ) {
      throw new Error(
        "Live validation is forbidden in production environments.",
      );
    }
    if (!options.confirmStaging) {
      throw new Error(
        "Missing mandatory --confirm-staging flag for live validation.",
      );
    }
  }

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

  const report: BonusCampaignsValidationReport = {
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
    const report = await runBonusCampaignsValidation(options);
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
  (process.argv[1].endsWith("validate-bonus-campaigns.ts") ||
    process.argv[1].includes("validate-bonus-campaigns"))
) {
  void main();
}
