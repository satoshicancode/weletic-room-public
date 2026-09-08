import { prisma } from "@/lib/prisma";
import { getLifetimeEarnedPointsDelta } from "@/lib/weletic/loyalty/ledger-entry-policy";
import {
  Prisma,
  WeleticLoyaltyAccountStatus,
  WeleticPointsLedgerEntryType,
} from "@prisma/client";

export type AnomalySeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type AnomalyType =
  | "CACHE_BALANCE_DRIFT"
  | "LIFETIME_METRICS_DRIFT"
  | "SEQUENCE_GAP"
  | "SEQUENCE_COLLISION"
  | "BALANCE_CHAIN_DISCONTINUITY"
  | "ORPHAN_LEDGER_RECORD";

export interface LedgerAnomaly {
  accountId: string;
  storeId: string;
  type: AnomalyType;
  severity: AnomalySeverity;
  actionTaken: "AUTO_REPAIRED" | "QUARANTINED" | "LOGGED_ONLY";
  description: string;
  details: Record<string, unknown>;
}

export interface AccountAuditResult {
  accountId: string;
  storeId: string;
  status: WeleticLoyaltyAccountStatus;
  entriesCount: number;
  calculatedBalance: bigint;
  previousCachedBalance: bigint;
  isClean: boolean;
  repaired: boolean;
  quarantined: boolean;
  anomalies: LedgerAnomaly[];
}

export interface StoreAuditSummary {
  storeId: string;
  totalAccounts: number;
  cleanAccounts: number;
  repairedAccounts: number;
  quarantinedAccounts: number;
  totalLedgerEntries: number;
  anomalies: LedgerAnomaly[];
  generatedAt: string;
}

export interface AuditOptions {
  autoRepair?: boolean;
  quarantineFatal?: boolean;
  tx?: Prisma.TransactionClient;
}

/**
 * Audits a single loyalty account's ledger for mathematical and sequential integrity.
 * Applies non-crashing quarantine or auto-repair based on detected anomaly severity.
 */
export async function auditAccountLedger(
  accountId: string,
  options: AuditOptions = {},
): Promise<AccountAuditResult> {
  const autoRepair = options.autoRepair ?? true;
  const quarantineFatal = options.quarantineFatal ?? true;
  const db = options.tx ?? prisma;

  const account = await db.weleticLoyaltyAccount.findUnique({
    where: { id: accountId },
  });

  if (!account) {
    throw new Error(`Loyalty account ${accountId} not found.`);
  }

  const entries = await db.weleticPointsLedgerEntry.findMany({
    where: { accountId },
    orderBy: [{ sequenceNumber: "asc" }, { createdAt: "asc" }],
  });

  const anomalies: LedgerAnomaly[] = [];
  let runningBalance = BigInt(0);
  let lifetimeEarned = BigInt(0);
  let lifetimeRedeemed = BigInt(0);
  let hasFatalAnomaly = false;

  const seenSequences = new Set<number>();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const expectedSequence = i + 1;

    // 1. Check for Duplicate Sequences
    if (seenSequences.has(entry.sequenceNumber)) {
      hasFatalAnomaly = true;
      anomalies.push({
        accountId,
        storeId: account.storeId,
        type: "SEQUENCE_COLLISION",
        severity: "CRITICAL",
        actionTaken: quarantineFatal ? "QUARANTINED" : "LOGGED_ONLY",
        description: `Duplicate sequence number ${entry.sequenceNumber} detected at entry ${entry.id}.`,
        details: { sequenceNumber: entry.sequenceNumber, entryId: entry.id },
      });
    }
    seenSequences.add(entry.sequenceNumber);

    // 2. Check for Sequence Gaps
    if (entry.sequenceNumber !== expectedSequence) {
      hasFatalAnomaly = true;
      anomalies.push({
        accountId,
        storeId: account.storeId,
        type: "SEQUENCE_GAP",
        severity: "CRITICAL",
        actionTaken: quarantineFatal ? "QUARANTINED" : "LOGGED_ONLY",
        description: `Sequence gap detected: entry ${entry.id} has sequence ${entry.sequenceNumber}, expected ${expectedSequence}.`,
        details: {
          expectedSequence,
          actualSequence: entry.sequenceNumber,
          entryId: entry.id,
        },
      });
    }

    // 3. Check Running Balance Discontinuity
    const expectedBalanceAfter = runningBalance + entry.pointsDelta;
    if (entry.balanceAfter !== expectedBalanceAfter) {
      hasFatalAnomaly = true;
      anomalies.push({
        accountId,
        storeId: account.storeId,
        type: "BALANCE_CHAIN_DISCONTINUITY",
        severity: "CRITICAL",
        actionTaken: quarantineFatal ? "QUARANTINED" : "LOGGED_ONLY",
        description: `Running balance mismatch at entry ${entry.id}: recorded ${entry.balanceAfter}, expected ${expectedBalanceAfter}.`,
        details: {
          entryId: entry.id,
          recordedBalance: entry.balanceAfter.toString(),
          expectedBalance: expectedBalanceAfter.toString(),
          pointsDelta: entry.pointsDelta.toString(),
        },
      });
    }

    runningBalance += entry.pointsDelta;

    lifetimeEarned += getLifetimeEarnedPointsDelta(
      entry.entryType,
      entry.pointsDelta,
      entry.referenceType,
    );

    if (
      entry.entryType === WeleticPointsLedgerEntryType.REDEEM_REWARD &&
      entry.pointsDelta < BigInt(0)
    ) {
      lifetimeRedeemed += -entry.pointsDelta;
    }
  }

  // 4. Check Cached Balance & Lifetime Metric Drift
  const isBalanceMatch = account.cachedPointsBalance === runningBalance;
  const isEarnedMatch = account.lifetimePointsEarned === lifetimeEarned;
  const isRedeemedMatch = account.lifetimePointsRedeemed === lifetimeRedeemed;

  if (!isBalanceMatch) {
    anomalies.push({
      accountId,
      storeId: account.storeId,
      type: "CACHE_BALANCE_DRIFT",
      severity: "LOW",
      actionTaken:
        autoRepair && !hasFatalAnomaly ? "AUTO_REPAIRED" : "LOGGED_ONLY",
      description: `Cached balance drift: account has ${account.cachedPointsBalance}, authoritative ledger has ${runningBalance}.`,
      details: {
        cachedBalance: account.cachedPointsBalance.toString(),
        ledgerBalance: runningBalance.toString(),
      },
    });
  }

  if (!isEarnedMatch || !isRedeemedMatch) {
    anomalies.push({
      accountId,
      storeId: account.storeId,
      type: "LIFETIME_METRICS_DRIFT",
      severity: "LOW",
      actionTaken:
        autoRepair && !hasFatalAnomaly ? "AUTO_REPAIRED" : "LOGGED_ONLY",
      description: `Lifetime metrics drift detected.`,
      details: {
        cachedEarned: account.lifetimePointsEarned.toString(),
        ledgerEarned: lifetimeEarned.toString(),
        cachedRedeemed: account.lifetimePointsRedeemed.toString(),
        ledgerRedeemed: lifetimeRedeemed.toString(),
      },
    });
  }

  let repaired = false;
  let quarantined = false;

  // 5. Apply Safe Auto-Repair or Quarantine
  if (hasFatalAnomaly && quarantineFatal) {
    quarantined = true;
    const existingMeta = (account.metadata as Record<string, unknown>) || {};
    await db.weleticLoyaltyAccount.update({
      where: { id: accountId },
      data: {
        status: WeleticLoyaltyAccountStatus.suspended,
        metadata: {
          ...existingMeta,
          quarantine: {
            isQuarantined: true,
            quarantinedAt: new Date().toISOString(),
            reason:
              "Fatal ledger inconsistency detected during reconciliation audit.",
            anomalyCount: anomalies.length,
          },
        } as Prisma.InputJsonValue,
      },
    });
  } else if (
    !hasFatalAnomaly &&
    autoRepair &&
    (!isBalanceMatch || !isEarnedMatch || !isRedeemedMatch)
  ) {
    repaired = true;
    await db.weleticLoyaltyAccount.update({
      where: { id: accountId },
      data: {
        cachedPointsBalance: runningBalance,
        lifetimePointsEarned: lifetimeEarned,
        lifetimePointsRedeemed: lifetimeRedeemed,
      },
    });
  }

  return {
    accountId,
    storeId: account.storeId,
    status: quarantined
      ? WeleticLoyaltyAccountStatus.suspended
      : account.status,
    entriesCount: entries.length,
    calculatedBalance: runningBalance,
    previousCachedBalance: account.cachedPointsBalance,
    isClean: anomalies.length === 0,
    repaired,
    quarantined,
    anomalies,
  };
}

/**
 * Audits all loyalty accounts for a given store and generates a comprehensive summary.
 */
export async function auditStoreLedgers(
  storeId: string,
  options: AuditOptions = {},
): Promise<StoreAuditSummary> {
  const accounts = await prisma.weleticLoyaltyAccount.findMany({
    where: { storeId },
    select: { id: true },
  });

  const allAnomalies: LedgerAnomaly[] = [];
  let cleanCount = 0;
  let repairedCount = 0;
  let quarantinedCount = 0;
  let totalEntries = 0;

  for (const account of accounts) {
    const res = await auditAccountLedger(account.id, options);
    totalEntries += res.entriesCount;
    if (res.isClean) cleanCount++;
    if (res.repaired) repairedCount++;
    if (res.quarantined) quarantinedCount++;
    allAnomalies.push(...res.anomalies);
  }

  return {
    storeId,
    totalAccounts: accounts.length,
    cleanAccounts: cleanCount,
    repairedAccounts: repairedCount,
    quarantinedAccounts: quarantinedCount,
    totalLedgerEntries: totalEntries,
    anomalies: allAnomalies,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Audits all loyalty accounts across all stores.
 */
export async function auditAllStores(
  options: AuditOptions = {},
): Promise<StoreAuditSummary[]> {
  const stores = await prisma.weleticShopifyStore.findMany({
    select: { id: true },
  });

  const summaries: StoreAuditSummary[] = [];
  for (const store of stores) {
    const summary = await auditStoreLedgers(store.id, options);
    summaries.push(summary);
  }
  return summaries;
}
