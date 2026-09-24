import { prisma } from "@/lib/prisma";
import { recordWeleticRefund } from "@/lib/weletic/commerce/record-refund";
import { appendPointsLedgerEntry } from "@/lib/weletic/loyalty/ledger";
import { getReferralCouponIdempotencyKey } from "@/lib/weletic/loyalty/referral-coupon-idempotency";
import { writeReferralRuleInTransaction } from "@/lib/weletic/loyalty/referral-rule-write";
import {
  bindShopperReferral,
  evaluateReferralQualification,
  reverseReferralPointsOnRefund,
} from "@/lib/weletic/loyalty/referrals";
import { Prisma } from "@prisma/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Database locks, domain operations, ledger and outbox persistence are real.
// Refund ingestion runs sequentially with a synthetic Redis lock boundary;
// this suite does not establish distributed-lock or signed-webhook acceptance.
vi.mock("@/lib/weletic/redis-lock", () => ({
  withDistributedLock: async ({ fn }: { fn: () => Promise<unknown> }) => fn(),
}));
const hooks = vi.hoisted(() => ({
  beforeTransaction: vi.fn(),
  beforeCommit: vi.fn(),
}));
vi.mock("@/lib/prisma", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/prisma")>();
  return {
    ...actual,
    prisma: new Proxy(actual.prisma, {
      get(target, key) {
        if (key === "$transaction")
          return async (operation: any, options: any) => {
            await hooks.beforeTransaction();
            return target.$transaction(async (tx) => {
              const result = await operation(tx);
              await hooks.beforeCommit();
              return result;
            }, options);
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
});

const fixtures: Array<{
  storeId: string;
  workspaceId: string;
  programId: string;
}> = [];
let sequence = 0;
function guard() {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (
    process.env.LOYALTY_DATABASE_INTEGRATION !== "1" ||
    url.protocol !== "mysql:" ||
    url.hostname !== "127.0.0.1" ||
    !["3307", "3309"].includes(url.port) ||
    url.username !== "loyalty_dev" ||
    url.search ||
    !/^\/weletic_loyalty_it_referral_\d{8}_[a-z0-9]+$/.test(url.pathname)
  )
    throw new Error(
      "Only a fresh isolated referral lifecycle database is allowed",
    );
}

async function fixture() {
  const id = `refit_${process.pid}_${Date.now()}_${sequence++}`;
  const workspaceId = `ws_${id}`,
    programId = `p_${id}`,
    storeId = `s_${id}`;
  const loyaltyId = `l_${id}`,
    generation = `g_${id}`,
    ruleId = `r_${id}`;
  fixtures.push({ workspaceId, programId, storeId });
  await prisma.project.create({
    data: {
      id: workspaceId,
      name: "Isolated referral test",
      slug: workspaceId,
      billingCycleStart: 1,
    },
  });
  await prisma.program.create({
    data: {
      id: programId,
      workspaceId,
      name: "Isolated test",
      slug: programId,
      defaultFolderId: `f_${id}`,
      defaultGroupId: `g_${id}`,
    },
  });
  await prisma.weleticShopifyStore.create({
    data: {
      id: storeId,
      projectId: workspaceId,
      programId,
      shopDomain: `${id}.myshopify.com`,
      shopCurrency: "USD",
      currencyVerifiedAt: new Date(),
      apiVersion: "2026-07",
      storeAccessState: "active",
      installationGeneration: generation,
    },
  });
  await prisma.weleticLoyaltyProgram.create({
    data: { id: loyaltyId, storeId, status: "active" },
  });
  await prisma.weleticLoyaltyReferralRule.create({
    data: {
      id: ruleId,
      programId: loyaltyId,
      advocatePointsReward: BigInt(100),
      refereePointsReward: BigInt(50),
      minQualifyingOrderSubtotal: "10.00",
      fraudCheckSameIp: false,
    },
  });
  async function person(suffix: string) {
    const shopperId = `sh_${id}_${suffix}`,
      accountId = `a_${id}_${suffix}`,
      referralCode = `CODE_${id}_${suffix}`.toUpperCase();
    await prisma.weleticShopper.create({
      data: {
        id: shopperId,
        storeId,
        shopifyCustomerId: `customer_${id}_${suffix}`,
        email: `${suffix}@example.test`,
      },
    });
    await prisma.weleticLoyaltyAccount.create({
      data: {
        id: accountId,
        storeId,
        programId: loyaltyId,
        shopperId,
        referralCode,
      },
    });
    return { shopperId, accountId, referralCode };
  }
  const advocate = await person("advocate"),
    friend = await person("friend");
  async function bind(target = friend, source = advocate) {
    return bindShopperReferral({
      storeId,
      refereeAccountId: target.accountId,
      referralCode: source.referralCode,
    });
  }
  async function order(target = friend, net = BigInt(1000), suffix = "first") {
    const orderId = `o_${id}_${suffix}`;
    await prisma.weleticCommerceOrder.create({
      data: {
        id: orderId,
        storeId,
        programId,
        shopperId: target.shopperId,
        externalId: orderId,
        presentmentCurrency: "USD",
        presentmentSubtotal: net,
        presentmentNet: net,
        presentmentTotal: net,
        shopCurrency: "USD",
        shopSubtotal: net,
        shopNet: net,
        shopTotal: net,
        accountingCurrency: "USD",
        accountingNet: net,
        accountingTotal: net,
        accountingFxRate: "1",
        occurredAt: new Date(),
        lines: {
          create: {
            id: `line_${orderId}`,
            externalId: `line_${orderId}`,
            title: "Synthetic order",
            quantity: 1,
            presentmentGross: net,
            presentmentNet: net,
            shopGross: net,
            shopNet: net,
            accountingNet: net,
            commissionableAccountingAmount: net,
          },
        },
      },
    });
    await prisma.weleticShopper.update({
      where: { id: target.shopperId },
      data: { ordersCount: 1 },
    });
    return orderId;
  }
  const qualify = (orderId: string, target = friend) =>
    evaluateReferralQualification({
      storeId,
      orderId,
      refereeShopperId: target.shopperId,
      orderSubtotal: BigInt(999999),
      currency: "USD",
      expectedInstallationGeneration: generation,
    });
  const reverse = (orderId: string, refundId = `refund_${orderId}`) =>
    reverseReferralPointsOnRefund({
      storeId,
      orderId,
      refundId,
      expectedInstallationGeneration: generation,
    });
  return {
    workspaceId,
    storeId,
    loyaltyId,
    generation,
    ruleId,
    advocate,
    friend,
    person,
    bind,
    order,
    qualify,
    reverse,
  };
}

async function reconcile(storeId: string, expected: bigint[]) {
  const rows = await prisma.$queryRaw<
    Array<{ balance: string; ledger: string }>
  >`
    SELECT CAST(a.cachedPointsBalance AS CHAR) AS balance,
           CAST(COALESCE(SUM(l.pointsDelta), 0) AS CHAR) AS ledger
    FROM WeleticLoyaltyAccount a LEFT JOIN WeleticPointsLedgerEntry l
      ON l.accountId = a.id AND l.storeId = a.storeId
    WHERE a.storeId = ${storeId}
    GROUP BY a.id, a.cachedPointsBalance ORDER BY a.id`;
  expect(rows.map((row) => BigInt(row.balance)).sort()).toEqual(
    [...expected].sort(),
  );
  for (const row of rows) expect(row.balance).toBe(row.ledger);
}

describe("referral lifecycle on real isolated MySQL, synthetic orders", () => {
  beforeAll(() => {
    guard();
    vi.stubEnv("ENCRYPTION_KEY", "isolated-referral-test-key");
  });
  afterEach(async () => {
    hooks.beforeTransaction.mockReset();
    hooks.beforeCommit.mockReset();
    for (const f of fixtures.splice(0)) {
      const orders = await prisma.weleticCommerceOrder.findMany({
        where: { storeId: f.storeId },
        select: { id: true },
      });
      await prisma.weleticLoyaltyOutboxJob.deleteMany({
        where: { storeId: f.storeId },
      });
      await prisma.weleticPointsLedgerEntry.deleteMany({
        where: { storeId: f.storeId },
      });
      await prisma.weleticLoyaltyReferral.deleteMany({
        where: { storeId: f.storeId },
      });
      await prisma.weleticRewardRedemption.deleteMany({
        where: { storeId: f.storeId },
      });
      await prisma.weleticRewardDefinition.deleteMany({
        where: { storeId: f.storeId },
      });
      await prisma.weleticCommerceOrder.deleteMany({
        where: { storeId: f.storeId },
      });
      await prisma.weleticFxRateSnapshot.deleteMany({
        where: {
          provider: { in: orders.map((o) => `order-snapshot:${o.id}`) },
        },
      });
      await prisma.weleticLoyaltyAccount.updateMany({
        where: { storeId: f.storeId },
        data: { referredById: null },
      });
      await prisma.weleticLoyaltyAccount.deleteMany({
        where: { storeId: f.storeId },
      });
      await prisma.weleticShopper.deleteMany({ where: { storeId: f.storeId } });
      await prisma.weleticLoyaltyProgram.deleteMany({
        where: { storeId: f.storeId },
      });
      await prisma.weleticShopifyStore.deleteMany({ where: { id: f.storeId } });
      await prisma.$executeRaw`DELETE FROM Program WHERE id = ${f.programId}`;
      await prisma.$executeRaw`DELETE FROM Project WHERE id = ${f.workspaceId}`;
    }
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await prisma.$disconnect();
  });

  async function ingestedRefundFixture() {
    const f = await fixture();
    await f.bind();
    const orderId = await f.order();
    await f.qualify(orderId);
    await prisma.weleticCommerceOrder.update({
      where: { id: orderId },
      data: { externalId: "9001" },
    });
    await prisma.weleticCommerceOrderLine.update({
      where: { id: `line_${orderId}` },
      data: { externalId: "9101", quantity: 2 },
    });
    const refund = (
      id: number,
      amount: string | null,
      generation = f.generation,
    ) =>
      recordWeleticRefund(
        {
          workspaceId: f.workspaceId,
          event: {
            id,
            order_id: 9001,
            created_at: "2026-09-17T00:00:00Z",
            refund_line_items:
              amount === null
                ? []
                : [
                    {
                      id: id + 100,
                      line_item_id: 9101,
                      quantity: 1,
                      subtotal_set: {
                        shop_money: { amount, currency_code: "USD" },
                        presentment_money: { amount, currency_code: "USD" },
                      },
                    },
                  ],
          },
        },
        { expectedInstallationGeneration: generation },
      );
    const state = () =>
      prisma.weleticLoyaltyReferral.findFirstOrThrow({
        where: { storeId: f.storeId, qualifyingOrderId: orderId },
      });
    return { ...f, orderId, refund, state };
  }

  it("ingests partial then cumulative full refunds, including replay of the earlier partial", async () => {
    const f = await ingestedRefundFixture();
    await f.refund(9201, "4.00");
    await f.refund(9201, "4.00");
    expect((await f.state()).status).toBe("rewarded");
    await reconcile(f.storeId, [BigInt(100), BigInt(50)]);
    expect(
      (
        await prisma.weleticCommerceOrder.findUniqueOrThrow({
          where: { id: f.orderId },
        })
      ).status,
    ).toBe("partially_refunded");
    await f.refund(9202, "6.00");
    await f.refund(9202, "6.00");
    await f.refund(9201, "4.00");
    expect((await f.state()).status).toBe("cancelled");
    await reconcile(f.storeId, [BigInt(0), BigInt(0)]);
    expect(
      await prisma.weleticCommerceRefund.count({
        where: { storeId: f.storeId },
      }),
    ).toBe(2);
    expect(
      await prisma.weleticPointsLedgerEntry.count({
        where: { storeId: f.storeId },
      }),
    ).toBe(4);
    const sums = await prisma.$queryRaw<
      Array<{ amount: string }>
    >`SELECT CAST(SUM(shopAmount) AS CHAR) AS amount FROM WeleticCommerceRefund WHERE storeId = ${f.storeId}`;
    expect(sums[0].amount).toBe("1000");
  });

  it("contains refunds with no merchandise lines and their replay without speculative clawback", async () => {
    const f = await ingestedRefundFixture();
    await f.refund(9301, null);
    await f.refund(9301, null);
    expect((await f.state()).status).toBe("rewarded");
    await reconcile(f.storeId, [BigInt(100), BigInt(50)]);
    expect(
      await prisma.weleticReconciliationIssue.count({
        where: { storeId: f.storeId, status: "open" },
      }),
    ).toBe(1);
    expect(
      await prisma.weleticCommerceRefund.count({
        where: { storeId: f.storeId },
      }),
    ).toBe(1);
  });

  it.each(["9.99", "10.00"])(
    "uses the persisted full-refund boundary at %s USD",
    async (amount) => {
      const f = await ingestedRefundFixture();
      await f.refund(9351, amount);
      const full = amount === "10.00";
      expect((await f.state()).status).toBe(full ? "cancelled" : "rewarded");
      await reconcile(
        f.storeId,
        full ? [BigInt(0), BigInt(0)] : [BigInt(100), BigInt(50)],
      );
    },
  );

  it("recovers a committed full refund after failure before loyalty reversal", async () => {
    const f = await ingestedRefundFixture();
    hooks.beforeTransaction.mockImplementation(async () => {
      if (
        await prisma.weleticCommerceRefund.count({
          where: { storeId: f.storeId },
        })
      ) {
        throw new Error("synthetic crash after commerce commit");
      }
    });
    await expect(f.refund(9361, "10.00")).rejects.toThrow(
      "synthetic crash after commerce commit",
    );
    hooks.beforeTransaction.mockReset();
    expect(
      await prisma.weleticCommerceRefund.count({
        where: { storeId: f.storeId },
      }),
    ).toBe(1);
    expect((await f.state()).status).toBe("rewarded");
    await reconcile(f.storeId, [BigInt(100), BigInt(50)]);
    await f.refund(9361, "10.00");
    await f.refund(9361, "10.00");
    expect((await f.state()).status).toBe("cancelled");
    await reconcile(f.storeId, [BigInt(0), BigInt(0)]);
    expect(
      await prisma.weleticPointsLedgerEntry.count({
        where: { storeId: f.storeId },
      }),
    ).toBe(4);
    expect(
      await prisma.weleticCommerceRefund.count({
        where: { storeId: f.storeId },
      }),
    ).toBe(1);
  });

  it("rejects stale-generation refund ingestion before persisting effects", async () => {
    const f = await ingestedRefundFixture();
    await expect(f.refund(9401, "10.00", "stale-generation")).rejects.toThrow();
    expect(
      await prisma.weleticCommerceRefund.count({
        where: { storeId: f.storeId },
      }),
    ).toBe(0);
    expect((await f.state()).status).toBe("rewarded");
    await reconcile(f.storeId, [BigInt(100), BigInt(50)]);
  });

  it("binds, qualifies once under replay, reverses once and prevents requalification", async () => {
    const f = await fixture();
    const binds = await Promise.all(Array.from({ length: 8 }, () => f.bind()));
    expect(new Set(binds.map((r) => r.id)).size).toBe(1);
    const orderId = await f.order();
    const awards = await Promise.all(
      Array.from({ length: 8 }, () => f.qualify(orderId)),
    );
    expect(awards.filter((r) => r.qualified)).toHaveLength(1);
    await reconcile(f.storeId, [BigInt(100), BigInt(50)]);
    const refunds = await Promise.all(
      Array.from({ length: 8 }, (_, i) => f.reverse(orderId, `refund_${i}`)),
    );
    expect(refunds.filter((r) => r.reversed)).toHaveLength(1);
    expect((await f.qualify(orderId)).qualified).toBe(false);
    await reconcile(f.storeId, [BigInt(0), BigInt(0)]);
    expect(
      await prisma.weleticPointsLedgerEntry.count({
        where: { storeId: f.storeId },
      }),
    ).toBe(4);
    expect(
      await prisma.weleticLoyaltyAccount.findUnique({
        where: { id: f.advocate.accountId },
      }),
    ).toMatchObject({ referralCount: 0, referralPointsEarned: BigInt(0) });
  });

  it("serializes competing advocates without changing acquisition ownership", async () => {
    const f = await fixture(),
      other = await f.person("other");
    const results = await Promise.allSettled([
      f.bind(),
      f.bind(f.friend, other),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      await prisma.weleticLoyaltyReferral.count({
        where: { storeId: f.storeId },
      }),
    ).toBe(1);
    await reconcile(f.storeId, [BigInt(0), BigInt(0), BigInt(0)]);
  });

  it("reserves only the final advocate cap slot across different friends", async () => {
    const f = await fixture(),
      second = await f.person("second");
    await f.bind();
    await f.bind(second);
    await prisma.weleticLoyaltyReferralRule.update({
      where: { id: f.ruleId },
      data: { maxReferralsPerAdvocate: 1 },
    });
    const firstOrder = await f.order(),
      secondOrder = await f.order(second, BigInt(1000), "second");
    const results = await Promise.all([
      f.qualify(firstOrder),
      f.qualify(secondOrder, second),
    ]);
    expect(results.filter((r) => r.qualified)).toHaveLength(1);
    await reconcile(f.storeId, [BigInt(100), BigInt(50), BigInt(0)]);
    expect(
      await prisma.weleticLoyaltyAccount.findUnique({
        where: { id: f.advocate.accountId },
      }),
    ).toMatchObject({ referralCount: 1, referralPointsEarned: BigInt(100) });
  });

  it.each([BigInt(999), BigInt(1000)])(
    "uses persisted eligible minor units at minimum boundary %s, not caller subtotal",
    async (net) => {
      const f = await fixture();
      await f.bind();
      expect((await f.qualify(await f.order(f.friend, net))).qualified).toBe(
        net === BigInt(1000),
      );
      await reconcile(
        f.storeId,
        net === BigInt(1000)
          ? [BigInt(100), BigInt(50)]
          : [BigInt(0), BigInt(0)],
      );
    },
  );

  it.each([1, 2, null])(
    "holds historical first-payment referral on subscription sequence %s and does not fraud-block later orders",
    async (subscriptionSequence) => {
      const f = await fixture();
      await f.bind();
      await prisma.weleticLoyaltyReferralRule.update({
        where: { id: f.ruleId },
        data: {
          purchasePolicy: {
            purchaseType: "both",
            subscriptionCadence: "first_payment",
            subscriptionPaymentLimit: null,
          },
        },
      });
      const orderId = await f.order();
      await prisma.weleticCommerceOrderLine.updateMany({
        where: { orderId },
        data: {
          sellingPlanId: "synthetic-plan",
          subscriptionSeriesKey: "selling-plan:synthetic:item:synthetic",
          subscriptionSequence,
        },
      });
      const result = await f.qualify(orderId);
      expect(result.qualified).toBe(false);
      expect(result.reason).toMatch(/verified subscription billing cycle/);
      const referral = await prisma.weleticLoyaltyReferral.findFirstOrThrow({
        where: { storeId: f.storeId, refereeAccountId: f.friend.accountId },
      });
      expect(referral.status).toBe("pending");
      expect(referral.metadata).toMatchObject({
        subscriptionCadenceHoldOrderId: orderId,
      });
      expect(
        await prisma.weleticReconciliationIssue.findUnique({
          where: {
            storeId_kind_externalKey: {
              storeId: f.storeId,
              kind: "loyalty_referral_subscription_cycle_unverified",
              externalKey: `${referral.id}:${orderId}`,
            },
          },
        }),
      ).toMatchObject({ severity: "critical", status: "open" });
      const laterOrderId = await f.order(f.friend, BigInt(1000), "later");
      await prisma.weleticShopper.update({
        where: { id: f.friend.shopperId },
        data: { ordersCount: 2 },
      });
      expect((await f.qualify(laterOrderId)).qualified).toBe(false);
      expect((await f.qualify(orderId)).reason).toMatch(
        /awaits verified subscription billing cycle/,
      );
      expect(
        await prisma.weleticLoyaltyReferral.findUnique({
          where: { id: referral.id },
        }),
      ).toMatchObject({ status: "pending" });
      await reconcile(f.storeId, [BigInt(0), BigInt(0)]);
    },
  );

  it("creates a safe one-time referral default when the runtime restores a missing rule", async () => {
    const f = await fixture();
    await prisma.weleticLoyaltyReferralRule.delete({
      where: { id: f.ruleId },
    });
    await f.bind();
    const restored = await prisma.weleticLoyaltyReferralRule.findFirstOrThrow({
      where: { programId: f.loyaltyId, isActive: true },
    });
    expect(restored.purchasePolicy).toMatchObject({
      purchaseType: "one_time",
      subscriptionCadence: "first_payment",
    });
  });

  it("holds a mixed historical first-payment cart when its one-time portion is below the referral minimum", async () => {
    const f = await fixture();
    await f.bind();
    await prisma.weleticLoyaltyReferralRule.update({
      where: { id: f.ruleId },
      data: {
        purchasePolicy: {
          purchaseType: "both",
          subscriptionCadence: "first_payment",
          subscriptionPaymentLimit: null,
        },
      },
    });
    const orderId = await f.order();
    await prisma.weleticCommerceOrderLine.updateMany({
      where: { orderId },
      data: { shopNet: BigInt(500), presentmentNet: BigInt(500) },
    });
    await prisma.weleticCommerceOrderLine.create({
      data: {
        id: `subscription_${orderId}`,
        orderId,
        externalId: `subscription_${orderId}`,
        title: "Synthetic subscription",
        quantity: 1,
        shopGross: BigInt(500),
        shopNet: BigInt(500),
        presentmentGross: BigInt(500),
        presentmentNet: BigInt(500),
        accountingNet: BigInt(500),
        commissionableAccountingAmount: BigInt(500),
        sellingPlanId: "synthetic-plan",
        subscriptionSeriesKey: "selling-plan:synthetic:item:synthetic",
        subscriptionSequence: 1,
      },
    });
    expect((await f.qualify(orderId)).reason).toMatch(
      /verified subscription billing cycle/,
    );
    const laterOrderId = await f.order(f.friend, BigInt(1000), "later");
    await prisma.weleticShopper.update({
      where: { id: f.friend.shopperId },
      data: { ordersCount: 2 },
    });
    expect((await f.qualify(laterOrderId)).qualified).toBe(false);
    expect(
      await prisma.weleticLoyaltyReferral.findFirstOrThrow({
        where: { storeId: f.storeId, refereeAccountId: f.friend.accountId },
      }),
    ).toMatchObject({ status: "pending" });
    await reconcile(f.storeId, [BigInt(0), BigInt(0)]);
  });

  it("holds an unprocessed subscription order after a later order raises the shopper count", async () => {
    const f = await fixture();
    await f.bind();
    await prisma.weleticLoyaltyReferralRule.update({
      where: { id: f.ruleId },
      data: {
        purchasePolicy: {
          purchaseType: "both",
          subscriptionCadence: "first_payment",
          subscriptionPaymentLimit: null,
        },
      },
    });
    const firstOrderId = await f.order();
    await prisma.weleticCommerceOrderLine.updateMany({
      where: { orderId: firstOrderId },
      data: {
        sellingPlanId: "synthetic-plan",
        subscriptionSeriesKey: null,
        subscriptionSequence: null,
      },
    });
    await f.order(f.friend, BigInt(1000), "later");
    await prisma.weleticShopper.update({
      where: { id: f.friend.shopperId },
      data: { ordersCount: 2 },
    });
    expect((await f.qualify(firstOrderId)).reason).toMatch(
      /first-order and subscription-cycle reconciliation/,
    );
    const referral = await prisma.weleticLoyaltyReferral.findFirstOrThrow({
      where: { storeId: f.storeId, refereeAccountId: f.friend.accountId },
    });
    expect(referral).toMatchObject({
      status: "pending",
      metadata: { subscriptionCadenceHoldOrderId: firstOrderId },
    });
    await reconcile(f.storeId, [BigInt(0), BigInt(0)]);
  });

  it("rejects legacy activation of an unverified historical referral policy at the shared writer", async () => {
    const f = await fixture();
    await expect(
      prisma.$transaction((tx) =>
        writeReferralRuleInTransaction({
          tx,
          storeId: f.storeId,
          ruleId: f.ruleId,
          ruleData: {
            advocatePointsReward: BigInt(100),
            refereePointsReward: BigInt(50),
            advocateRewardKind: "points",
            refereeRewardKind: "points",
            advocateRewardDefinitionId: null,
            refereeRewardDefinitionId: null,
            minQualifyingOrderSubtotal: new Prisma.Decimal("10"),
            maxReferralsPerAdvocate: null,
            fraudCheckSameIp: false,
            isActive: true,
          },
        }),
      ),
    ).rejects.toThrow(/verified subscription cycles/);
    const unchanged = await prisma.weleticLoyaltyReferralRule.findUniqueOrThrow(
      {
        where: { id: f.ruleId },
      },
    );
    expect(unchanged.purchasePolicy).toBeNull();
    expect(unchanged.isActive).toBe(true);
  });

  it("claws back already-spent points as exact debt without minting replacements", async () => {
    const f = await fixture();
    await f.bind();
    const orderId = await f.order();
    await f.qualify(orderId);
    await appendPointsLedgerEntry({
      storeId: f.storeId,
      accountId: f.advocate.accountId,
      entryType: "REDEEM_REWARD",
      pointsDelta: -BigInt(100),
      idempotencyKey: "synthetic-spend",
    });
    await f.reverse(orderId);
    await reconcile(f.storeId, [-BigInt(100), BigInt(0)]);
  });

  it.each(["stale_generation", "disabled", "closed_friend", "closed_advocate"])(
    "contains %s before qualification",
    async (mode) => {
      const f = await fixture();
      await f.bind();
      const orderId = await f.order();
      if (mode === "stale_generation")
        await prisma.weleticShopifyStore.update({
          where: { id: f.storeId },
          data: { installationGeneration: "replacement" },
        });
      if (mode === "disabled")
        await prisma.weleticLoyaltyProgram.update({
          where: { id: f.loyaltyId },
          data: { killSwitchActive: true },
        });
      if (mode.startsWith("closed"))
        await prisma.weleticLoyaltyAccount.update({
          where: {
            id:
              mode === "closed_friend"
                ? f.friend.accountId
                : f.advocate.accountId,
          },
          data: { status: "closed" },
        });
      const result = await Promise.allSettled([f.qualify(orderId)]);
      if (result[0].status === "fulfilled")
        expect(result[0].value.qualified).toBe(false);
      await reconcile(f.storeId, [BigInt(0), BigInt(0)]);
    },
  );

  it("rejects cross-store qualification without changing either tenant", async () => {
    const f = await fixture(),
      other = await fixture();
    await f.bind();
    const orderId = await f.order();
    await expect(
      evaluateReferralQualification({
        storeId: other.storeId,
        orderId,
        refereeShopperId: f.friend.shopperId,
        orderSubtotal: BigInt(1000),
        currency: "USD",
        expectedInstallationGeneration: other.generation,
      }),
    ).rejects.toThrow("another Shopify store");
    await reconcile(f.storeId, [BigInt(0), BigInt(0)]);
    await reconcile(other.storeId, [BigInt(0), BigInt(0)]);
  });

  it("rechecks first-order eligibility after waiting for transaction admission", async () => {
    const f = await fixture();
    await f.bind();
    const orderId = await f.order();
    hooks.beforeTransaction.mockImplementationOnce(async () => {
      await prisma.weleticShopper.update({
        where: { id: f.friend.shopperId },
        data: { ordersCount: 2 },
      });
    });
    expect((await f.qualify(orderId)).qualified).toBe(false);
    expect(
      await prisma.weleticLoyaltyReferral.findFirst({
        where: { storeId: f.storeId },
      }),
    ).toMatchObject({ status: "fraud_blocked" });
    await reconcile(f.storeId, [BigInt(0), BigInt(0)]);
  });

  it.each(["closed", "redacted", "different_program"])(
    "rechecks %s after the optimistic account read",
    async (change) => {
      const f = await fixture();
      await f.bind();
      const orderId = await f.order();
      const other = change === "different_program" ? await fixture() : null;
      hooks.beforeTransaction.mockImplementationOnce(async () => {
        await prisma.weleticLoyaltyAccount.update({
          where: { id: f.friend.accountId },
          data:
            change === "closed"
              ? { status: "closed" }
              : change === "different_program"
                ? { programId: other!.loyaltyId }
                : {
                    metadata: {
                      shopifyCustomerRedaction: {
                        status: "redacted",
                        redactedAt: new Date().toISOString(),
                        source: "shopify_customers_redact",
                      },
                    },
                  },
        });
      });
      expect((await f.qualify(orderId)).qualified).toBe(false);
      await reconcile(f.storeId, [BigInt(0), BigInt(0)]);
    },
  );

  it("rolls back awards, cap and outbox atomically when finalization fails", async () => {
    const f = await fixture();
    await f.bind();
    const orderId = await f.order();
    const jobs = await prisma.weleticLoyaltyOutboxJob.count({
      where: { storeId: f.storeId },
    });
    hooks.beforeCommit.mockRejectedValueOnce(
      new Error("Synthetic SQL finalization failure"),
    );
    await expect(f.qualify(orderId)).rejects.toThrow(
      "Synthetic SQL finalization failure",
    );
    await reconcile(f.storeId, [BigInt(0), BigInt(0)]);
    expect(
      await prisma.weleticLoyaltyOutboxJob.count({
        where: { storeId: f.storeId },
      }),
    ).toBe(jobs);
    expect(
      await prisma.weleticLoyaltyAccount.findUnique({
        where: { id: f.advocate.accountId },
      }),
    ).toMatchObject({ referralCount: 0, referralPointsEarned: BigInt(0) });
    expect(
      await prisma.weleticLoyaltyReferral.findFirst({
        where: { storeId: f.storeId },
      }),
    ).toMatchObject({ status: "pending" });
  });

  it.each(["issued", "used"] as const)(
    "preserves coupon snapshot and contains refund of a synthetic %s coupon",
    async (status) => {
      const f = await fixture();
      await f.bind();
      const orderId = await f.order();
      const rewardId = `reward_${f.storeId}`;
      await prisma.weleticRewardDefinition.create({
        data: {
          id: rewardId,
          storeId: f.storeId,
          name: "Original reward",
          rewardType: "amount_off",
          pointsCost: BigInt(100),
          discountValue: "5.00",
        },
      });
      await prisma.weleticLoyaltyReferralRule.update({
        where: { id: f.ruleId },
        data: {
          advocateRewardKind: "coupon",
          advocateRewardDefinitionId: rewardId,
        },
      });
      const result = await f.qualify(orderId);
      expect(result).toMatchObject({
        qualified: true,
        couponProvisioning: true,
        advocatePointsAwarded: BigInt(0),
        refereePointsAwarded: BigInt(50),
      });
      const referral = await prisma.weleticLoyaltyReferral.findFirstOrThrow({
        where: { storeId: f.storeId },
      });
      const job = await prisma.weleticLoyaltyOutboxJob.findFirstOrThrow({
        where: { storeId: f.storeId, jobType: "REFERRAL_REWARD_PROVISION" },
      });
      await prisma.weleticRewardDefinition.update({
        where: { id: rewardId },
        data: { name: "Edited reward", discountValue: "99.00" },
      });
      expect((await f.qualify(orderId)).qualified).toBe(false);
      expect(
        await prisma.weleticLoyaltyOutboxJob.findUnique({
          where: { id: job.id },
        }),
      ).toMatchObject({ payload: job.payload });
      // Synthetic provider state exercises refund containment, not issuance or
      // checkout acceptance. No Shopify provider is invoked by this suite.
      const redemptionId = `redemption_${f.storeId}`;
      await prisma.weleticRewardRedemption.create({
        data: {
          id: redemptionId,
          storeId: f.storeId,
          accountId: f.advocate.accountId,
          rewardDefinitionId: rewardId,
          pointsSpent: BigInt(0),
          shopifyDiscountCode: "FIXTURE",
          shopifyDiscountCodeCanonical: "FIXTURE",
          status,
          idempotencyKey: getReferralCouponIdempotencyKey({
            referralId: referral.id,
            qualificationOrderId: orderId,
            side: "advocate",
          }),
        },
      });
      await f.reverse(orderId);
      expect(
        await prisma.weleticRewardRedemption.findUnique({
          where: { id: redemptionId },
        }),
      ).toMatchObject({ status: status === "used" ? "used" : "cancelled" });
      expect(
        await prisma.weleticLoyaltyAccount.findUnique({
          where: { id: f.advocate.accountId },
        }),
      ).toMatchObject({ referralCount: status === "used" ? 1 : 0 });
      expect(
        await prisma.weleticLoyaltyOutboxJob.count({
          where: { storeId: f.storeId, jobType: "REDEMPTION_RECOVERY" },
        }),
      ).toBe(status === "used" ? 0 : 1);
      await reconcile(f.storeId, [BigInt(0), BigInt(0)]);
    },
  );
});
