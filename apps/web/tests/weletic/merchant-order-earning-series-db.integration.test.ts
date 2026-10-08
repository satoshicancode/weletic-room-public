import { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { readMerchantOrderEarningSeries } from "../../lib/weletic/loyalty/order-earning-series";

const database = new PrismaClient();
const suffix = randomBytes(6).toString("hex");
const storeIds = [0, 1].map((index) => `order_rate_store_${index}_${suffix}`);
const projectIds = [0, 1].map(
  (index) => `order_rate_project_${index}_${suffix}`,
);
const programIds = [0, 1].map(
  (index) => `order_rate_program_${index}_${suffix}`,
);
const loyaltyIds = [0, 1].map(
  (index) => `order_rate_loyalty_${index}_${suffix}`,
);
const shopperIds = [0, 1].map(
  (index) => `order_rate_shopper_${index}_${suffix}`,
);
const accountIds = [0, 1].map(
  (index) => `order_rate_account_${index}_${suffix}`,
);
let verified = false;

function requireDisposableTarget() {
  const url = new URL(process.env.DATABASE_URL ?? "invalid:");
  const match = /^\/weletic_loyalty_it_order_rate_([a-f0-9]{12})$/.exec(
    url.pathname,
  );
  if (
    process.env.LOYALTY_ORDER_RATE_DATABASE_INTEGRATION !== "1" ||
    url.protocol !== "mysql:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "3310" ||
    !match ||
    url.username !== `wor_${match[1]}` ||
    !url.password ||
    url.hash ||
    [...url.searchParams].some(
      ([key, value]) =>
        key !== "connection_limit" || !/^(?:[1-9]|1[0-9]|20)$/.test(value),
    )
  )
    throw new Error("Refusing non-isolated order earning database");
  return {
    databaseName: url.pathname.slice(1),
    principal: `${url.username}@%`,
  };
}

async function createOrder({
  store,
  number,
  occurredAt,
  grossPoints,
  status = "paid",
}: {
  store: 0 | 1;
  number: number;
  occurredAt: string;
  grossPoints: bigint | null;
  status?: "paid" | "refunded" | "pending" | "voided";
}) {
  const orderId = `order_rate_order_${store}_${number}_${suffix}`;
  await database.weleticCommerceOrder.create({
    data: {
      id: orderId,
      storeId: storeIds[store],
      programId: programIds[store],
      shopperId: shopperIds[store],
      externalId: `gid://shopify/Order/${store}${number}${suffix}`,
      status,
      presentmentCurrency: "USD",
      presentmentSubtotal: BigInt(1_000),
      presentmentNet: BigInt(1_000),
      presentmentTotal: BigInt(1_000),
      shopCurrency: "USD",
      shopSubtotal: BigInt(1_000),
      shopNet: BigInt(1_000),
      shopTotal: BigInt(1_000),
      accountingCurrency: "USD",
      accountingNet: BigInt(1_000),
      accountingTotal: BigInt(1_000),
      accountingFxRate: "1",
      occurredAt: new Date(occurredAt),
    },
  });
  if (grossPoints !== null)
    await database.weleticLoyaltyEarnGrant.create({
      data: {
        id: `order_rate_grant_${store}_${number}_${suffix}`,
        storeId: storeIds[store],
        programId: loyaltyIds[store],
        accountId: accountIds[store],
        shopperId: shopperIds[store],
        orderId,
        status: status === "refunded" ? "voided" : "pending",
        currency: "USD",
        eligibleSubtotalAmount: BigInt(1_000),
        orderTotalAmount: BigInt(1_000),
        grossPoints,
        pendingPoints: status === "refunded" ? BigInt(0) : grossPoints,
        reversedPoints: status === "refunded" ? grossPoints : BigInt(0),
        availableAt: new Date("2026-10-01T00:00:00Z"),
        pointsPerCurrencyUnit: "1",
        effectiveMultiplier: "1",
      },
    });
  return orderId;
}

beforeAll(async () => {
  const target = requireDisposableTarget();
  expect(
    await database.$queryRaw`SELECT DATABASE() AS databaseName, CURRENT_USER() AS principal`,
  ).toEqual([target]);
  expect(await database.weleticShopifyStore.count()).toBe(0);
  expect(await database.weleticCommerceOrder.count()).toBe(0);
  expect(await database.weleticLoyaltyEarnGrant.count()).toBe(0);
  verified = true;
  for (const index of [0, 1]) {
    await database.project.create({
      data: {
        id: projectIds[index],
        name: "Order rate SQL",
        slug: projectIds[index],
        billingCycleStart: 1,
      },
    });
    await database.program.create({
      data: {
        id: programIds[index],
        workspaceId: projectIds[index],
        defaultFolderId: `folder_${index}_${suffix}`,
        defaultGroupId: `group_${index}_${suffix}`,
        name: "Order rate SQL",
        slug: programIds[index],
      },
    });
    await database.weleticShopifyStore.create({
      data: {
        id: storeIds[index],
        projectId: projectIds[index],
        programId: programIds[index],
        shopDomain: `order-rate-${index}-${suffix}.myshopify.com`,
        shopCurrency: "USD",
        apiVersion: "2026-07",
      },
    });
    await database.weleticLoyaltyProgram.create({
      data: {
        id: loyaltyIds[index],
        storeId: storeIds[index],
        status: "active",
      },
    });
    await database.weleticShopper.create({
      data: {
        id: shopperIds[index],
        storeId: storeIds[index],
        shopifyCustomerId: `customer_${index}_${suffix}`,
      },
    });
    await database.weleticLoyaltyAccount.create({
      data: {
        id: accountIds[index],
        storeId: storeIds[index],
        programId: loyaltyIds[index],
        shopperId: shopperIds[index],
      },
    });
  }
});

afterAll(async () => {
  if (verified) {
    await database.weleticLoyaltyEarnGrant.deleteMany({
      where: { storeId: { in: storeIds } },
    });
    await database.weleticCommerceOrderLine.deleteMany({
      where: { order: { storeId: { in: storeIds } } },
    });
    await database.weleticCommerceOrder.deleteMany({
      where: { storeId: { in: storeIds } },
    });
    await database.weleticLoyaltyAccount.deleteMany({
      where: { storeId: { in: storeIds } },
    });
    await database.weleticShopper.deleteMany({
      where: { storeId: { in: storeIds } },
    });
    await database.weleticLoyaltyProgram.deleteMany({
      where: { storeId: { in: storeIds } },
    });
    await database.weleticShopifyStore.deleteMany({
      where: { id: { in: storeIds } },
    });
    for (const id of programIds)
      await database.$executeRaw`DELETE FROM Program WHERE id = ${id}`;
    for (const id of projectIds)
      await database.$executeRaw`DELETE FROM Project WHERE id = ${id}`;
  }
  await database.$disconnect();
});

it("reconciles daily recorded-order denominators and positive grant numerators", async () => {
  const mixedOrderId = await createOrder({
    store: 0,
    number: 1,
    occurredAt: "2026-09-01T00:00:00.000Z",
    grossPoints: BigInt(100),
  });
  await database.weleticCommerceOrderLine.createMany({
    data: [0, 1].map((index) => ({
      id: `order_rate_line_${index}_${suffix}`,
      orderId: mixedOrderId,
      externalId: `gid://shopify/LineItem/${index}${suffix}`,
      title: "Isolated mixed order",
      quantity: 1,
      ...(index === 1 ? { sellingPlanId: "gid://shopify/SellingPlan/1" } : {}),
      presentmentGross: BigInt(500),
      presentmentNet: BigInt(500),
      shopGross: BigInt(500),
      shopNet: BigInt(500),
      accountingNet: BigInt(500),
      commissionableAccountingAmount: BigInt(500),
    })),
  });
  await createOrder({
    store: 0,
    number: 2,
    occurredAt: "2026-09-01T12:00:00.000Z",
    grossPoints: null,
  });
  await createOrder({
    store: 0,
    number: 3,
    occurredAt: "2026-09-01T23:59:59.999Z",
    grossPoints: BigInt(100),
    status: "refunded",
  });
  await createOrder({
    store: 0,
    number: 4,
    occurredAt: "2026-09-02T00:00:00.000Z",
    grossPoints: BigInt(0),
    status: "pending",
  });
  await createOrder({
    store: 1,
    number: 5,
    occurredAt: "2026-09-01T12:00:00.000Z",
    grossPoints: BigInt(500),
  });
  const startAt = new Date("2026-09-01T00:00:00.000Z");
  const endAt = new Date("2026-09-03T23:59:59.999Z");
  const plan = await database.$queryRaw<Array<Record<string, unknown>>>`
    EXPLAIN SELECT DATE_FORMAT(o.occurredAt, '%Y-%m-%d'), COUNT(*)
    FROM WeleticCommerceOrder o
    LEFT JOIN WeleticLoyaltyEarnGrant g
      ON g.storeId = o.storeId AND g.orderId = o.id
    WHERE o.storeId = ${storeIds[0]} AND o.occurredAt >= ${startAt} AND o.occurredAt <= ${endAt}
    GROUP BY DATE_FORMAT(o.occurredAt, '%Y-%m-%d')
  `;
  expect(Object.values(plan[0]).map(String).join(" ")).toContain(
    "WeleticCommerceOrder_storeId_occurredAt_idx",
  );
  const result = await database.$transaction((tx) =>
    readMerchantOrderEarningSeries({
      tx,
      storeId: storeIds[0],
      startAt,
      endAt,
    }),
  );
  expect(result).toEqual({
    status: "available",
    bucket: "utc_day",
    coverage: "recorded_orders_only",
    rows: [
      {
        date: "2026-09-01",
        recordedOrders: "3",
        earningOrders: "2",
        rateBasisPoints: "6667",
      },
      {
        date: "2026-09-02",
        recordedOrders: "1",
        earningOrders: "0",
        rateBasisPoints: "0",
      },
      {
        date: "2026-09-03",
        recordedOrders: "0",
        earningOrders: "0",
        rateBasisPoints: null,
      },
    ],
  });
  const independentOrders = await database.weleticCommerceOrder.count({
    where: { storeId: storeIds[0], occurredAt: { gte: startAt, lte: endAt } },
  });
  const independentEarns = await database.weleticLoyaltyEarnGrant.count({
    where: {
      storeId: storeIds[0],
      grossPoints: { gt: BigInt(0) },
      order: { occurredAt: { gte: startAt, lte: endAt } },
    },
  });
  expect(independentOrders).toBe(4);
  expect(independentEarns).toBe(2);
  if (result.status !== "available") throw new Error("Series unavailable");
  expect(
    result.rows.reduce(
      (sum, row) => sum + BigInt(row.recordedOrders),
      BigInt(0),
    ),
  ).toBe(BigInt(independentOrders));
  expect(
    result.rows.reduce(
      (sum, row) => sum + BigInt(row.earningOrders),
      BigInt(0),
    ),
  ).toBe(BigInt(independentEarns));
  expect(JSON.stringify(result)).not.toMatch(/customer_|shopper_|account_/);
});
