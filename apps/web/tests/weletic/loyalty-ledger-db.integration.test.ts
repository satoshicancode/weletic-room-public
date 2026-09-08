import { prisma } from "@/lib/prisma";
import {
  commitBackfillJob,
  createBackfillJob,
  generateBackfillPreview,
} from "@/lib/weletic/loyalty/backfill";
import {
  auditHistoricalBackfill,
  repairHistoricalBackfillStore,
} from "@/lib/weletic/loyalty/backfill-repair";
import { processRefundPointsReversal } from "@/lib/weletic/loyalty/earn";
import { releaseHoldingPeriodGrant } from "@/lib/weletic/loyalty/holding-period";
import { appendPointsLedgerEntry } from "@/lib/weletic/loyalty/ledger";
import { evaluateReferralQualification } from "@/lib/weletic/loyalty/referrals";
import {
  WeleticLoyaltyReferralStatus,
  WeleticPointsLedgerEntryType,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runHistoricalBackfillValidation } from "../../scripts/loyalty/validate-historical-backfill";

vi.mock("@/lib/weletic/redis-lock", () => ({
  withDistributedLock: vi.fn(async ({ fn }: { fn: () => Promise<unknown> }) =>
    fn(),
  ),
}));

const INITIAL_BALANCE = BigInt(1_000);
const RUN_ID = `dbit_${process.pid}_${Date.now()}`;
const workspaceId = `ws_${RUN_ID}`;
const affiliateProgramId = `program_${RUN_ID}`;
const storeId = `store_${RUN_ID}`;
const loyaltyProgramId = `loyalty_${RUN_ID}`;
const policyRevisionId = `loyalty_policy_revision_${RUN_ID}`;
const shopperId = `shopper_${RUN_ID}`;
const accountId = `account_${RUN_ID}`;
const raceShopperId = `race_shopper_${RUN_ID}`;
const raceAccountId = `race_account_${RUN_ID}`;
const raceOrderId = `race_order_${RUN_ID}`;
const raceOrderLineId = `race_order_line_${RUN_ID}`;
const raceGrantId = `race_grant_${RUN_ID}`;
const raceRefundId = `race_refund_${RUN_ID}`;
const underflowShopperId = `underflow_shopper_${RUN_ID}`;
const underflowAccountId = `underflow_account_${RUN_ID}`;
const underflowOrderId = `underflow_order_${RUN_ID}`;
const underflowOrderLineId = `underflow_order_line_${RUN_ID}`;
const underflowGrantId = `underflow_grant_${RUN_ID}`;
const underflowRefundId = `underflow_refund_${RUN_ID}`;

function requireIsolatedDatabase() {
  if (process.env.LOYALTY_DATABASE_INTEGRATION !== "1") {
    throw new Error(
      "Set LOYALTY_DATABASE_INTEGRATION=1 to run the real loyalty database suite",
    );
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required for loyalty database integration tests",
    );
  }

  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, "");
  if (!databaseName.startsWith("weletic_loyalty_it_")) {
    throw new Error(
      `Refusing to run against non-isolated database '${databaseName}'`,
    );
  }
}

describe("loyalty ledger real database concurrency", () => {
  beforeAll(async () => {
    requireIsolatedDatabase();

    await prisma.project.create({
      data: {
        id: workspaceId,
        name: "Loyalty DB Integration",
        slug: workspaceId,
        billingCycleStart: 1,
      },
    });
    await prisma.program.create({
      data: {
        id: affiliateProgramId,
        workspaceId,
        defaultFolderId: `folder_${RUN_ID}`,
        defaultGroupId: `group_${RUN_ID}`,
        name: "Loyalty DB Integration",
        slug: affiliateProgramId,
      },
    });
    await prisma.weleticShopifyStore.create({
      data: {
        id: storeId,
        projectId: workspaceId,
        programId: affiliateProgramId,
        shopDomain: `${RUN_ID}.myshopify.com`,
        shopCurrency: "USD",
        currencyVerifiedAt: new Date(),
        apiVersion: "2026-07",
      },
    });
    await prisma.weleticLoyaltyProgram.create({
      data: {
        id: loyaltyProgramId,
        storeId,
        status: "active",
      },
    });
    await prisma.weleticLoyaltyEarnPolicyRevision.create({
      data: {
        id: policyRevisionId,
        storeId,
        programId: loyaltyProgramId,
        version: 1,
        effectiveAt: new Date("2026-01-01T00:00:00.000Z"),
        snapshot: { pointsPerCurrencyUnit: "1.0" },
        fingerprint: "0".repeat(64),
        reason: "Database integration baseline",
      },
    });
    await prisma.weleticShopper.create({
      data: {
        id: shopperId,
        storeId,
        shopifyCustomerId: `customer_${RUN_ID}`,
      },
    });
    await prisma.weleticLoyaltyAccount.create({
      data: {
        id: accountId,
        storeId,
        programId: loyaltyProgramId,
        shopperId,
        cachedPointsBalance: INITIAL_BALANCE,
        lifetimePointsEarned: INITIAL_BALANCE,
      },
    });

    await prisma.weleticShopper.create({
      data: {
        id: raceShopperId,
        storeId,
        shopifyCustomerId: `race_customer_${RUN_ID}`,
      },
    });
    await prisma.weleticLoyaltyAccount.create({
      data: {
        id: raceAccountId,
        storeId,
        programId: loyaltyProgramId,
        shopperId: raceShopperId,
        cachedPendingPoints: BigInt(100),
      },
    });
    await prisma.weleticCommerceOrder.create({
      data: {
        id: raceOrderId,
        storeId,
        programId: affiliateProgramId,
        shopperId: raceShopperId,
        externalId: `race_order_external_${RUN_ID}`,
        orderName: `#RACE-${RUN_ID}`,
        status: "partially_refunded",
        presentmentCurrency: "USD",
        presentmentSubtotal: BigInt(10_000),
        presentmentNet: BigInt(10_000),
        presentmentTotal: BigInt(10_000),
        shopCurrency: "USD",
        shopSubtotal: BigInt(10_000),
        shopNet: BigInt(10_000),
        shopTotal: BigInt(10_000),
        accountingCurrency: "USD",
        accountingNet: BigInt(10_000),
        accountingTotal: BigInt(10_000),
        accountingFxRate: "1.0",
        occurredAt: new Date(),
      },
    });
    await prisma.weleticCommerceOrderLine.create({
      data: {
        id: raceOrderLineId,
        orderId: raceOrderId,
        externalId: `race_line_external_${RUN_ID}`,
        title: "Race fixture",
        quantity: 10,
        presentmentGross: BigInt(10_000),
        presentmentNet: BigInt(10_000),
        shopGross: BigInt(10_000),
        shopNet: BigInt(10_000),
        accountingNet: BigInt(10_000),
        commissionableAccountingAmount: BigInt(10_000),
      },
    });
    await prisma.weleticLoyaltyEarnGrant.create({
      data: {
        id: raceGrantId,
        storeId,
        programId: loyaltyProgramId,
        accountId: raceAccountId,
        shopperId: raceShopperId,
        orderId: raceOrderId,
        status: "pending",
        currency: "USD",
        eligibleSubtotalAmount: BigInt(10_000),
        orderTotalAmount: BigInt(10_000),
        grossPoints: BigInt(100),
        pendingPoints: BigInt(100),
        availableAt: new Date(Date.now() - 60_000),
        pointsPerCurrencyUnit: "1.0",
        effectiveMultiplier: "1.0",
      },
    });
    await prisma.weleticLoyaltyOrderLineEarn.create({
      data: {
        id: `race_line_earn_${RUN_ID}`,
        grantId: raceGrantId,
        orderLineId: raceOrderLineId,
        storeId,
        quantity: 10,
        lineNetAmount: BigInt(10_000),
        awardedPoints: BigInt(100),
      },
    });
    await prisma.weleticCommerceRefund.create({
      data: {
        id: raceRefundId,
        storeId,
        orderId: raceOrderId,
        externalId: `race_refund_external_${RUN_ID}`,
        presentmentCurrency: "USD",
        presentmentAmount: BigInt(4_000),
        shopCurrency: "USD",
        shopAmount: BigInt(4_000),
        accountingCurrency: "USD",
        accountingAmount: BigInt(4_000),
        accountingFxRate: "1.0",
        occurredAt: new Date(),
      },
    });
    await prisma.weleticCommerceRefundLine.create({
      data: {
        id: `race_refund_line_${RUN_ID}`,
        refundId: raceRefundId,
        orderLineId: raceOrderLineId,
        externalId: `race_refund_line_external_${RUN_ID}`,
        quantity: 4,
        presentmentAmount: BigInt(4_000),
        shopAmount: BigInt(4_000),
        accountingAmount: BigInt(4_000),
      },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("serializes distinct concurrent entries without lost updates", async () => {
    const writes = Array.from({ length: 8 }, (_, index) =>
      appendPointsLedgerEntry({
        storeId,
        accountId,
        entryType: WeleticPointsLedgerEntryType.EARN_BONUS,
        pointsDelta: BigInt(10),
        idempotencyKey: `db_concurrent:${RUN_ID}:${index}`,
        reason: "Real database concurrency verification",
      }),
    );

    await expect(Promise.all(writes)).resolves.toHaveLength(8);

    const [account, entries] = await Promise.all([
      prisma.weleticLoyaltyAccount.findUniqueOrThrow({
        where: { id: accountId },
      }),
      prisma.weleticPointsLedgerEntry.findMany({
        where: { accountId },
        orderBy: { sequenceNumber: "asc" },
      }),
    ]);

    expect(account.cachedPointsBalance).toBe(INITIAL_BALANCE + BigInt(80));
    expect(account.ledgerVersion).toBe(8);
    expect(entries.map((entry) => entry.sequenceNumber)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(entries.at(-1)?.balanceAfter).toBe(account.cachedPointsBalance);
  });

  it("deduplicates a concurrent idempotency burst to one financial mutation", async () => {
    const idempotencyKey = `db_duplicate:${RUN_ID}`;
    const writes = Array.from({ length: 12 }, () =>
      appendPointsLedgerEntry({
        storeId,
        accountId,
        entryType: WeleticPointsLedgerEntryType.MANUAL_ADJUSTMENT,
        pointsDelta: BigInt(-50),
        idempotencyKey,
        reason: "Real database idempotency verification",
      }),
    );

    const results = await Promise.all(writes);
    expect(new Set(results.map((entry) => entry.id)).size).toBe(1);

    const [account, matchingEntries, aggregate] = await Promise.all([
      prisma.weleticLoyaltyAccount.findUniqueOrThrow({
        where: { id: accountId },
      }),
      prisma.weleticPointsLedgerEntry.findMany({
        where: { storeId, idempotencyKey },
      }),
      prisma.weleticPointsLedgerEntry.aggregate({
        where: { accountId },
        _sum: { pointsDelta: true },
      }),
    ]);

    expect(matchingEntries).toHaveLength(1);
    expect(account.ledgerVersion).toBe(9);
    expect(account.cachedPointsBalance).toBe(INITIAL_BALANCE + BigInt(30));
    expect(aggregate._sum.pointsDelta).toBe(BigInt(30));
  });

  it("serializes holding release against a partial refund without resurrecting points", async () => {
    await expect(
      Promise.all([
        releaseHoldingPeriodGrant({ grantId: raceGrantId, storeId }),
        processRefundPointsReversal({ storeId, refundId: raceRefundId }),
      ]),
    ).resolves.toHaveLength(2);

    const [account, grant, lineEarn, entries] = await Promise.all([
      prisma.weleticLoyaltyAccount.findUniqueOrThrow({
        where: { id: raceAccountId },
      }),
      prisma.weleticLoyaltyEarnGrant.findUniqueOrThrow({
        where: { id: raceGrantId },
      }),
      prisma.weleticLoyaltyOrderLineEarn.findUniqueOrThrow({
        where: { id: `race_line_earn_${RUN_ID}` },
      }),
      prisma.weleticPointsLedgerEntry.findMany({
        where: { accountId: raceAccountId },
        orderBy: { sequenceNumber: "asc" },
      }),
    ]);

    expect(account.cachedPendingPoints).toBe(BigInt(0));
    expect(account.cachedPointsBalance).toBe(BigInt(60));
    expect(account.ledgerVersion).toBe(2);
    expect(grant.pendingPoints).toBe(BigInt(0));
    expect(grant.settledPoints).toBe(BigInt(60));
    expect(grant.reversedPoints).toBe(BigInt(40));
    expect(grant.status).toBe("partially_reversed");
    expect(lineEarn.reversedPoints).toBe(BigInt(40));
    expect(entries).toHaveLength(2);
    expect(
      entries.reduce((sum, entry) => sum + entry.pointsDelta, BigInt(0)),
    ).toBe(BigInt(60));
    expect(
      entries.reduce((sum, entry) => sum + entry.pendingDelta, BigInt(0)),
    ).toBe(BigInt(-100));
  });

  it("rolls back refund source state when cached pending points would underflow", async () => {
    await prisma.weleticShopper.create({
      data: {
        id: underflowShopperId,
        storeId,
        shopifyCustomerId: `underflow_customer_${RUN_ID}`,
      },
    });
    await prisma.weleticLoyaltyAccount.create({
      data: {
        id: underflowAccountId,
        storeId,
        programId: loyaltyProgramId,
        shopperId: underflowShopperId,
        cachedPendingPoints: BigInt(50),
      },
    });
    await prisma.weleticCommerceOrder.create({
      data: {
        id: underflowOrderId,
        storeId,
        programId: affiliateProgramId,
        shopperId: underflowShopperId,
        externalId: `underflow_order_external_${RUN_ID}`,
        orderName: `#UNDERFLOW-${RUN_ID}`,
        status: "refunded",
        presentmentCurrency: "USD",
        presentmentSubtotal: BigInt(10_000),
        presentmentNet: BigInt(10_000),
        presentmentTotal: BigInt(10_000),
        shopCurrency: "USD",
        shopSubtotal: BigInt(10_000),
        shopNet: BigInt(10_000),
        shopTotal: BigInt(10_000),
        accountingCurrency: "USD",
        accountingNet: BigInt(10_000),
        accountingTotal: BigInt(10_000),
        accountingFxRate: "1.0",
        occurredAt: new Date(),
      },
    });
    await prisma.weleticCommerceOrderLine.create({
      data: {
        id: underflowOrderLineId,
        orderId: underflowOrderId,
        externalId: `underflow_line_external_${RUN_ID}`,
        title: "Pending underflow fixture",
        quantity: 1,
        presentmentGross: BigInt(10_000),
        presentmentNet: BigInt(10_000),
        shopGross: BigInt(10_000),
        shopNet: BigInt(10_000),
        accountingNet: BigInt(10_000),
        commissionableAccountingAmount: BigInt(10_000),
      },
    });
    await prisma.weleticLoyaltyEarnGrant.create({
      data: {
        id: underflowGrantId,
        storeId,
        programId: loyaltyProgramId,
        accountId: underflowAccountId,
        shopperId: underflowShopperId,
        orderId: underflowOrderId,
        status: "pending",
        currency: "USD",
        eligibleSubtotalAmount: BigInt(10_000),
        orderTotalAmount: BigInt(10_000),
        grossPoints: BigInt(100),
        pendingPoints: BigInt(100),
        availableAt: new Date(Date.now() - 60_000),
        pointsPerCurrencyUnit: "1.0",
        effectiveMultiplier: "1.0",
      },
    });
    await prisma.weleticLoyaltyOrderLineEarn.create({
      data: {
        id: `underflow_line_earn_${RUN_ID}`,
        grantId: underflowGrantId,
        orderLineId: underflowOrderLineId,
        storeId,
        quantity: 1,
        lineNetAmount: BigInt(10_000),
        awardedPoints: BigInt(100),
      },
    });
    await prisma.weleticCommerceRefund.create({
      data: {
        id: underflowRefundId,
        storeId,
        orderId: underflowOrderId,
        externalId: `underflow_refund_external_${RUN_ID}`,
        presentmentCurrency: "USD",
        presentmentAmount: BigInt(10_000),
        shopCurrency: "USD",
        shopAmount: BigInt(10_000),
        accountingCurrency: "USD",
        accountingAmount: BigInt(10_000),
        accountingFxRate: "1.0",
        occurredAt: new Date(),
      },
    });
    await prisma.weleticCommerceRefundLine.create({
      data: {
        id: `underflow_refund_line_${RUN_ID}`,
        refundId: underflowRefundId,
        orderLineId: underflowOrderLineId,
        externalId: `underflow_refund_line_external_${RUN_ID}`,
        quantity: 1,
        presentmentAmount: BigInt(10_000),
        shopAmount: BigInt(10_000),
        accountingAmount: BigInt(10_000),
      },
    });

    await expect(
      processRefundPointsReversal({ storeId, refundId: underflowRefundId }),
    ).rejects.toThrow("Pending-points invariant failed");

    const [account, grant, lineEarn, ledgerEntry, outboxJob] =
      await Promise.all([
        prisma.weleticLoyaltyAccount.findUniqueOrThrow({
          where: { id: underflowAccountId },
        }),
        prisma.weleticLoyaltyEarnGrant.findUniqueOrThrow({
          where: { id: underflowGrantId },
        }),
        prisma.weleticLoyaltyOrderLineEarn.findUniqueOrThrow({
          where: { id: `underflow_line_earn_${RUN_ID}` },
        }),
        prisma.weleticPointsLedgerEntry.findUnique({
          where: {
            storeId_idempotencyKey: {
              storeId,
              idempotencyKey: `refund_reversal:${underflowRefundId}`,
            },
          },
        }),
        prisma.weleticLoyaltyOutboxJob.findUnique({
          where: {
            storeId_idempotencyKey: {
              storeId,
              idempotencyKey: `metafield_sync:refund:${underflowRefundId}`,
            },
          },
        }),
      ]);

    expect(account.cachedPendingPoints).toBe(BigInt(50));
    expect(account.ledgerVersion).toBe(0);
    expect(grant.status).toBe("pending");
    expect(grant.pendingPoints).toBe(BigInt(100));
    expect(grant.reversedPoints).toBe(BigInt(0));
    expect(lineEarn.reversedPoints).toBe(BigInt(0));
    expect(ledgerEntry).toBeNull();
    expect(outboxJob).toBeNull();

    // Repair the deliberately inconsistent cached bucket, then exercise the
    // fail-closed holding path against real MySQL. The grant, line snapshot,
    // account bucket, ledger, and outbox must commit as one conserved unit.
    await prisma.weleticLoyaltyAccount.update({
      where: { id: underflowAccountId },
      data: { cachedPendingPoints: BigInt(100) },
    });
    await expect(
      releaseHoldingPeriodGrant({ grantId: underflowGrantId, storeId }),
    ).resolves.toEqual({
      released: false,
      reason: "order_refunded",
      grantId: underflowGrantId,
    });

    const [voidedAccount, voidedGrant, voidedLineEarn, holdingVoidEntry] =
      await Promise.all([
        prisma.weleticLoyaltyAccount.findUniqueOrThrow({
          where: { id: underflowAccountId },
        }),
        prisma.weleticLoyaltyEarnGrant.findUniqueOrThrow({
          where: { id: underflowGrantId },
        }),
        prisma.weleticLoyaltyOrderLineEarn.findUniqueOrThrow({
          where: { id: `underflow_line_earn_${RUN_ID}` },
        }),
        prisma.weleticPointsLedgerEntry.findUniqueOrThrow({
          where: {
            storeId_idempotencyKey: {
              storeId,
              idempotencyKey: `holding_void:${underflowOrderId}`,
            },
          },
        }),
      ]);

    expect(voidedAccount.cachedPendingPoints).toBe(BigInt(0));
    expect(voidedAccount.ledgerVersion).toBe(1);
    expect(voidedGrant.status).toBe("voided");
    expect(voidedGrant.pendingPoints).toBe(BigInt(0));
    expect(voidedGrant.reversedPoints).toBe(BigInt(100));
    expect(voidedLineEarn.reversedPoints).toBe(BigInt(100));
    expect(voidedLineEarn.reversedPoints).toBe(voidedGrant.reversedPoints);
    expect(holdingVoidEntry.pendingDelta).toBe(BigInt(-100));
    expect(holdingVoidEntry.pointsDelta).toBe(BigInt(0));
  });

  it("admits only one of two real concurrent referrals into the advocate's final cap slot", async () => {
    const advocateShopperId = `cap_advocate_shopper_${RUN_ID}`;
    const advocateAccountId = `cap_advocate_account_${RUN_ID}`;
    const ruleId = `cap_rule_${RUN_ID}`;
    const refereeFixtures = [1, 2].map((index) => ({
      shopperId: `cap_referee_shopper_${index}_${RUN_ID}`,
      accountId: `cap_referee_account_${index}_${RUN_ID}`,
      referralId: `cap_referral_${index}_${RUN_ID}`,
      orderId: `cap_order_${index}_${RUN_ID}`,
      customerId: `cap_customer_${index}_${RUN_ID}`,
    }));

    await prisma.weleticShopper.create({
      data: {
        id: advocateShopperId,
        storeId,
        shopifyCustomerId: `cap_advocate_customer_${RUN_ID}`,
      },
    });
    await prisma.weleticLoyaltyAccount.create({
      data: {
        id: advocateAccountId,
        storeId,
        programId: loyaltyProgramId,
        shopperId: advocateShopperId,
      },
    });
    await prisma.weleticLoyaltyReferralRule.create({
      data: {
        id: ruleId,
        programId: loyaltyProgramId,
        advocatePointsReward: BigInt(10),
        refereePointsReward: BigInt(5),
        maxReferralsPerAdvocate: 1,
        isActive: true,
      },
    });

    for (const fixture of refereeFixtures) {
      await prisma.weleticShopper.create({
        data: {
          id: fixture.shopperId,
          storeId,
          shopifyCustomerId: fixture.customerId,
        },
      });
      await prisma.weleticLoyaltyAccount.create({
        data: {
          id: fixture.accountId,
          storeId,
          programId: loyaltyProgramId,
          shopperId: fixture.shopperId,
          referredById: advocateAccountId,
        },
      });
      await prisma.weleticLoyaltyReferral.create({
        data: {
          id: fixture.referralId,
          storeId,
          advocateAccountId,
          refereeShopperId: fixture.shopperId,
          refereeAccountId: fixture.accountId,
          status: WeleticLoyaltyReferralStatus.pending,
        },
      });
    }

    const results = await Promise.all(
      refereeFixtures.map((fixture) =>
        evaluateReferralQualification({
          storeId,
          orderId: fixture.orderId,
          refereeShopperId: fixture.shopperId,
          orderSubtotal: BigInt(10_000),
          currency: "USD",
        }),
      ),
    );

    const [advocate, referrals] = await Promise.all([
      prisma.weleticLoyaltyAccount.findUniqueOrThrow({
        where: { id: advocateAccountId },
      }),
      prisma.weleticLoyaltyReferral.findMany({
        where: {
          id: { in: refereeFixtures.map(({ referralId }) => referralId) },
        },
      }),
    ]);

    expect(results.filter((result) => result.qualified)).toHaveLength(1);
    expect(
      results.filter(
        (result) =>
          !result.qualified &&
          result.reason ===
            "Advocate has reached the maximum allowed referrals.",
      ),
    ).toHaveLength(1);
    expect(advocate.referralCount).toBe(1);
    expect(
      referrals.filter(
        ({ status }) => status === WeleticLoyaltyReferralStatus.rewarded,
      ),
    ).toHaveLength(1);
    expect(
      referrals.filter(
        ({ status }) => status === WeleticLoyaltyReferralStatus.pending,
      ),
    ).toHaveLength(1);
  });

  it("credits one order exactly once across overlapping backfill transactions and remains refund-safe", async () => {
    const overlapShopperId = `backfill_overlap_shopper_${RUN_ID}`;
    const overlapAccountId = `backfill_overlap_account_${RUN_ID}`;
    const overlapOrderId = `backfill_overlap_order_${RUN_ID}`;
    const overlapOrderLineId = `backfill_overlap_line_${RUN_ID}`;

    await prisma.weleticShopper.create({
      data: {
        id: overlapShopperId,
        storeId,
        shopifyCustomerId: `backfill_overlap_customer_${RUN_ID}`,
      },
    });
    await prisma.weleticLoyaltyAccount.create({
      data: {
        id: overlapAccountId,
        storeId,
        programId: loyaltyProgramId,
        shopperId: overlapShopperId,
      },
    });
    await prisma.weleticCommerceOrder.create({
      data: {
        id: overlapOrderId,
        storeId,
        programId: affiliateProgramId,
        shopperId: overlapShopperId,
        externalId: `backfill_overlap_external_${RUN_ID}`,
        status: "paid",
        presentmentCurrency: "USD",
        presentmentSubtotal: BigInt(10_000),
        presentmentNet: BigInt(10_000),
        presentmentTotal: BigInt(10_000),
        shopCurrency: "USD",
        shopSubtotal: BigInt(10_000),
        shopNet: BigInt(10_000),
        shopTotal: BigInt(10_000),
        accountingCurrency: "USD",
        accountingNet: BigInt(10_000),
        accountingTotal: BigInt(10_000),
        accountingFxRate: "1.0",
        occurredAt: new Date(),
      },
    });
    await prisma.weleticCommerceOrderLine.create({
      data: {
        id: overlapOrderLineId,
        orderId: overlapOrderId,
        externalId: `backfill_overlap_line_external_${RUN_ID}`,
        title: "Backfill overlap fixture",
        quantity: 10,
        presentmentGross: BigInt(10_000),
        presentmentNet: BigInt(10_000),
        shopGross: BigInt(10_000),
        shopNet: BigInt(10_000),
        accountingNet: BigInt(10_000),
        commissionableAccountingAmount: BigInt(10_000),
      },
    });

    const [firstJob, secondJob] = await Promise.all([
      createBackfillJob({ storeId, lookbackDays: 30 }),
      createBackfillJob({ storeId, lookbackDays: 30 }),
    ]);
    await Promise.all([
      generateBackfillPreview(firstJob.id),
      generateBackfillPreview(secondJob.id),
    ]);
    await Promise.all([
      commitBackfillJob(firstJob.id),
      commitBackfillJob(secondJob.id),
    ]);

    const [account, credits, grants, ledgers, lineEarns] = await Promise.all([
      prisma.weleticLoyaltyAccount.findUniqueOrThrow({
        where: { id: overlapAccountId },
      }),
      prisma.weleticLoyaltyBackfillOrderCredit.findMany({
        where: { storeId, orderId: overlapOrderId },
      }),
      prisma.weleticLoyaltyEarnGrant.findMany({
        where: { storeId, orderId: overlapOrderId },
      }),
      prisma.weleticPointsLedgerEntry.findMany({
        where: {
          storeId,
          referenceType: "historical_order",
          referenceId: overlapOrderId,
        },
      }),
      prisma.weleticLoyaltyOrderLineEarn.findMany({
        where: { orderLineId: overlapOrderLineId },
      }),
    ]);

    expect(credits).toHaveLength(1);
    expect(grants).toHaveLength(1);
    expect(ledgers).toHaveLength(1);
    expect(lineEarns).toHaveLength(1);
    expect(account.cachedPointsBalance).toBe(BigInt(100));
    expect(lineEarns[0].awardedPoints).toBe(BigInt(100));

    const refundId = `backfill_overlap_refund_${RUN_ID}`;
    await prisma.weleticCommerceRefund.create({
      data: {
        id: refundId,
        storeId,
        orderId: overlapOrderId,
        externalId: `backfill_overlap_refund_external_${RUN_ID}`,
        presentmentCurrency: "USD",
        presentmentAmount: BigInt(4_000),
        shopCurrency: "USD",
        shopAmount: BigInt(4_000),
        accountingCurrency: "USD",
        accountingAmount: BigInt(4_000),
        accountingFxRate: "1.0",
        occurredAt: new Date(),
        lines: {
          create: {
            id: `backfill_overlap_refund_line_${RUN_ID}`,
            orderLineId: overlapOrderLineId,
            externalId: `backfill_overlap_refund_line_external_${RUN_ID}`,
            quantity: 4,
            presentmentAmount: BigInt(4_000),
            shopAmount: BigInt(4_000),
            accountingAmount: BigInt(4_000),
          },
        },
      },
    });
    await processRefundPointsReversal({ storeId, refundId });

    const afterRefund = await prisma.weleticLoyaltyAccount.findUniqueOrThrow({
      where: { id: overlapAccountId },
    });
    expect(afterRefund.cachedPointsBalance).toBe(BigInt(60));
  });

  it("repairs an aggregate legacy job with append-only reversal, per-order replay, and later refund", async () => {
    const repairShopperId = `backfill_repair_shopper_${RUN_ID}`;
    const repairAccountId = `backfill_repair_account_${RUN_ID}`;
    const sourceJobId = `backfill_repair_source_${RUN_ID}`;
    const orderFixtures = [0, 1].map((index) => ({
      orderId: `backfill_repair_order_${index}_${RUN_ID}`,
      orderLineId: `backfill_repair_line_${index}_${RUN_ID}`,
      orderExternalId: `backfill_repair_order_external_${index}_${RUN_ID}`,
      lineExternalId: `backfill_repair_line_external_${index}_${RUN_ID}`,
    }));

    await prisma.weleticShopper.create({
      data: {
        id: repairShopperId,
        storeId,
        shopifyCustomerId: `backfill_repair_customer_${RUN_ID}`,
      },
    });
    await prisma.weleticLoyaltyAccount.create({
      data: {
        id: repairAccountId,
        storeId,
        programId: loyaltyProgramId,
        shopperId: repairShopperId,
      },
    });
    await prisma.weleticLoyaltyBackfillJob.create({
      data: {
        id: sourceJobId,
        storeId,
        programId: loyaltyProgramId,
        status: "completed",
        lookbackDays: 30,
        pointsPerCurrencyUnit: "1.0",
        totalShoppersCount: 1,
        totalOrdersCount: 2,
        totalProjectedPoints: BigInt(200),
        processedAccountsCount: 1,
        totalCommittedPoints: BigInt(200),
        metadata: {
          installationGeneration: null,
          policyVersion: 1,
          policyRevisionId,
        },
        completedAt: new Date(),
      },
    });

    for (const [index, fixture] of orderFixtures.entries()) {
      await prisma.weleticCommerceOrder.create({
        data: {
          id: fixture.orderId,
          storeId,
          programId: affiliateProgramId,
          shopperId: repairShopperId,
          externalId: fixture.orderExternalId,
          status: "paid",
          presentmentCurrency: "USD",
          presentmentSubtotal: BigInt(10_000),
          presentmentNet: BigInt(10_000),
          presentmentTotal: BigInt(10_000),
          shopCurrency: "USD",
          shopSubtotal: BigInt(10_000),
          shopNet: BigInt(10_000),
          shopTotal: BigInt(10_000),
          accountingCurrency: "USD",
          accountingNet: BigInt(10_000),
          accountingTotal: BigInt(10_000),
          accountingFxRate: "1.0",
          occurredAt: new Date(Date.now() - (index + 1) * 60_000),
        },
      });
      await prisma.weleticCommerceOrderLine.create({
        data: {
          id: fixture.orderLineId,
          orderId: fixture.orderId,
          externalId: fixture.lineExternalId,
          title: `Backfill repair fixture ${index}`,
          quantity: 10,
          presentmentGross: BigInt(10_000),
          presentmentNet: BigInt(10_000),
          shopGross: BigInt(10_000),
          shopNet: BigInt(10_000),
          accountingNet: BigInt(10_000),
          commissionableAccountingAmount: BigInt(10_000),
        },
      });
      await prisma.weleticLoyaltyEarnGrant.create({
        data: {
          id: `backfill_repair_bad_grant_${index}_${RUN_ID}`,
          storeId,
          programId: loyaltyProgramId,
          accountId: repairAccountId,
          shopperId: repairShopperId,
          orderId: fixture.orderId,
          status: "settled",
          currency: "USD",
          eligibleSubtotalAmount: BigInt(20_000),
          orderTotalAmount: BigInt(10_000),
          grossPoints: BigInt(200),
          settledPoints: BigInt(200),
          availableAt: new Date(),
          settledAt: new Date(),
          pointsPerCurrencyUnit: "1.0",
          effectiveMultiplier: "1.0",
          policyRevisionId,
          metadata: { jobId: sourceJobId },
        },
      });
    }

    const legacyLedger = await appendPointsLedgerEntry({
      storeId,
      accountId: repairAccountId,
      entryType: WeleticPointsLedgerEntryType.BACKFILL,
      pointsDelta: BigInt(200),
      referenceType: "backfill_job",
      referenceId: sourceJobId,
      idempotencyKey: `legacy_backfill:${sourceJobId}`,
      reason: "Legacy account aggregate fixture",
    });
    const before = await auditHistoricalBackfill({ storeId });
    expect(before.totals).toMatchObject({ repairable: 1, unresolved: 0 });

    const repaired = await repairHistoricalBackfillStore(storeId);
    expect(repaired.report.totals).toMatchObject({
      repairable: 0,
      replayPending: 0,
      repaired: 1,
      unresolved: 0,
    });

    const [account, correction, replayLedgers, grants, lineEarns] =
      await Promise.all([
        prisma.weleticLoyaltyAccount.findUniqueOrThrow({
          where: { id: repairAccountId },
        }),
        prisma.weleticPointsLedgerEntry.findUniqueOrThrow({
          where: {
            storeId_idempotencyKey: {
              storeId,
              idempotencyKey: `backfill:correction:${legacyLedger.id}`,
            },
          },
        }),
        prisma.weleticPointsLedgerEntry.findMany({
          where: {
            storeId,
            accountId: repairAccountId,
            referenceType: "historical_order",
          },
        }),
        prisma.weleticLoyaltyEarnGrant.findMany({
          where: { storeId, accountId: repairAccountId },
          orderBy: { orderId: "asc" },
        }),
        prisma.weleticLoyaltyOrderLineEarn.findMany({
          where: { storeId, grant: { accountId: repairAccountId } },
        }),
      ]);
    expect(correction).toMatchObject({
      entryType: WeleticPointsLedgerEntryType.BACKFILL_CORRECTION,
      pointsDelta: BigInt(-200),
      referenceId: legacyLedger.id,
    });
    expect(replayLedgers).toHaveLength(2);
    expect(grants).toHaveLength(2);
    expect(grants.every(({ grossPoints }) => grossPoints === BigInt(100))).toBe(
      true,
    );
    expect(
      grants.every(
        ({ metadata }) =>
          metadata &&
          typeof metadata === "object" &&
          !Array.isArray(metadata) &&
          metadata.repairVoided === true &&
          metadata.repairedFromLegacyBackfillJobId === sourceJobId,
      ),
    ).toBe(true);
    expect(lineEarns).toHaveLength(2);
    expect(account.cachedPointsBalance).toBe(BigInt(200));
    expect(account.lifetimePointsEarned).toBe(BigInt(200));

    const repairJobId = repaired.repairJobs[0];
    await prisma.weleticLoyaltyBackfillJob.update({
      where: { id: repairJobId },
      data: { status: "failed", completedAt: null },
    });
    const interrupted = await auditHistoricalBackfill({ storeId });
    expect(interrupted.totals).toMatchObject({
      replayPending: 1,
      unresolved: 0,
    });
    const resumed = await repairHistoricalBackfillStore(storeId);
    expect(resumed.report.totals).toMatchObject({
      repairable: 0,
      replayPending: 0,
      repaired: 1,
      unresolved: 0,
    });
    const [correctionCount, replayLedgerCount, resumedAccount] =
      await Promise.all([
        prisma.weleticPointsLedgerEntry.count({
          where: {
            storeId,
            idempotencyKey: `backfill:correction:${legacyLedger.id}`,
          },
        }),
        prisma.weleticPointsLedgerEntry.count({
          where: {
            storeId,
            accountId: repairAccountId,
            referenceType: "historical_order",
          },
        }),
        prisma.weleticLoyaltyAccount.findUniqueOrThrow({
          where: { id: repairAccountId },
        }),
      ]);
    expect(correctionCount).toBe(1);
    expect(replayLedgerCount).toBe(2);
    expect(resumedAccount.cachedPointsBalance).toBe(BigInt(200));
    expect(resumedAccount.lifetimePointsEarned).toBe(BigInt(200));

    const refundFixture = orderFixtures[0];
    const refundId = `backfill_repair_refund_${RUN_ID}`;
    await prisma.weleticCommerceRefund.create({
      data: {
        id: refundId,
        storeId,
        orderId: refundFixture.orderId,
        externalId: `backfill_repair_refund_external_${RUN_ID}`,
        presentmentCurrency: "USD",
        presentmentAmount: BigInt(5_000),
        shopCurrency: "USD",
        shopAmount: BigInt(5_000),
        accountingCurrency: "USD",
        accountingAmount: BigInt(5_000),
        accountingFxRate: "1.0",
        occurredAt: new Date(),
        lines: {
          create: {
            id: `backfill_repair_refund_line_${RUN_ID}`,
            orderLineId: refundFixture.orderLineId,
            externalId: `backfill_repair_refund_line_external_${RUN_ID}`,
            quantity: 5,
            presentmentAmount: BigInt(5_000),
            shopAmount: BigInt(5_000),
            accountingAmount: BigInt(5_000),
          },
        },
      },
    });
    await processRefundPointsReversal({ storeId, refundId });
    const afterRefund = await prisma.weleticLoyaltyAccount.findUniqueOrThrow({
      where: { id: repairAccountId },
    });
    expect(afterRefund.cachedPointsBalance).toBe(BigInt(150));
    expect(afterRefund.lifetimePointsEarned).toBe(BigInt(200));

    const validation = await runHistoricalBackfillValidation({
      store: storeId,
    });
    expect(validation.readyToEnableCommits).toBe(true);
    expect(validation.checks).toEqual({
      incompleteCreditClaims: 0,
      inconsistentCreditArtifacts: 0,
      lifetimeEarnedDrift: 0,
      legacyRepairable: 0,
      legacyReplayPending: 0,
      legacyUnresolved: 0,
    });
  });
});
