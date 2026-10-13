import { prisma } from "@/lib/prisma";
import { readStoreWalletReconciliation } from "@/lib/weletic/loyalty/wallet-reconciliation";
import { nanoid } from "nanoid";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("readStoreWalletReconciliation on Cloudflare D1 SQLite", () => {
  let storeId: string;
  let workspaceId: string;

  beforeEach(async () => {
    storeId = `store_test_reconcile_${nanoid(8)}`;
    workspaceId = `ws_test_reconcile_${nanoid(8)}`;

    await prisma.$executeRaw`
      INSERT INTO Project (id, name, slug, billingCycleStart, createdAt, updatedAt)
      VALUES (${workspaceId}, 'Test Reconcile WS', ${`ws-${nanoid(8)}`}, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `;

    await prisma.$executeRaw`
      INSERT INTO WeleticShopifyStore (id, projectId, programId, shopDomain, shopCurrency, apiVersion, installationGeneration, createdAt, updatedAt)
      VALUES (${storeId}, ${workspaceId}, ${`prog_${nanoid(8)}`}, ${`${storeId}.myshopify.com`}, 'USD', '2026-04', 'gen_1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `;
  });

  afterEach(async () => {
    await prisma.$executeRaw`DELETE FROM WeleticLoyaltyRefundAllocation WHERE storeId = ${storeId}`;
    await prisma.$executeRaw`DELETE FROM WeleticPointsLedgerEntry WHERE storeId = ${storeId}`;
    await prisma.$executeRaw`DELETE FROM WeleticLoyaltyOrderLineEarn WHERE storeId = ${storeId}`;
    await prisma.$executeRaw`DELETE FROM WeleticLoyaltyEarnGrant WHERE storeId = ${storeId}`;
    await prisma.$executeRaw`DELETE FROM WeleticLoyaltyAccount WHERE storeId = ${storeId}`;
    await prisma.$executeRaw`DELETE FROM WeleticShopifyStore WHERE id = ${storeId}`;
    await prisma.$executeRaw`DELETE FROM Project WHERE id = ${workspaceId}`;
  });

  it("returns a clean status with all-zero counts for an empty store", async () => {
    const result = await prisma.$transaction(async (tx) => {
      return await readStoreWalletReconciliation({ tx, storeId });
    });

    expect(result).toMatchObject({
      accounts: "0",
      balanceMismatch: "0",
      pendingMismatch: "0",
      earnedMismatch: "0",
      redeemedMismatch: "0",
      sequenceMismatch: "0",
      chainMismatch: "0",
      orphanLedger: "0",
      orphanGrants: "0",
      grantConservationMismatch: "0",
      lineAllocationMismatch: "0",
      orphanLines: "0",
      grantLedgerMismatch: "0",
      orphanGrantLedger: "0",
      grantLedgerSourceMismatch: "0",
      pendingEventMismatch: "0",
      pendingHistoryUnavailable: "0",
      unattributedPendingEvents: "0",
      pendingEventShapeMismatch: "0",
      pendingSourceMismatch: "0",
      refundAllocationUnavailable: "0",
      refundAllocationMismatch: "0",
      refundLineAllocationMismatch: "0",
      orphanRefundAllocations: "0",
      refundSourceTargetUnavailable: "0",
      refundSourceTargetMismatch: "0",
      status: "clean",
    });
  });

  it("reconciles account with matching ledger entry cleanly", async () => {
    const accountId = `acc_${nanoid(8)}`;
    const shopperId = `shopper_${nanoid(8)}`;

    await prisma.$executeRaw`
      INSERT INTO WeleticLoyaltyAccount (id, storeId, programId, shopperId, cachedPointsBalance, cachedPendingPoints, lifetimePointsEarned, lifetimePointsRedeemed, ledgerVersion, enrolledAt, createdAt, updatedAt)
      VALUES (${accountId}, ${storeId}, 'prog_test', ${shopperId}, 100, 0, 100, 0, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `;

    await prisma.$executeRaw`
      INSERT INTO WeleticPointsLedgerEntry (id, storeId, accountId, sequenceNumber, entryType, pointsDelta, pendingDelta, balanceAfter, idempotencyKey, createdAt)
      VALUES (${`entry_${nanoid(8)}`}, ${storeId}, ${accountId}, 1, 'EARN_ORDER', 100, 0, 100, ${`idem_${nanoid(8)}`}, CURRENT_TIMESTAMP)
    `;

    const result = await prisma.$transaction(async (tx) => {
      return await readStoreWalletReconciliation({ tx, storeId });
    });

    expect(result.accounts).toBe("1");
    expect(result.balanceMismatch).toBe("0");
    expect(result.earnedMismatch).toBe("0");
    expect(result.sequenceMismatch).toBe("0");
    expect(result.chainMismatch).toBe("0");
    expect(result.status).toBe("clean");
  });

  it("detects cached balance drift and reports mismatch", async () => {
    const accountId = `acc_${nanoid(8)}`;
    const shopperId = `shopper_${nanoid(8)}`;

    await prisma.$executeRaw`
      INSERT INTO WeleticLoyaltyAccount (id, storeId, programId, shopperId, cachedPointsBalance, cachedPendingPoints, lifetimePointsEarned, lifetimePointsRedeemed, ledgerVersion, enrolledAt, createdAt, updatedAt)
      VALUES (${accountId}, ${storeId}, 'prog_test', ${shopperId}, 999, 0, 100, 0, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `;

    await prisma.$executeRaw`
      INSERT INTO WeleticPointsLedgerEntry (id, storeId, accountId, sequenceNumber, entryType, pointsDelta, pendingDelta, balanceAfter, idempotencyKey, createdAt)
      VALUES (${`entry_${nanoid(8)}`}, ${storeId}, ${accountId}, 1, 'EARN_ORDER', 100, 0, 100, ${`idem_${nanoid(8)}`}, CURRENT_TIMESTAMP)
    `;

    const result = await prisma.$transaction(async (tx) => {
      return await readStoreWalletReconciliation({ tx, storeId });
    });

    expect(result.accounts).toBe("1");
    expect(result.balanceMismatch).toBe("1");
    expect(result.status).toBe("mismatch");
  });

  it("reconciles holding period grants using SQLite json_type and json_extract", async () => {
    const accountId = `acc_${nanoid(8)}`;
    const shopperId = `shopper_${nanoid(8)}`;
    const grantId = `grant_${nanoid(8)}`;
    const calculationSnapshot = JSON.stringify({
      holdingPeriodDays: 30,
      source: "shopify_order",
    });

    await prisma.$executeRaw`
      INSERT INTO WeleticLoyaltyAccount (id, storeId, programId, shopperId, cachedPointsBalance, cachedPendingPoints, lifetimePointsEarned, lifetimePointsRedeemed, ledgerVersion, enrolledAt, createdAt, updatedAt)
      VALUES (${accountId}, ${storeId}, 'prog_test', ${shopperId}, 0, 50, 0, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `;

    await prisma.$executeRaw`
      INSERT INTO WeleticLoyaltyEarnGrant (id, storeId, programId, accountId, shopperId, orderId, currency, eligibleSubtotalAmount, orderTotalAmount, grossPoints, pendingPoints, settledPoints, reversedPoints, availableAt, pointsPerCurrencyUnit, effectiveMultiplier, calculationSnapshot, createdAt, updatedAt)
      VALUES (${grantId}, ${storeId}, 'prog_test', ${accountId}, ${shopperId}, ${`order_${nanoid(8)}`}, 'USD', 5000, 5000, 50, 50, 0, 0, CURRENT_TIMESTAMP, 1.0, 1.0, ${calculationSnapshot}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `;

    await prisma.$executeRaw`
      INSERT INTO WeleticLoyaltyOrderLineEarn (id, storeId, grantId, orderLineId, quantity, lineNetAmount, awardedPoints, reversedPoints, createdAt, updatedAt)
      VALUES (${`line_${nanoid(8)}`}, ${storeId}, ${grantId}, ${`line_order_${nanoid(8)}`}, 1, 5000, 50, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `;

    const result = await prisma.$transaction(async (tx) => {
      return await readStoreWalletReconciliation({ tx, storeId });
    });

    expect(result.accounts).toBe("1");
    expect(result.pendingEventMismatch).toBe("0");
    expect(result.pendingHistoryUnavailable).toBe("0");
    expect(result.grantConservationMismatch).toBe("0");
    expect(result.lineAllocationMismatch).toBe("0");
    expect(result.status).toBe("clean");
  });

  it("reconciles WeleticLoyaltyRefundAllocation and detects line allocation drift", async () => {
    const accountId = `acc_${nanoid(8)}`;
    const shopperId = `shopper_${nanoid(8)}`;
    const grantId = `grant_${nanoid(8)}`;
    const orderId = `order_${nanoid(8)}`;
    const refundId = `refund_${nanoid(8)}`;
    const orderLineId = `line_${nanoid(8)}`;
    const ledgerEntryId = `ledger_${nanoid(8)}`;

    await prisma.$executeRaw`
      INSERT INTO WeleticLoyaltyAccount (id, storeId, programId, shopperId, cachedPointsBalance, cachedPendingPoints, lifetimePointsEarned, lifetimePointsRedeemed, ledgerVersion, enrolledAt, createdAt, updatedAt)
      VALUES (${accountId}, ${storeId}, 'prog_test', ${shopperId}, 70, 0, 100, 0, 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `;

    const calcSnapshot = JSON.stringify({
      holdingPeriodDays: 0,
      source: "shopify_order",
    });

    await prisma.$executeRaw`
      INSERT INTO WeleticLoyaltyEarnGrant (id, storeId, programId, accountId, shopperId, orderId, currency, eligibleSubtotalAmount, orderTotalAmount, grossPoints, pendingPoints, settledPoints, reversedPoints, availableAt, pointsPerCurrencyUnit, effectiveMultiplier, calculationSnapshot, createdAt, updatedAt)
      VALUES (${grantId}, ${storeId}, 'prog_test', ${accountId}, ${shopperId}, ${orderId}, 'USD', 10000, 10000, 100, 0, 70, 30, CURRENT_TIMESTAMP, 1.0, 1.0, ${calcSnapshot}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `;

    await prisma.$executeRaw`
      INSERT INTO WeleticLoyaltyOrderLineEarn (id, storeId, grantId, orderLineId, quantity, lineNetAmount, awardedPoints, reversedPoints, createdAt, updatedAt)
      VALUES (${`earn_${nanoid(8)}`}, ${storeId}, ${grantId}, ${orderLineId}, 10, 10000, 100, 30, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `;

    // Initial earn ledger entry
    await prisma.$executeRaw`
      INSERT INTO WeleticPointsLedgerEntry (id, storeId, accountId, sequenceNumber, entryType, referenceType, referenceId, grantId, pointsDelta, pendingDelta, balanceAfter, idempotencyKey, createdAt)
      VALUES (${`earn_ledger_${nanoid(8)}`}, ${storeId}, ${accountId}, 1, 'EARN_ORDER', 'COMMERCE_ORDER', ${orderId}, ${grantId}, 100, 0, 100, ${`idem_earn_${nanoid(8)}`}, CURRENT_TIMESTAMP)
    `;

    // Commerce refund record
    await prisma.$executeRaw`
      INSERT INTO WeleticCommerceRefund (id, storeId, orderId, externalId, presentmentCurrency, presentmentAmount, shopCurrency, shopAmount, accountingCurrency, accountingAmount, accountingFxRate, occurredAt, createdAt, updatedAt)
      VALUES (${refundId}, ${storeId}, ${orderId}, ${refundId}, 'USD', 3000, 'USD', 3000, 'USD', 3000, '1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `;

    // Commerce refund line
    await prisma.$executeRaw`
      INSERT INTO WeleticCommerceRefundLine (id, refundId, orderLineId, externalId, quantity, shopAmount, presentmentAmount, accountingAmount, createdAt)
      VALUES (${`rline_${nanoid(8)}`}, ${refundId}, ${orderLineId}, ${`ext_${nanoid(8)}`}, 3, 3000, 3000, 3000, CURRENT_TIMESTAMP)
    `;

    // Refund reversal ledger entry with metadata
    const metadata = JSON.stringify({
      refundAllocationVersion: 1,
      refundAllocationMode: "line_refund",
      totalClawback: "30",
      settledClawback: "30",
      pendingVoided: "0",
      lineReversalCount: 1,
      lineReversals: [{ orderLineId, points: "30" }],
    });

    await prisma.$executeRaw`
      INSERT INTO WeleticPointsLedgerEntry (id, storeId, accountId, sequenceNumber, entryType, referenceType, referenceId, grantId, pointsDelta, pendingDelta, balanceAfter, idempotencyKey, metadata, createdAt)
      VALUES (${ledgerEntryId}, ${storeId}, ${accountId}, 2, 'REFUND_REVERSAL', 'COMMERCE_REFUND', ${refundId}, ${grantId}, -30, 0, 70, ${`idem_ref_${nanoid(8)}`}, ${metadata}, CURRENT_TIMESTAMP)
    `;

    // Retained immutable refund allocation row
    await prisma.$executeRaw`
      INSERT INTO WeleticLoyaltyRefundAllocation (id, storeId, ledgerEntryId, grantId, refundId, orderLineId, points, createdAt)
      VALUES (${`alloc_${nanoid(8)}`}, ${storeId}, ${ledgerEntryId}, ${grantId}, ${refundId}, ${orderLineId}, 30, CURRENT_TIMESTAMP)
    `;

    const result = await prisma.$transaction(async (tx) => {
      return await readStoreWalletReconciliation({ tx, storeId });
    });

    expect(result.status).toBe("clean");
    expect(result.refundAllocationMismatch).toBe("0");
    expect(result.refundLineAllocationMismatch).toBe("0");
    expect(result.orphanRefundAllocations).toBe("0");

    // Introduce tamper: mutate allocation points to not match lineReversals
    await prisma.$executeRaw`
      UPDATE WeleticLoyaltyRefundAllocation
      SET points = 99
      WHERE storeId = ${storeId}
    `;

    const tamperedResult = await prisma.$transaction(async (tx) => {
      return await readStoreWalletReconciliation({ tx, storeId });
    });

    expect(tamperedResult.status).toBe("mismatch");
    expect(tamperedResult.refundAllocationMismatch).toBe("1");

    // Clean up refund records
    await prisma.$executeRaw`DELETE FROM WeleticCommerceRefundLine WHERE refundId = ${refundId}`;
    await prisma.$executeRaw`DELETE FROM WeleticCommerceRefund WHERE id = ${refundId}`;
  });
});
