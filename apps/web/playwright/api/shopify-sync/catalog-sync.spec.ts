import { prisma } from "@/lib/prisma";
import { expect } from "@playwright/test";
import { randomName } from "../../utils";
import { test } from "../fixtures";

test.describe.configure({
  mode: "parallel",
});

type CatalogSyncDispatchResponse = {
  success: boolean;
  status: string;
  runId: string;
};

type CatalogSyncPollResponse = {
  runId: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  processedProducts: number;
  totalProducts: number | null;
  errors: string[];
  stats: {
    products?: number;
    variants?: number;
    markets?: number;
    marketPrices?: number;
  };
  startedAt: string;
  completedAt: string | null;
};

/**
 * Ensures a connected Shopify store and installed integration exist for the test workspace.
 */
async function ensureConnectedShopifyStore(
  workspaceId: string,
  programId: string,
) {
  const shopDomain = `playwright-sync-${randomName("store")}.myshopify.com`;
  const store = await prisma.weleticShopifyStore.upsert({
    where: { projectId: workspaceId },
    create: {
      id: `wstore_sync_${Date.now()}_${randomName("s")}`,
      projectId: workspaceId,
      programId,
      shopDomain,
      shopCurrency: "USD",
      apiVersion: "2026-10",
      installationGeneration: "gen_playwright_sync",
    },
    update: {
      shopCurrency: "USD",
      apiVersion: "2026-10",
      installationGeneration: "gen_playwright_sync",
    },
  });

  const user = await prisma.user.findFirst({ select: { id: true } });
  if (user) {
    await prisma.installedIntegration.upsert({
      where: {
        userId_integrationId_projectId: {
          userId: user.id,
          integrationId: "shopify",
          projectId: workspaceId,
        },
      },
      create: {
        id: `inst_sync_${Date.now()}`,
        userId: user.id,
        integrationId: "shopify",
        projectId: workspaceId,
        credentials: {
          shop: store.shopDomain,
          accessToken: "shpat_playwright_test_token_123456",
          installationGeneration: "gen_playwright_sync",
          scope:
            "read_products,read_markets,read_orders,read_translations,read_customers",
        },
      },
      update: {
        credentials: {
          shop: store.shopDomain,
          accessToken: "shpat_playwright_test_token_123456",
          installationGeneration: "gen_playwright_sync",
          scope:
            "read_products,read_markets,read_orders,read_translations,read_customers",
        },
      },
    });
  }

  return store;
}

test("POST /api/shopify/integration/sync – rejects unauthorized request without Bearer token with 401", async ({
  request,
  workspace,
}) => {
  // Use bare request context without Authorization header
  const response = await request.post(
    `/api/shopify/integration/sync?workspaceId=${workspace.id}`,
    {
      headers: {
        "Content-Type": "application/json",
      },
    },
  );

  expect(response.status()).toBe(401);
});

test("POST /api/shopify/integration/sync – rejects non-existent workspace with 404", async ({
  api,
}) => {
  const { status } = await api.post(
    "/api/shopify/integration/sync?workspaceId=ws_nonexistent_workspace_12345",
  );

  expect(status).toBe(404);
});

test("POST /api/shopify/integration/sync – dispatches catalog reconciliation with 202 Accepted", async ({
  api,
  workspace,
  program,
}) => {
  let createdRunId: string | undefined;

  try {
    await ensureConnectedShopifyStore(workspace.id, program.id);

    const { status, data } = await api.post<CatalogSyncDispatchResponse>(
      `/api/shopify/integration/sync?workspaceId=${workspace.id}`,
    );

    // Verify HTTP 202 Accepted per PERF-02 async dispatch specification
    expect(status).toBe(202);
    expect(data).toMatchObject({
      success: true,
      status: "pending",
      runId: expect.any(String),
    });
    createdRunId = data.runId;
    expect(data.runId).toMatch(/^wsync_/);
  } finally {
    if (createdRunId) {
      await prisma.weleticShopifySyncRun
        .delete({ where: { id: createdRunId } })
        .catch(() => {});
    }
  }
});

test("GET /api/shopify/integration/sync – rejects unauthorized request with 401", async ({
  request,
  workspace,
}) => {
  const response = await request.get(
    `/api/shopify/integration/sync?workspaceId=${workspace.id}`,
    {
      headers: {
        "Content-Type": "application/json",
      },
    },
  );

  expect(response.status()).toBe(401);
});

test("GET /api/shopify/integration/sync – polls progress of initiated runId", async ({
  api,
  workspace,
  program,
}) => {
  let runId: string | undefined;

  try {
    const store = await ensureConnectedShopifyStore(workspace.id, program.id);

    // 1. Create a known pending sync run for the workspace
    runId = `wsync_poll_${Date.now()}_${randomName("run")}`;
    await prisma.weleticShopifySyncRun.create({
      data: {
        id: runId,
        storeId: store.id,
        kind: "full_catalog",
        status: "pending",
        stats: { products: 0, variants: 0, markets: 0, marketPrices: 0 },
        startedAt: new Date(),
      },
    });

    // 2. Poll status with runId
    const { status: pollStatus, data: pollData } =
      await api.get<CatalogSyncPollResponse>(
        `/api/shopify/integration/sync?workspaceId=${workspace.id}&runId=${runId}`,
      );

    expect(pollStatus).toBe(200);
    expect(pollData).toMatchObject({
      runId,
      status: "pending",
      processedProducts: 0,
      totalProducts: null,
      errors: [],
      stats: { products: 0, variants: 0, markets: 0, marketPrices: 0 },
      startedAt: expect.any(String),
      completedAt: null,
    });
  } finally {
    if (runId) {
      await prisma.weleticShopifySyncRun
        .delete({ where: { id: runId } })
        .catch(() => {});
    }
  }
});

test("GET /api/shopify/integration/sync – polls completed sync run with statistics", async ({
  api,
  workspace,
  program,
}) => {
  let completedRunId: string | undefined;

  try {
    const store = await ensureConnectedShopifyStore(workspace.id, program.id);

    completedRunId = `wsync_done_${Date.now()}_${randomName("done")}`;
    const startedAt = new Date(Date.now() - 30_000);
    const completedAt = new Date();

    await prisma.weleticShopifySyncRun.create({
      data: {
        id: completedRunId,
        storeId: store.id,
        kind: "full_catalog",
        status: "succeeded",
        stats: { products: 42, variants: 120, markets: 3, marketPrices: 360 },
        startedAt,
        completedAt,
      },
    });

    const { status, data } = await api.get<CatalogSyncPollResponse>(
      `/api/shopify/integration/sync?workspaceId=${workspace.id}&runId=${completedRunId}`,
    );

    expect(status).toBe(200);
    expect(data).toMatchObject({
      runId: completedRunId,
      status: "completed",
      processedProducts: 42,
      totalProducts: null,
      errors: [],
      stats: { products: 42, variants: 120, markets: 3, marketPrices: 360 },
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
    });
  } finally {
    if (completedRunId) {
      await prisma.weleticShopifySyncRun
        .delete({ where: { id: completedRunId } })
        .catch(() => {});
    }
  }
});

test("GET /api/shopify/integration/sync – rejects non-existent runId with 404 (Anti-IDOR)", async ({
  api,
  workspace,
}) => {
  const nonexistentRunId = "wsync_nonexistent_run_99999999";
  const { status, data } = await api.get<{ error: { message: string } }>(
    `/api/shopify/integration/sync?workspaceId=${workspace.id}&runId=${nonexistentRunId}`,
  );

  expect(status).toBe(404);
  expect(data.error.message).toContain("not found");
});

test("GET /api/shopify/integration/sync – rejects foreign workspace runId with 404 (Anti-IDOR)", async ({
  api,
  workspace,
  program,
}) => {
  let foreignStoreId: string | undefined;
  let foreignRunId: string | undefined;

  try {
    // Create foreign store belonging to a different workspace
    const foreignWorkspaceId = `ws_foreign_${Date.now()}`;
    const foreignStore = await prisma.weleticShopifyStore.create({
      data: {
        id: `wstore_foreign_${Date.now()}`,
        projectId: foreignWorkspaceId,
        programId: `prog_foreign_${Date.now()}`,
        shopDomain: `foreign-${randomName("shop")}.myshopify.com`,
        shopCurrency: "USD",
        apiVersion: "2026-10",
      },
    });
    foreignStoreId = foreignStore.id;

    foreignRunId = `wsync_foreign_${Date.now()}`;
    await prisma.weleticShopifySyncRun.create({
      data: {
        id: foreignRunId,
        storeId: foreignStore.id,
        kind: "full_catalog",
        status: "succeeded",
        stats: { products: 10 },
      },
    });

    // Querying foreign runId using current workspace must return 404
    const { status, data } = await api.get<{ error: { message: string } }>(
      `/api/shopify/integration/sync?workspaceId=${workspace.id}&runId=${foreignRunId}`,
    );

    expect(status).toBe(404);
    expect(data.error.message).toContain("not found");
  } finally {
    if (foreignRunId) {
      await prisma.weleticShopifySyncRun
        .delete({ where: { id: foreignRunId } })
        .catch(() => {});
    }
    if (foreignStoreId) {
      await prisma.weleticShopifyStore
        .delete({ where: { id: foreignStoreId } })
        .catch(() => {});
    }
  }
});

test("GET /api/shopify/integration/sync – returns latest workspace run when runId omitted", async ({
  api,
  workspace,
  program,
}) => {
  await ensureConnectedShopifyStore(workspace.id, program.id);

  const { status, data } = await api.get<Record<string, unknown>>(
    `/api/shopify/integration/sync?workspaceId=${workspace.id}`,
  );

  expect(status).toBe(200);
  expect(data).toBeDefined();
});
