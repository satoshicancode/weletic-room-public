import { prisma } from "@/lib/prisma";
import {
  retainCommunicationDeliveryRequest,
  type CommunicationDeliveryClaim,
} from "@/lib/weletic/loyalty/communication-delivery-snapshot";
import { releaseHoldingPeriodGrant } from "@/lib/weletic/loyalty/holding-period";
import { appendPointsLedgerEntryWithReceipt } from "@/lib/weletic/loyalty/ledger";
import { withActiveStoreLoyaltyMutation } from "@/lib/weletic/loyalty/merchant-write-fence";
import { awardBirthdayReward } from "@/lib/weletic/loyalty/non-purchase-earn";
import { processOutboxJobsBatch } from "@/lib/weletic/loyalty/outbox-worker";
import { enqueuePurchasePointsCommunication } from "@/lib/weletic/loyalty/points-communication-producer";
import { processWeleticLoyaltyAccountPrivacyScrubStep } from "@/lib/weletic/loyalty/shopper-privacy";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

// The whole notification handler (including source/refund checks) and Redis
// customer mutex are synthetic. Worker claim/completion,
// encrypted retention and privacy scrub execute against real MySQL. The ordered
// interleavings below prove SQL CAS behavior, not distributed-lock correctness.
const workerSender = vi.hoisted(() => vi.fn());
vi.mock("@/lib/weletic/loyalty/points-earned-notifications", () => ({
  sendPointsEarnedNotification: workerSender,
}));
vi.mock("@/lib/weletic/shopify/customer-settlement-lock", () => ({
  withShopifyCustomerSettlementLocks: async ({
    fn,
  }: {
    fn: () => Promise<unknown>;
  }) => fn(),
}));

const fixtures: string[] = [];
let verified = false;
beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL || "invalid:");
  if (
    process.env.COMMUNICATION_DELIVERY_DATABASE_INTEGRATION !== "1" ||
    url.protocol !== "mysql:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "3307" ||
    url.username !== "loyalty_dev" ||
    !/^\/weletic_loyalty_it_communications_[a-z0-9_]+$/.test(url.pathname)
  )
    throw new Error("Refusing non-isolated communication database");
  expect(
    await prisma.$queryRaw`SELECT DATABASE() AS databaseName, CURRENT_USER() AS principal`,
  ).toEqual([
    { databaseName: url.pathname.slice(1), principal: "loyalty_dev@%" },
  ]);
  expect(await prisma.weleticShopifyStore.count()).toBe(0);
  verified = true;
  vi.stubEnv("ENCRYPTION_KEY", "test-only-isolated-communication-key");
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("External network forbidden in communication DB tests");
    }),
  );
});
afterAll(async () => {
  if (verified && fixtures.length) {
    const scope = { storeId: { in: fixtures } };
    await prisma.weleticLoyaltyOutboxJob.deleteMany({ where: scope });
    await prisma.weleticPointsLedgerEntry.deleteMany({ where: scope });
    await prisma.weleticLoyaltyOrderLineEarn.deleteMany({ where: scope });
    await prisma.weleticLoyaltyEarnGrant.deleteMany({ where: scope });
    await prisma.weleticCommerceRefundLine.deleteMany({
      where: { refundId: { in: fixtures } },
    });
    await prisma.weleticCommerceRefund.deleteMany({ where: scope });
    await prisma.weleticCommerceOrderLine.deleteMany({
      where: { orderId: { in: fixtures } },
    });
    await prisma.weleticCommerceOrder.deleteMany({ where: scope });
    await prisma.weleticLoyaltyAccount.deleteMany({ where: scope });
    await prisma.weleticShopper.deleteMany({ where: scope });
    await prisma.weleticMerchantSettings.deleteMany({ where: scope });
    await prisma.weleticLoyaltyProgram.deleteMany({ where: scope });
    await prisma.weleticShopifyStore.deleteMany({
      where: { id: { in: fixtures } },
    });
    expect(
      await prisma.programEnrollment.count({
        where: { programId: { in: fixtures } },
      }),
    ).toBe(0);
    await prisma.$executeRaw(
      Prisma.sql`DELETE FROM Program WHERE id IN (${Prisma.join(fixtures)})`,
    );
    await prisma.$executeRaw(
      Prisma.sql`DELETE FROM Project WHERE id IN (${Prisma.join(fixtures)})`,
    );
    for (const table of [
      "Project",
      "Program",
      "WeleticShopifyStore",
      "WeleticLoyaltyProgram",
      "WeleticShopper",
      "WeleticLoyaltyAccount",
      "WeleticLoyaltyOutboxJob",
      "WeleticMerchantSettings",
    ]) {
      const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT COUNT(*) AS count FROM ${table}`,
      );
      expect(rows[0].count).toBe(BigInt(0));
    }
  }
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await prisma.$disconnect();
});
const request = {
  to: "synthetic@example.com",
  from: "test@example.com",
  subject: "Saved",
  html: "<p>Saved synthetic points</p>",
};
const template = {
  subject: "Points",
  heading: "Points",
  body: "{{points}}",
  actionLabel: "View",
};
const policy = {
  journey: "points_earned",
  enabled: true,
  templates: { en: template, ja: template, vi: template },
};
const metadata = {
  loyaltyCommunications: { version: 1, sequence: 1, policies: [policy] },
};
async function seed() {
  const id = `communication-${randomUUID()}`;
  fixtures.push(id);
  await prisma.project.create({
    data: {
      id,
      name: "Communication DB fixture",
      slug: id,
      billingCycleStart: 1,
    },
  });
  await prisma.program.create({
    data: {
      id,
      workspaceId: id,
      name: "Communication DB fixture",
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
      shopCurrency: "JPY",
      currencyVerifiedAt: new Date(),
      storeAccessState: "active",
      complianceState: "active",
      installationGeneration: "g1",
      apiVersion: "2026-07",
    },
  });
  await prisma.weleticLoyaltyProgram.create({
    data: { id, storeId: id, status: "active", metadata },
  });
  await prisma.weleticShopper.create({
    data: {
      id,
      storeId: id,
      shopifyCustomerId: id,
      email: request.to,
      acceptsMarketing: true,
    },
  });
  await prisma.weleticLoyaltyAccount.create({
    data: { id, storeId: id, programId: id, shopperId: id, status: "active" },
  });
  await prisma.weleticMerchantSettings.create({ data: { storeId: id } });
  const candidate = await prisma.weleticLoyaltyOutboxJob.create({
    data: {
      id,
      storeId: id,
      jobType: "LOYALTY_COMMUNICATION",
      status: "processing",
      attempts: 1,
      lockedBy: "fixture-owner",
      lockedAt: new Date(),
      idempotencyKey: `fixture-${id}`,
      payload: {
        version: 1,
        journey: "points_earned",
        source: "purchase_points_available",
        storeId: id,
        programId: id,
        accountId: id,
        installationGeneration: "g1",
        ledgerEntryId: id,
        orderId: id,
        occurredAt: new Date().toISOString(),
        points: "20",
        ledgerPoints: "20",
        policyRevision: "a".repeat(64),
        policy,
      },
    },
  });
  const claim: CommunicationDeliveryClaim = {
    candidate,
    ownerToken: candidate.lockedBy!,
    claimedAt: candidate.lockedAt!,
    attempt: 1,
  };
  const prepare = vi.fn().mockResolvedValue(request);
  return {
    id,
    args: {
      claim,
      accountId: id,
      expectedInstallationGeneration: "g1",
      recipientEmail: request.to,
      prepare,
    },
  };
}

async function seedBirthday() {
  const { id } = await seed();
  await prisma.weleticLoyaltyOutboxJob.delete({ where: { id } });
  await prisma.weleticLoyaltyAccount.update({
    where: { id },
    data: { enrolledAt: new Date("2025-01-01T00:00:00Z") },
  });
  await prisma.weleticLoyaltyProgram.update({
    where: { id },
    data: {
      metadata: {
        loyaltyCommunications: {
          version: 1,
          sequence: 1,
          policies: [{ ...policy, journey: "birthday" }],
        },
      },
    },
  });
  return id;
}
const birthdayAward = (id: string) => ({
  storeId: id,
  accountId: id,
  birthDate: "1990-09-10",
  now: new Date("2026-09-10T00:00:00Z"),
  rewardPoints: BigInt(100),
});

it("commits one annual birthday award and notification under concurrent replay", async () => {
  const id = await seedBirthday();
  const results = await Promise.all([
    awardBirthdayReward(birthdayAward(id)),
    awardBirthdayReward(birthdayAward(id)),
  ]);
  expect(results.every((result) => result.awarded)).toBe(true);
  expect(results.filter((result) => result.isDuplicate)).toHaveLength(1);
  expect(
    await prisma.weleticPointsLedgerEntry.count({ where: { storeId: id } }),
  ).toBe(1);
  const jobs = await prisma.weleticLoyaltyOutboxJob.findMany({
    where: { storeId: id, jobType: "LOYALTY_COMMUNICATION" },
  });
  expect(jobs).toHaveLength(1);
  expect(jobs[0].payload).toMatchObject({
    journey: "birthday",
    calendarYear: 2026,
    points: "100",
    ledgerEntryId: results[0].ledgerEntry?.id,
  });
  expect(jobs[0].payload).not.toHaveProperty("birthDate");
  expect(
    (await prisma.weleticLoyaltyAccount.findUniqueOrThrow({ where: { id } }))
      .cachedPointsBalance,
  ).toBe(BigInt(100));
});

it("does not backfill a birthday notice after policy opt-in, but announces the next annual award", async () => {
  const id = await seedBirthday();
  const enabled = (
    await prisma.weleticLoyaltyProgram.findUniqueOrThrow({ where: { id } })
  ).metadata as Prisma.InputJsonObject;
  await prisma.weleticLoyaltyProgram.update({
    where: { id },
    data: { metadata: {} },
  });
  await awardBirthdayReward(birthdayAward(id));
  await prisma.weleticLoyaltyProgram.update({
    where: { id },
    data: { metadata: enabled },
  });
  await awardBirthdayReward(birthdayAward(id));
  expect(
    await prisma.weleticLoyaltyOutboxJob.count({
      where: { storeId: id, jobType: "LOYALTY_COMMUNICATION" },
    }),
  ).toBe(0);
  await awardBirthdayReward({
    ...birthdayAward(id),
    now: new Date("2027-09-10T00:00:00Z"),
  });
  expect(
    await prisma.weleticLoyaltyOutboxJob.count({
      where: { storeId: id, jobType: "LOYALTY_COMMUNICATION" },
    }),
  ).toBe(1);
  expect(
    await prisma.weleticPointsLedgerEntry.count({ where: { storeId: id } }),
  ).toBe(2);
});

it("rolls back the real birthday ledger and account when notification insertion fails", async () => {
  const id = await seedBirthday();
  await expect(
    prisma.$transaction(async (tx) => {
      const failingTx = new Proxy(tx, {
        get(target, property) {
          if (property !== "weleticLoyaltyOutboxJob")
            return Reflect.get(target, property);
          return new Proxy(target.weleticLoyaltyOutboxJob, {
            get(delegate, operation) {
              if (operation !== "create")
                return Reflect.get(delegate, operation);
              return async () => {
                throw new Error("Injected birthday outbox failure");
              };
            },
          });
        },
      });
      await awardBirthdayReward({ ...birthdayAward(id), tx: failingTx });
    }),
  ).rejects.toThrow("Injected birthday outbox failure");
  expect(
    await prisma.weleticPointsLedgerEntry.count({ where: { storeId: id } }),
  ).toBe(0);
  expect(
    await prisma.weleticLoyaltyOutboxJob.count({ where: { storeId: id } }),
  ).toBe(0);
  expect(
    (await prisma.weleticLoyaltyAccount.findUniqueOrThrow({ where: { id } }))
      .cachedPointsBalance,
  ).toBe(BigInt(0));
});

it.each(["before_completion", "after_completion"] as const)(
  "erases retained communication evidence when redaction wins %s",
  async (ordering) => {
    const { id, args } = await seed();
    await prisma.weleticLoyaltyOutboxJob.update({
      where: { id },
      data: {
        status: "pending",
        attempts: 0,
        lockedBy: null,
        lockedAt: null,
        scheduledFor: new Date(0),
      },
    });
    const scrub = async () => {
      // The durable scrub phase follows account closure. This test is not a
      // substitute for the complete Shopify privacy ingress/locking lifecycle.
      await prisma.weleticLoyaltyAccount.update({
        where: { id },
        data: { status: "closed" },
      });
      return processWeleticLoyaltyAccountPrivacyScrubStep({
        storeId: id,
        accountId: id,
        phase: "scrub_account_outbox",
        redactedAt: new Date(),
      });
    };
    workerSender.mockReset();
    workerSender.mockImplementation(async ({ claim }) => {
      await retainCommunicationDeliveryRequest({ ...args, claim });
      const retained = await prisma.weleticLoyaltyOutboxJob.findUniqueOrThrow({
        where: { id },
      });
      expect(retained.status).toBe("processing");
      expect(retained.payload).toHaveProperty("communicationDeliverySnapshot");
      if (ordering === "before_completion") await scrub();
      return "sent";
    });
    const result = await processOutboxJobsBatch({
      storeId: id,
      jobIds: [id],
      workerId: "synthetic-communication-privacy-worker",
      batchSize: 1,
    });
    expect(workerSender).toHaveBeenCalledTimes(1);
    expect(result.failed).toBe(0);
    expect(result.succeeded).toBe(ordering === "before_completion" ? 0 : 1);
    expect(result.skipped).toBe(ordering === "before_completion" ? 1 : 0);
    if (ordering === "after_completion") {
      const completed = await prisma.weleticLoyaltyOutboxJob.findUniqueOrThrow({
        where: { id },
      });
      expect(completed.status).toBe("completed");
      expect(completed.payload).toHaveProperty("communicationDeliverySnapshot");
      await scrub();
    }
    const erased = await prisma.weleticLoyaltyOutboxJob.findUniqueOrThrow({
      where: { id },
    });
    expect(erased.status).toBe(
      ordering === "before_completion" ? "cancelled" : "completed",
    );
    expect(erased.payload).not.toHaveProperty("communicationDeliverySnapshot");
    expect(JSON.stringify(erased.payload)).not.toContain(request.to);
    expect(erased.lockedBy).toBeNull();
    expect(erased.lockedAt).toBeNull();
    expect(erased.errorLog).toBeNull();
    // A later worker poll cannot resurrect the stale retained claim.
    await processOutboxJobsBatch({ storeId: id, jobIds: [id], batchSize: 1 });
    expect(workerSender).toHaveBeenCalledTimes(1);
    expect(
      (
        await prisma.weleticLoyaltyOutboxJob.findUniqueOrThrow({
          where: { id },
        })
      ).payload,
    ).not.toHaveProperty("communicationDeliverySnapshot");
  },
);

it("allows one competing claim snapshot and retries the exact persisted request", async () => {
  const { id, args } = await seed();
  const outcomes = await Promise.allSettled([
    retainCommunicationDeliveryRequest(args),
    retainCommunicationDeliveryRequest({
      ...args,
      claim: structuredClone(args.claim),
    }),
  ]);
  expect(
    outcomes.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(
    outcomes.filter((result) => result.status === "rejected"),
  ).toHaveLength(1);
  const row = await prisma.weleticLoyaltyOutboxJob.findUniqueOrThrow({
    where: { id },
  });
  expect(JSON.stringify(row.payload)).not.toContain(request.to);
  const prepare = vi.fn(() => {
    throw new Error("Retry must not rerender");
  });
  expect(
    await retainCommunicationDeliveryRequest({
      ...args,
      claim: { ...args.claim, candidate: row },
      prepare,
    }),
  ).toEqual(request);
  expect(prepare).not.toHaveBeenCalled();
});

// Real overlapping transactions, without asserting a particular lock-wait time.
async function changeFirst(
  id: string,
  mutate: (tx: Prisma.TransactionClient) => Promise<unknown>,
  retain: () => Promise<unknown>,
) {
  let signal!: () => void;
  let release!: () => void;
  const locked = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const change = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM WeleticShopifyStore WHERE id = ${id} FOR UPDATE`;
    await mutate(tx);
    signal();
    await gate;
  });
  await Promise.race([
    locked,
    change.then(() => {
      throw new Error("Unexpected transaction completion");
    }),
  ]);
  const attempt = retain().then(
    () => false,
    () => true,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  release();
  await change;
  expect(await attempt).toBe(true);
}
it.each([
  "program",
  "policy",
  "pause",
  "generation",
  "consent",
  "claim",
  "privacy",
])(
  "rejects a change-first %s transaction before retaining a request",
  async (kind) => {
    const { id, args } = await seed();
    await changeFirst(
      id,
      (tx) => {
        if (kind === "program")
          return tx.weleticLoyaltyProgram.update({
            where: { id },
            data: { killSwitchActive: true },
          });
        if (kind === "policy")
          return tx.weleticLoyaltyProgram.update({
            where: { id },
            data: {
              metadata: {
                loyaltyCommunications: {
                  version: 1,
                  sequence: 2,
                  policies: [{ ...policy, enabled: false }],
                },
              },
            },
          });
        if (kind === "pause")
          return tx.weleticMerchantSettings.update({
            where: { storeId: id },
            data: { shopperEmailPaused: true },
          });
        if (kind === "generation")
          return tx.weleticShopifyStore.update({
            where: { id },
            data: { installationGeneration: "g2" },
          });
        if (kind === "consent")
          return tx.weleticShopper.update({
            where: { id },
            data: { acceptsMarketing: false },
          });
        if (kind === "privacy")
          return tx.weleticLoyaltyAccount.update({
            where: { id },
            data: { status: "closed" },
          });
        return tx.weleticLoyaltyOutboxJob.update({
          where: { id },
          data: { lockedBy: "new-owner", attempts: 2 },
        });
      },
      () => retainCommunicationDeliveryRequest(args),
    );
    expect(args.prepare).not.toHaveBeenCalled();
    const row = await prisma.weleticLoyaltyOutboxJob.findUniqueOrThrow({
      where: { id },
    });
    expect(row.payload).not.toHaveProperty("communicationDeliverySnapshot");
  },
);
it("rechecks policy admission for an already retained retry", async () => {
  const { id, args } = await seed();
  await retainCommunicationDeliveryRequest(args);
  args.prepare.mockClear();
  await changeFirst(
    id,
    (tx) =>
      tx.weleticLoyaltyProgram.update({
        where: { id },
        data: { killSwitchActive: true },
      }),
    () => retainCommunicationDeliveryRequest(args),
  );
  expect(args.prepare).not.toHaveBeenCalled();
});

async function seedFinancial(held = false) {
  const { id } = await seed();
  await prisma.weleticLoyaltyOutboxJob.delete({ where: { id } });
  const amount = BigInt(10000);
  await prisma.weleticCommerceOrder.create({
    data: {
      id,
      storeId: id,
      programId: id,
      shopperId: id,
      externalId: id,
      status: "paid",
      presentmentCurrency: "JPY",
      presentmentSubtotal: amount,
      presentmentNet: amount,
      presentmentTotal: amount,
      shopCurrency: "JPY",
      shopSubtotal: amount,
      shopNet: amount,
      shopTotal: amount,
      accountingCurrency: "JPY",
      accountingNet: amount,
      accountingTotal: amount,
      accountingFxRate: 1,
      occurredAt: new Date(),
    },
  });
  await prisma.weleticCommerceOrderLine.create({
    data: {
      id,
      orderId: id,
      externalId: id,
      title: "Synthetic item",
      quantity: 10,
      presentmentGross: amount,
      presentmentNet: amount,
      shopGross: amount,
      shopNet: amount,
      accountingNet: amount,
      commissionableAccountingAmount: amount,
    },
  });
  await prisma.weleticLoyaltyEarnGrant.create({
    data: {
      id,
      storeId: id,
      programId: id,
      accountId: id,
      shopperId: id,
      orderId: id,
      status: held ? "pending" : "settled",
      currency: "JPY",
      eligibleSubtotalAmount: amount,
      orderTotalAmount: amount,
      grossPoints: BigInt(100),
      pendingPoints: held ? BigInt(100) : BigInt(0),
      settledPoints: held ? BigInt(0) : BigInt(100),
      availableAt: new Date(0),
      pointsPerCurrencyUnit: 1,
      effectiveMultiplier: 1,
    },
  });
  await prisma.weleticLoyaltyOrderLineEarn.create({
    data: {
      id,
      grantId: id,
      orderLineId: id,
      storeId: id,
      quantity: 10,
      lineNetAmount: amount,
      awardedPoints: BigInt(100),
    },
  });
  if (held)
    await prisma.weleticLoyaltyAccount.update({
      where: { id },
      data: { cachedPendingPoints: BigInt(100) },
    });
  return id;
}
function post(id: string, rollback = false) {
  return withActiveStoreLoyaltyMutation({
    storeId: id,
    action: "communication_db_fixture",
    expectedInstallationGeneration: "g1",
    operation: async (tx) => {
      const receipt = await appendPointsLedgerEntryWithReceipt({
        tx,
        storeId: id,
        accountId: id,
        entryType: "EARN_ORDER",
        pointsDelta: BigInt(100),
        grantId: id,
        referenceType: "COMMERCE_ORDER",
        referenceId: id,
        idempotencyKey: `earn:${id}`,
      });
      await enqueuePurchasePointsCommunication({
        tx,
        storeId: id,
        programId: id,
        receipt,
      });
      if (rollback) throw new Error("Synthetic rollback after enqueue");
      return receipt.created;
    },
  });
}
it("commits one ledger and notification across competing same-event transactions", async () => {
  const id = await seedFinancial();
  expect((await Promise.all([post(id), post(id)])).sort()).toEqual([
    false,
    true,
  ]);
  expect(
    await prisma.weleticPointsLedgerEntry.count({ where: { storeId: id } }),
  ).toBe(1);
  expect(
    await prisma.weleticLoyaltyOutboxJob.count({ where: { storeId: id } }),
  ).toBe(1);
  expect(
    (await prisma.weleticLoyaltyAccount.findUniqueOrThrow({ where: { id } }))
      .cachedPointsBalance,
  ).toBe(BigInt(100));
});
it("rolls back ledger, balance and notification atomically", async () => {
  const id = await seedFinancial();
  await expect(post(id, true)).rejects.toThrow("Synthetic rollback");
  expect(
    await prisma.weleticPointsLedgerEntry.count({ where: { storeId: id } }),
  ).toBe(0);
  expect(
    await prisma.weleticLoyaltyOutboxJob.count({ where: { storeId: id } }),
  ).toBe(0);
  expect(
    (await prisma.weleticLoyaltyAccount.findUniqueOrThrow({ where: { id } }))
      .cachedPointsBalance,
  ).toBe(BigInt(0));
});
it("reconciles a persisted partial refund before a holding-release notification", async () => {
  const id = await seedFinancial(true);
  await prisma.weleticCommerceOrder.update({
    where: { id },
    data: { status: "partially_refunded" },
  });
  const amount = BigInt(3000);
  await prisma.weleticCommerceRefund.create({
    data: {
      id,
      storeId: id,
      orderId: id,
      externalId: id,
      presentmentCurrency: "JPY",
      presentmentAmount: amount,
      shopCurrency: "JPY",
      shopAmount: amount,
      accountingCurrency: "JPY",
      accountingAmount: amount,
      accountingFxRate: 1,
      occurredAt: new Date(),
    },
  });
  await prisma.weleticCommerceRefundLine.create({
    data: {
      id,
      refundId: id,
      orderLineId: id,
      externalId: id,
      quantity: 3,
      presentmentAmount: amount,
      shopAmount: amount,
      accountingAmount: amount,
    },
  });
  const result = await releaseHoldingPeriodGrant({
    storeId: id,
    grantId: id,
    expectedInstallationGeneration: "g1",
  });
  expect(result.released).toBe(true);
  const account = await prisma.weleticLoyaltyAccount.findUniqueOrThrow({
    where: { id },
  });
  expect(account.cachedPointsBalance).toBe(BigInt(70));
  expect(account.cachedPendingPoints).toBe(BigInt(0));
  const grant = await prisma.weleticLoyaltyEarnGrant.findUniqueOrThrow({
    where: { id },
  });
  expect(grant.settledPoints).toBe(BigInt(70));
  expect(grant.reversedPoints).toBe(BigInt(30));
  const jobs = await prisma.weleticLoyaltyOutboxJob.findMany({
    where: { storeId: id, jobType: "LOYALTY_COMMUNICATION" },
  });
  expect(jobs).toHaveLength(1);
  expect(jobs[0].payload).toMatchObject({ points: "70", ledgerPoints: "100" });
  await releaseHoldingPeriodGrant({
    storeId: id,
    grantId: id,
    expectedInstallationGeneration: "g1",
  });
  expect(
    await prisma.weleticLoyaltyOutboxJob.count({
      where: { storeId: id, jobType: "LOYALTY_COMMUNICATION" },
    }),
  ).toBe(1);
});
