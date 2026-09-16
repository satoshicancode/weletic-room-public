import { prisma } from "@/lib/prisma";
import {
  processOrderPointsEarn,
  processRefundPointsReversal,
} from "@/lib/weletic/loyalty/earn";
import { publishLoyaltyEarnPolicyRevision } from "@/lib/weletic/loyalty/earn-policy-revision";
import { releaseHoldingPeriodGrant } from "@/lib/weletic/loyalty/holding-period";
import { appendPointsLedgerEntry } from "@/lib/weletic/loyalty/ledger";
import {
  assertActiveLoyaltyAccountForMutation,
  withActiveStoreLoyaltyMutation,
} from "@/lib/weletic/loyalty/merchant-write-fence";
import {
  handleBirthdayReward,
  handleInactivityExpiry,
} from "@/lib/weletic/loyalty/outbox-worker";
import { upsertWeleticShopper } from "@/lib/weletic/loyalty/shopper";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

// Only non-accounting infrastructure is stubbed; every financial operation and
// transaction below uses real Prisma/MySQL. No outbox delivery worker is run.
vi.mock("@/lib/api/links/cache", () => ({ linkCache: {} }));
vi.mock("@/lib/axiom/server", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), flush: vi.fn() },
}));

const stores: string[] = [];
const epoch = new Date("2026-09-16T00:00:00.000Z");
let verified = false;
beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL || "invalid:");
  if (
    process.env.POINTS_ACCOUNTING_DATABASE_INTEGRATION !== "1" ||
    url.protocol !== "mysql:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "3307" ||
    url.username !== "loyalty_dev" ||
    !/^\/weletic_loyalty_it_points_[a-z0-9_]+$/.test(url.pathname)
  ) {
    throw new Error("Refusing non-isolated points acceptance database");
  }
  expect(
    await prisma.$queryRaw`SELECT DATABASE() AS name, CURRENT_USER() AS principal`,
  ).toEqual([{ name: url.pathname.slice(1), principal: "loyalty_dev@%" }]);
  expect(await prisma.weleticShopifyStore.count()).toBe(0);
  expect(await prisma.weleticLoyaltyAccount.count()).toBe(0);
  expect(await prisma.weleticPointsLedgerEntry.count()).toBe(0);
  verified = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("External fetch forbidden in points acceptance");
    }),
  );
  vi.stubEnv(
    "WELETIC_SHOPIFY_PRIVACY_HMAC_KEYS",
    `points:${Buffer.alloc(32, 1).toString("base64")}`,
  );
  vi.useFakeTimers({ toFake: ["Date"] });
});
beforeEach(() => vi.setSystemTime(epoch));
afterAll(async () => {
  if (verified && stores.length) {
    // Delete only this run's exact fixtures, never reset/drop a retained schema.
    const ids = Prisma.join(stores);
    await prisma.$executeRaw(
      Prisma.sql`DELETE FROM WeleticCommerceRefundLine WHERE refundId IN (SELECT id FROM WeleticCommerceRefund WHERE storeId IN (${ids}))`,
    );
    await prisma.$executeRaw(
      Prisma.sql`DELETE FROM WeleticCommerceOrderLine WHERE orderId IN (SELECT id FROM WeleticCommerceOrder WHERE storeId IN (${ids}))`,
    );
    await prisma.$executeRaw(
      Prisma.sql`DELETE FROM WeleticLoyaltyEarningRule WHERE programId IN (${ids})`,
    );
    const tables = await prisma.$queryRaw<
      Array<{ name: string }>
    >`SELECT TABLE_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'storeId'`;
    for (const { name } of tables) {
      if (!/^Weletic[A-Za-z0-9]+$/.test(name))
        throw new Error("Unexpected fixture table");
      await prisma.$executeRaw(
        Prisma.sql`DELETE FROM ${Prisma.raw(`\`${name}\``)} WHERE storeId IN (${ids})`,
      );
    }
    for (const name of ["WeleticShopifyStore", "Program", "Project"]) {
      await prisma.$executeRaw(
        Prisma.sql`DELETE FROM ${Prisma.raw(`\`${name}\``)} WHERE id IN (${ids})`,
      );
    }
    expect(await prisma.weleticShopifyStore.count()).toBe(0);
    expect(await prisma.weleticLoyaltyAccount.count()).toBe(0);
    expect(await prisma.weleticPointsLedgerEntry.count()).toBe(0);
    expect(await prisma.weleticLoyaltyEarnGrant.count()).toBe(0);
    expect(await prisma.weleticLoyaltyOutboxJob.count()).toBe(0);
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await prisma.$disconnect();
});

async function seed(holdingPeriodDays = 0, signup = BigInt("0")) {
  const id = `points-${randomUUID()}`;
  stores.push(id);
  await prisma.project.create({
    data: {
      id,
      name: "Synthetic points acceptance",
      slug: id,
      billingCycleStart: 1,
    },
  });
  await prisma.program.create({
    data: {
      id,
      workspaceId: id,
      name: "Synthetic",
      slug: id,
      defaultFolderId: id,
      defaultGroupId: id,
    },
  });
  await prisma.weleticShopifyStore.create({
    data: {
      id,
      projectId: id,
      programId: id,
      shopDomain: `${id}.myshopify.com`,
      shopCurrency: "USD",
      currencyVerifiedAt: epoch,
      apiVersion: "2026-07",
      storeAccessState: "active",
      complianceState: "active",
      installationGeneration: "g1",
    },
  });
  await prisma.weleticLoyaltyProgram.create({
    data: {
      id,
      storeId: id,
      status: "active",
      pointsPerCurrencyUnit: "1",
      holdingPeriodDays,
      pointsExpiryDays: 7,
      pointsExpiryPolicyVersion: 1,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    },
  });
  await prisma.weleticLoyaltyEarningRule.create({
    data: {
      id: `purchase-${id}`,
      programId: id,
      name: "Purchase",
      triggerCode: "order_paid",
      ruleType: "multiplier",
      multiplier: "1",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    },
  });
  if (signup)
    await prisma.weleticLoyaltyEarningRule.create({
      data: {
        id: `signup-${id}`,
        programId: id,
        name: "Signup",
        triggerCode: "account_created",
        ruleType: "fixed_points",
        fixedPoints: signup,
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
    });
  await prisma.$transaction((tx) =>
    publishLoyaltyEarnPolicyRevision({
      tx,
      storeId: id,
      programId: id,
      effectiveAt: new Date("2026-01-02T00:00:00Z"),
      reason: "Synthetic acceptance policy",
    }),
  );
  const enroll = () =>
    upsertWeleticShopper({
      storeId: id,
      expectedInstallationGeneration: "g1",
      customer: { id: "123", email: "synthetic@example.test" },
    });
  const enrolled = await enroll();
  if (!enrolled?.loyaltyAccount) throw new Error("Fixture enrollment failed");
  return {
    id,
    storeId: id,
    accountId: enrolled.loyaltyAccount.id,
    shopperId: enrolled.shopper.id,
    enroll,
    expectedInstallationGeneration: "g1",
  };
}
type Fixture = Awaited<ReturnType<typeof seed>>;

async function order(f: Fixture, amounts = [BigInt("6000"), BigInt("4000")]) {
  const id = randomUUID();
  const total = amounts.reduce((sum, amount) => sum + amount, BigInt("0"));
  await prisma.weleticCommerceOrder.create({
    data: {
      id,
      storeId: f.id,
      programId: f.id,
      shopperId: f.shopperId,
      externalId: id,
      orderName: "#SYNTHETIC",
      status: "paid",
      presentmentCurrency: "USD",
      presentmentSubtotal: total,
      presentmentNet: total,
      presentmentTotal: total,
      shopCurrency: "USD",
      shopSubtotal: total,
      shopNet: total,
      shopTotal: total,
      accountingCurrency: "USD",
      accountingNet: total,
      accountingTotal: total,
      accountingFxRate: "1",
      occurredAt: epoch,
      lines: {
        create: amounts.map((amount, i) => ({
          id: `${id}-${i}`,
          externalId: `${i}`,
          title: "Synthetic",
          quantity: 2,
          presentmentGross: amount,
          presentmentNet: amount,
          shopGross: amount,
          shopNet: amount,
          accountingNet: amount,
          commissionableAccountingAmount: amount,
        })),
      },
    },
  });
  return id;
}
const earn = (f: Fixture, orderId: string) =>
  processOrderPointsEarn({
    storeId: f.id,
    orderId,
    expectedInstallationGeneration: "g1",
  });
async function refund(
  f: Fixture,
  orderId: string,
  amounts: Array<[number, bigint]>,
) {
  const id = randomUUID();
  const amount = amounts.reduce((sum, [, value]) => sum + value, BigInt("0"));
  await prisma.weleticCommerceRefund.create({
    data: {
      id,
      storeId: f.id,
      orderId,
      externalId: id,
      presentmentCurrency: "USD",
      presentmentAmount: amount,
      shopCurrency: "USD",
      shopAmount: amount,
      accountingCurrency: "USD",
      accountingAmount: amount,
      accountingFxRate: "1",
      occurredAt: new Date(),
      lines: {
        create: amounts.map(([line, value]) => ({
          id: `${id}-${line}`,
          orderLineId: `${orderId}-${line}`,
          externalId: `${line}`,
          quantity: 1,
          presentmentAmount: value,
          shopAmount: value,
          accountingAmount: value,
        })),
      },
    },
  });
  return id;
}
const reverse = (f: Fixture, refundId: string) =>
  processRefundPointsReversal({
    storeId: f.id,
    refundId,
    expectedInstallationGeneration: "g1",
  });
const mature = (f: Fixture, grantId: string) =>
  releaseHoldingPeriodGrant({
    storeId: f.id,
    grantId,
    expectedInstallationGeneration: "g1",
  });
async function manual(f: Fixture, pointsDelta: bigint, key: string) {
  return withActiveStoreLoyaltyMutation({
    storeId: f.id,
    expectedInstallationGeneration: f.expectedInstallationGeneration,
    action: "points_acceptance_manual",
    operation: async (tx) => {
      await assertActiveLoyaltyAccountForMutation({
        tx,
        storeId: f.id,
        accountId: f.accountId,
      });
      return appendPointsLedgerEntry({
        storeId: f.id,
        accountId: f.accountId,
        entryType: "MANUAL_ADJUSTMENT",
        pointsDelta,
        idempotencyKey: key,
        reason: "Synthetic authorized operator adjustment",
        tx,
      });
    },
  });
}
async function balance(f: Fixture, available: bigint, pending = BigInt("0")) {
  const row = await prisma.weleticLoyaltyAccount.findUniqueOrThrow({
    where: { id: f.accountId },
  });
  expect(row.cachedPointsBalance).toBe(available);
  expect(row.cachedPendingPoints).toBe(pending);
  expect(await discrepancies(f)).toEqual([]);
  expect(await ledgerDiscrepancies(f)).toEqual([]);
}

async function ledgerDiscrepancies(f: Fixture) {
  return prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM (
      SELECT id, balanceAfter, sequenceNumber,
        SUM(pointsDelta) OVER (PARTITION BY accountId ORDER BY sequenceNumber ROWS UNBOUNDED PRECEDING) expectedBalance,
        ROW_NUMBER() OVER (PARTITION BY accountId ORDER BY sequenceNumber) expectedSequence
      FROM WeleticPointsLedgerEntry WHERE storeId = ${f.id}
    ) history WHERE balanceAfter <> expectedBalance OR sequenceNumber <> expectedSequence`);
}

// Independent SQL oracle: no production reconciliation helpers or auto-repair.
// Pending credits are grant-driven, not the SUM of ledger.pendingDelta.
async function discrepancies(f: Fixture) {
  return prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT a.id FROM WeleticLoyaltyAccount a
    LEFT JOIN (
      SELECT accountId, SUM(pointsDelta) balance, COUNT(*) entries, MAX(sequenceNumber) sequence,
        SUM(CASE WHEN entryType IN ('EARN_ORDER','EARN_REFERRAL','EARN_BONUS','BACKFILL','TIER_BONUS') AND pointsDelta > 0 THEN pointsDelta
          WHEN (entryType = 'BACKFILL_CORRECTION' OR (entryType = 'REFUND_REVERSAL' AND referenceType = 'REVIEW_INCENTIVE_REVERSAL')) AND pointsDelta < 0 THEN pointsDelta ELSE 0 END) earned,
        SUM(CASE WHEN entryType = 'REDEEM_REWARD' AND pointsDelta < 0 THEN -pointsDelta ELSE 0 END) redeemed
      FROM WeleticPointsLedgerEntry WHERE storeId = ${f.id} GROUP BY accountId
    ) l ON l.accountId = a.id
    LEFT JOIN (SELECT accountId, SUM(pendingPoints) pending FROM WeleticLoyaltyEarnGrant WHERE storeId = ${f.id} GROUP BY accountId) g ON g.accountId = a.id
    WHERE a.storeId = ${f.id} AND (
      a.cachedPointsBalance <> COALESCE(l.balance, 0) OR a.cachedPendingPoints <> COALESCE(g.pending, 0)
      OR a.lifetimePointsEarned <> COALESCE(l.earned, 0) OR a.lifetimePointsRedeemed <> COALESCE(l.redeemed, 0)
      OR a.ledgerVersion <> COALESCE(l.entries, 0) OR a.ledgerVersion <> COALESCE(l.sequence, 0)
    )`);
}
async function conserved(f: Fixture) {
  expect(
    await prisma.$queryRaw(
      Prisma.sql`SELECT id FROM WeleticLoyaltyEarnGrant WHERE storeId = ${f.id} AND (grossPoints <> pendingPoints + settledPoints + reversedPoints OR pendingPoints < 0 OR settledPoints < 0 OR reversedPoints < 0)`,
    ),
  ).toEqual([]);
  expect(
    await prisma.$queryRaw(
      Prisma.sql`SELECT g.id FROM WeleticLoyaltyEarnGrant g LEFT JOIN WeleticLoyaltyOrderLineEarn l ON l.grantId = g.id WHERE g.storeId = ${f.id} GROUP BY g.id, g.grossPoints, g.reversedPoints HAVING COALESCE(SUM(l.awardedPoints), 0) <> g.grossPoints OR COALESCE(SUM(l.reversedPoints), 0) <> g.reversedPoints`,
    ),
  ).toEqual([]);
}

it("P01: purchase multi-line earn, duplicate delivery and partial/full refund conserve points", async () => {
  const f = await seed();
  const id = await order(f);
  await Promise.all([earn(f, id), earn(f, id)]);
  await balance(f, BigInt("100"));
  await conserved(f);
  const partial = await refund(f, id, [[0, BigInt("3000")]]);
  await Promise.all([reverse(f, partial), reverse(f, partial)]);
  await balance(f, BigInt("70"));
  await conserved(f);
  const full = await refund(f, id, [
    [0, BigInt("3000")],
    [1, BigInt("4000")],
  ]);
  await reverse(f, full);
  await reverse(f, full);
  await earn(f, id);
  await balance(f, BigInt("0"));
  await conserved(f);
  expect(
    await prisma.weleticLoyaltyEarnGrant.count({ where: { storeId: f.id } }),
  ).toBe(1);
});

it("P02: pending partial refund, early release rejection, maturity and replay", async () => {
  const f = await seed(7);
  const id = await order(f);
  const grant = await earn(f, id);
  expect(grant).toBeTruthy();
  await balance(f, BigInt("0"), BigInt("100"));
  await expect(mature(f, grant!.id)).rejects.toThrow();
  const refundId = await refund(f, id, [[0, BigInt("3000")]]);
  await reverse(f, refundId);
  await reverse(f, refundId);
  await balance(f, BigInt("0"), BigInt("70"));
  await conserved(f);
  vi.setSystemTime(new Date(grant!.availableAt.getTime() - 1));
  await expect(mature(f, grant!.id)).rejects.toThrow(/before maturity/);
  await balance(f, BigInt("0"), BigInt("70"));
  vi.setSystemTime(grant!.availableAt);
  await Promise.all([mature(f, grant!.id), mature(f, grant!.id)]);
  await balance(f, BigInt("70"));
  await conserved(f);
});

it("P03: full pending refund cannot later mature; refund/maturity race conserves value", async () => {
  const f = await seed(7);
  const id = await order(f);
  const grant = await earn(f, id);
  const refundId = await refund(f, id, [
    [0, BigInt("6000")],
    [1, BigInt("4000")],
  ]);
  await reverse(f, refundId);
  await balance(f, BigInt("0"));
  vi.setSystemTime(new Date("2026-09-24T00:00:00Z"));
  await mature(f, grant!.id);
  await balance(f, BigInt("0"));
  await conserved(f);
  const other = await order(f);
  const second = await earn(f, other);
  const secondRefund = await refund(f, other, [[0, BigInt("6000")]]);
  await Promise.all([mature(f, second!.id), reverse(f, secondRefund)]);
  await balance(f, BigInt("40"));
  await conserved(f);
});

it("P04: signup enrollment replay awards once; birthday annual replay and next year", async () => {
  const f = await seed(0, BigInt("25"));
  await f.enroll();
  await f.enroll();
  await balance(f, BigInt("25"));
  await prisma.weleticLoyaltyEarningRule.create({
    data: {
      id: `birthday-${f.id}`,
      programId: f.id,
      name: "Birthday",
      triggerCode: "birthday",
      ruleType: "fixed_points",
      fixedPoints: BigInt("50"),
      createdAt: new Date("2026-01-01T00:00:00Z"),
    },
  });
  const payload = {
    accountId: f.accountId,
    birthDate: "1990-09-16",
    registeredAt: "2026-01-01T00:00:00.000Z",
    calendarYear: 2026,
  };
  await prisma.weleticLoyaltyAccount.update({
    where: { id: f.accountId },
    data: {
      metadata: {
        birthday: {
          birthDate: payload.birthDate,
          registeredAt: payload.registeredAt,
        },
      },
    },
  });
  await handleBirthdayReward(f.id, payload, "g1", epoch);
  await handleBirthdayReward(f.id, payload, "g1", epoch);
  await balance(f, BigInt("75"));
  await handleBirthdayReward(
    f.id,
    { ...payload, calendarYear: 2027 },
    "g1",
    new Date("2027-09-16T00:00:00Z"),
  );
  await balance(f, BigInt("125"));
});

it("P05: exact manual adjustments, replay/conflict, tenant and generation fences", async () => {
  const f = await seed();
  const large = BigInt("9007199254740993");
  await manual(f, large, "manual-large");
  await manual(f, large, "manual-large");
  await balance(f, large);
  await expect(manual(f, large + BigInt("1"), "manual-large")).rejects.toThrow(
    /idempotency/i,
  );
  await manual(f, -large, "manual-debit");
  await balance(f, BigInt("0"));
  await expect(
    manual(
      { ...f, expectedInstallationGeneration: "stale" },
      BigInt("1"),
      "stale",
    ),
  ).rejects.toThrow();
  const other = await seed();
  await expect(
    manual({ ...other, accountId: f.accountId }, BigInt("1"), "cross-store"),
  ).rejects.toThrow();
  await balance(f, BigInt("0"));
  await balance(other, BigInt("0"));
});

it("P06: refund debt is retained after spending and future earnings repay it", async () => {
  const f = await seed();
  const id = await order(f);
  await earn(f, id);
  // Accounting-only spend fixture, not a real reward issuance or checkout.
  await appendPointsLedgerEntry({
    storeId: f.id,
    accountId: f.accountId,
    entryType: "REDEEM_REWARD",
    pointsDelta: -BigInt("80"),
    idempotencyKey: "synthetic-spend",
  });
  const refundId = await refund(f, id, [
    [0, BigInt("6000")],
    [1, BigInt("4000")],
  ]);
  await reverse(f, refundId);
  await balance(f, -BigInt("80"));
  await conserved(f);
  await earn(f, await order(f));
  await balance(f, BigInt("20"));
});

it("P07: expiry rejects early/stale jobs, expires once and leaves pending untouched", async () => {
  const f = await seed(14);
  await manual(f, BigInt("40"), "expiry-opening");
  await earn(f, await order(f));
  const account = await prisma.weleticLoyaltyAccount.findUniqueOrThrow({
    where: { id: f.accountId },
  });
  const payload = {
    accountId: f.accountId,
    stage: "expire" as const,
    expiryAt: account.nextExpiryDate!.toISOString(),
    lastActivityAt: account.lastQualifyingActivityAt!.toISOString(),
    expiryMonths: 0,
    expiryDays: 7,
    policyVersion: 1,
  };
  await expect(
    handleInactivityExpiry(f.id, payload, "g1", epoch),
  ).rejects.toThrow(/before/);
  const due = new Date("2026-09-24T00:00:00Z");
  await handleInactivityExpiry(
    f.id,
    { ...payload, policyVersion: 0 },
    "g1",
    due,
  );
  await balance(f, BigInt("40"), BigInt("100"));
  await handleInactivityExpiry(f.id, payload, "g1", due);
  await handleInactivityExpiry(f.id, payload, "g1", due);
  await balance(f, BigInt("0"), BigInt("100"));
  await conserved(f);
  expect(
    await prisma.weleticPointsLedgerEntry.count({
      where: { storeId: f.id, entryType: "EXPIRATION" },
    }),
  ).toBe(1);
});

it("P09: reinstall fences stale purchase/refund/maturity writers without changing balances", async () => {
  const f = await seed(7);
  const id = await order(f);
  const grant = await earn(f, id);
  const refundId = await refund(f, id, [[0, BigInt(3000)]]);
  await prisma.weleticShopifyStore.update({
    where: { id: f.id },
    data: { installationGeneration: "g2" },
  });
  vi.setSystemTime(grant!.availableAt);
  await expect(earn(f, id)).rejects.toThrow();
  await expect(reverse(f, refundId)).rejects.toThrow();
  await expect(mature(f, grant!.id)).rejects.toThrow();
  await balance(f, BigInt(0), BigInt(100));
  await conserved(f);
});

it("P08: independent SQL detects cache corruption without repairing it", async () => {
  const f = await seed();
  await manual(f, BigInt("10"), "audit");
  await balance(f, BigInt("10"));
  await prisma.$executeRaw`UPDATE WeleticLoyaltyAccount SET cachedPointsBalance = 11 WHERE id = ${f.accountId}`;
  expect(await discrepancies(f)).toEqual([{ id: f.accountId }]);
  expect(
    (
      await prisma.weleticLoyaltyAccount.findUniqueOrThrow({
        where: { id: f.accountId },
      })
    ).cachedPointsBalance,
  ).toBe(BigInt("11"));
  await prisma.$executeRaw`UPDATE WeleticLoyaltyAccount SET cachedPointsBalance = 10 WHERE id = ${f.accountId}`;
  await balance(f, BigInt("10"));
  const ledger = await prisma.weleticPointsLedgerEntry.findFirstOrThrow({
    where: { storeId: f.id },
  });
  await prisma.$executeRaw`UPDATE WeleticPointsLedgerEntry SET balanceAfter = 11 WHERE id = ${ledger.id}`;
  expect(await ledgerDiscrepancies(f)).toEqual([{ id: ledger.id }]);
  expect(await discrepancies(f)).toEqual([]);
  await prisma.$executeRaw`UPDATE WeleticPointsLedgerEntry SET balanceAfter = 10 WHERE id = ${ledger.id}`;
  await balance(f, BigInt("10"));
});
