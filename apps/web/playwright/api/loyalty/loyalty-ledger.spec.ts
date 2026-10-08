import { prisma } from "@/lib/prisma";
import { expect } from "@playwright/test";
import { randomName } from "../../utils";
import { test } from "../fixtures";

test.describe.configure({
  mode: "parallel",
});

async function setupLoyaltyTestEnvironment(
  workspaceId: string,
  programId: string,
) {
  const store = await prisma.weleticShopifyStore.upsert({
    where: { projectId: workspaceId },
    create: {
      id: `wstore_loyalty_${Date.now()}_${randomName("s")}`,
      projectId: workspaceId,
      programId,
      shopDomain: `playwright-loyalty-${randomName("store")}.myshopify.com`,
      shopCurrency: "USD",
      apiVersion: "2026-10",
      installationGeneration: "gen_playwright_loyalty",
    },
    update: {
      shopCurrency: "USD",
      apiVersion: "2026-10",
      installationGeneration: "gen_playwright_loyalty",
    },
  });

  const loyaltyProgram = await prisma.weleticLoyaltyProgram.upsert({
    where: { storeId: store.id },
    create: {
      id: `wlp_${Date.now()}_${randomName("p")}`,
      storeId: store.id,
      name: "Playwright VIP Loyalty",
      status: "active",
    },
    update: {
      status: "active",
    },
  });

  const shopperId = `shopper_${Date.now()}_${randomName("c")}`;
  const shopifyCustomerId = String(
    Date.now() + Math.floor(Math.random() * 10000),
  );
  const shopper = await prisma.weleticShopper.create({
    data: {
      id: shopperId,
      storeId: store.id,
      shopifyCustomerId,
      firstName: "Loyalty",
      lastName: "Tester",
      email: `shopper_${randomName("cust")}@example.com`,
    },
  });

  const accountId = `wla_${Date.now()}_${randomName("a")}`;
  const account = await prisma.weleticLoyaltyAccount.create({
    data: {
      id: accountId,
      storeId: store.id,
      programId: loyaltyProgram.id,
      shopperId: shopper.id,
      status: "active",
      cachedPointsBalance: BigInt(500),
    },
  });

  return { store, loyaltyProgram, shopper, account };
}

test("POST /api/shopify/loyalty/admin/adjust – mutates customer loyalty points balance positively", async ({
  api,
  workspace,
  program,
}) => {
  const env = await setupLoyaltyTestEnvironment(workspace.id, program.id);
  const idempotencyKey = `adj_grant_${Date.now()}_${randomName("pt")}`;

  const adjustmentPayload = {
    accountId: env.account.id,
    pointsDelta: 150,
    reason: "Playwright API Bonus Points Grant",
    notes: "Automated test point mutation",
    idempotencyKey,
  };

  const { status, data } = await api.post<{
    success: boolean;
    ledgerEntryId: string;
    accountId: string;
    pointsDelta: string;
    balanceAfter: string;
    reason: string;
  }>(
    `/api/shopify/loyalty/admin/adjust?workspaceId=${workspace.id}`,
    adjustmentPayload,
  );

  expect(status).toBe(200);
  expect(data).toMatchObject({
    success: true,
    ledgerEntryId: expect.any(String),
    accountId: env.account.id,
    pointsDelta: "150",
    reason: "Playwright API Bonus Points Grant",
  });
  expect(Number(data.balanceAfter)).toBeGreaterThanOrEqual(650);
});

test("POST /api/shopify/loyalty/admin/adjust – supports negative adjustments (points deduction)", async ({
  api,
  workspace,
  program,
}) => {
  const env = await setupLoyaltyTestEnvironment(workspace.id, program.id);
  const idempotencyKey = `adj_deduct_${Date.now()}_${randomName("pt")}`;

  const adjustmentPayload = {
    accountId: env.account.id,
    pointsDelta: -100,
    reason: "Playwright Points Deduction Correction",
    idempotencyKey,
  };

  const { status, data } = await api.post<{
    success: boolean;
    pointsDelta: string;
    balanceAfter: string;
  }>(
    `/api/shopify/loyalty/admin/adjust?workspaceId=${workspace.id}`,
    adjustmentPayload,
  );

  expect(status).toBe(200);
  expect(data).toMatchObject({
    success: true,
    pointsDelta: "-100",
  });
  expect(Number(data.balanceAfter)).toBe(400);
});

test("POST /api/shopify/loyalty/admin/adjust – rejects missing target account with 404", async ({
  api,
  workspace,
  program,
}) => {
  await setupLoyaltyTestEnvironment(workspace.id, program.id);

  const invalidPayload = {
    accountId: "wla_nonexistent_account_99999",
    pointsDelta: 50,
    reason: "Invalid account target",
    idempotencyKey: `adj_err_${Date.now()}`,
  };

  const { status, data } = await api.post<{
    error: { code: string; message: string };
  }>(
    `/api/shopify/loyalty/admin/adjust?workspaceId=${workspace.id}`,
    invalidPayload,
  );

  expect(status).toBe(404);
  expect(data.error.message).toContain("not found");
});

test("POST /api/shopify/loyalty/admin/adjust – rejects invalid point delta with 400", async ({
  api,
  workspace,
  program,
}) => {
  const env = await setupLoyaltyTestEnvironment(workspace.id, program.id);

  const invalidPayload = {
    accountId: env.account.id,
    pointsDelta: 0, // 0 points delta is invalid
    reason: "Zero delta",
    idempotencyKey: `adj_zero_${Date.now()}`,
  };

  const { status } = await api.post(
    `/api/shopify/loyalty/admin/adjust?workspaceId=${workspace.id}`,
    invalidPayload,
  );

  expect(status).toBe(400);
});

test("POST /api/shopify/loyalty/admin/rewards – provisions reward voucher definition and performs lifecycle mutations", async ({
  api,
  workspace,
  program,
}) => {
  await setupLoyaltyTestEnvironment(workspace.id, program.id);
  const rewardName = `Playwright Voucher ${randomName("reward")}`;

  const createPayload = {
    name: rewardName,
    description: "10 dollars off entire order for 500 points",
    rewardType: "amount_off",
    salesChannel: "online_store",
    exchangeType: "fixed",
    pointsCost: 500,
    discountValue: 1000, // $10.00 in minor units
  };

  // 1. Create reward voucher definition
  const { status: createStatus, data: createdReward } = await api.post<{
    id: string;
    name: string;
    rewardType: string;
    pointsCost: string;
    discountValue: string;
  }>(
    `/api/shopify/loyalty/admin/rewards?workspaceId=${workspace.id}`,
    createPayload,
  );

  expect([200, 201]).toContain(createStatus);
  expect(createdReward).toMatchObject({
    id: expect.any(String),
    name: rewardName,
    rewardType: "amount_off",
    pointsCost: "500",
  });
  const rewardId = createdReward.id;

  try {
    // 2. Query reward voucher list
    const { status: listStatus, data: rewardsList } = await api.get<
      Array<{ id: string; name: string }>
    >(`/api/shopify/loyalty/admin/rewards?workspaceId=${workspace.id}`);

    expect(listStatus).toBe(200);
    expect(rewardsList).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: rewardId,
          name: rewardName,
        }),
      ]),
    );

    // 3. Update reward definition
    const updatedName = `${rewardName} (Updated)`;
    const { status: updateStatus, data: updatedReward } = await api.put<{
      id: string;
      name: string;
      pointsCost: string;
    }>(`/api/shopify/loyalty/admin/rewards?workspaceId=${workspace.id}`, {
      id: rewardId,
      name: updatedName,
      pointsCost: 600,
    });

    expect(updateStatus).toBe(200);
    expect(updatedReward.name).toBe(updatedName);
    expect(updatedReward.pointsCost).toBe("600");

    // 4. Archive (DELETE) reward definition
    const { status: deleteStatus, data: deleteData } = await api.delete<{
      success: boolean;
      archivedId: string;
    }>(
      `/api/shopify/loyalty/admin/rewards?workspaceId=${workspace.id}&id=${rewardId}`,
    );

    expect(deleteStatus).toBe(200);
    expect(deleteData).toMatchObject({
      success: true,
      archivedId: rewardId,
    });
  } finally {
    await prisma.weleticRewardDefinition
      .deleteMany({ where: { id: rewardId } })
      .catch(() => {});
  }
});

test("POST /api/shopify/loyalty/customer/redeem – redirects to authenticated gateway with 410 Gone", async ({
  api,
}) => {
  const { status, data } = await api.post<{
    error: { code: string; message: string };
  }>("/api/shopify/loyalty/customer/redeem", {
    rewardId: "rw_test",
  });

  expect(status).toBe(410);
  expect(data.error.code).toBe("gone");
  expect(data.error.message).toContain("authenticated Shopify loyalty gateway");
});

test("POST /api/internal/shopify/loyalty/customer/redeem – rejects unauthenticated service request with 401", async ({
  request,
}) => {
  const response = await request.post(
    "/api/internal/shopify/loyalty/customer/redeem",
    {
      data: JSON.stringify({
        shop: "yamax-test.myshopify.com",
        shopifyCustomerId: "12345",
        rewardDefinitionId: "rw_123",
        idempotencyKey: `idemp_${Date.now()}`,
      }),
      headers: {
        "Content-Type": "application/json",
      },
    },
  );

  expect(response.status()).toBe(401);
});

test("GET /api/shopify/loyalty/admin/activity – retrieves paginated points ledger transaction history", async ({
  api,
  workspace,
  program,
}) => {
  const env = await setupLoyaltyTestEnvironment(workspace.id, program.id);

  // Generate a ledger entry by making an adjustment
  await api.post(
    `/api/shopify/loyalty/admin/adjust?workspaceId=${workspace.id}`,
    {
      accountId: env.account.id,
      pointsDelta: 250,
      reason: "Activity Ledger Verification Entry",
      idempotencyKey: `act_test_${Date.now()}_${randomName("act")}`,
    },
  );

  // Query activity history
  const { status, data } = await api.get<{
    entries: Array<{
      id: string;
      entryType: string;
      pointsDelta: string;
      balanceAfter: string;
      reason: string;
      createdAt: string;
    }>;
    pagination: {
      total: number;
      page: number;
      limit: number;
      totalPages: number;
    };
  }>(
    `/api/shopify/loyalty/admin/activity?workspaceId=${workspace.id}&page=1&limit=10`,
  );

  expect(status).toBe(200);
  expect(data.entries).toBeInstanceOf(Array);
  expect(data.entries.length).toBeGreaterThanOrEqual(1);
  expect(data.pagination).toMatchObject({
    page: 1,
    limit: 10,
    total: expect.any(Number),
  });

  // Check structure of first entry
  const entry = data.entries[0];
  expect(entry).toMatchObject({
    id: expect.any(String),
    entryType: expect.any(String),
    pointsDelta: expect.any(String),
    balanceAfter: expect.any(String),
  });
});

test("GET /api/shopify/loyalty/admin/activity – supports filtering by entry type", async ({
  api,
  workspace,
  program,
}) => {
  await setupLoyaltyTestEnvironment(workspace.id, program.id);

  const { status, data } = await api.get<{
    entries: Array<{ entryType: string }>;
  }>(
    `/api/shopify/loyalty/admin/activity?workspaceId=${workspace.id}&type=MANUAL_ADJUSTMENT`,
  );

  expect(status).toBe(200);
  for (const entry of data.entries) {
    expect(entry.entryType).toBe("MANUAL_ADJUSTMENT");
  }
});

test("GET /api/shopify/loyalty/admin/activity – validates query parameters and rejects invalid limit with 400", async ({
  api,
  workspace,
  program,
}) => {
  await setupLoyaltyTestEnvironment(workspace.id, program.id);

  const { status, data } = await api.get<{
    error: { code: string; message: string };
  }>(
    `/api/shopify/loyalty/admin/activity?workspaceId=${workspace.id}&limit=500`, // Max is 100
  );

  expect(status).toBe(400);
  expect(data.error.message).toContain(
    "limit must be an integer between 1 and 100",
  );
});
