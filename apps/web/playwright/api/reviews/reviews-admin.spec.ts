import { prisma } from "@/lib/prisma";
import { expect } from "@playwright/test";
import { randomName } from "../../utils";
import { test } from "../fixtures";

test.describe.configure({
  mode: "serial",
});

async function ensureReviewsTestStore(workspaceId: string, programId: string) {
  const uniqueId = randomName("store")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  const shopDomain = `playwright-rev-${uniqueId}.myshopify.com`;
  const store = await prisma.weleticShopifyStore.upsert({
    where: { projectId: workspaceId },
    create: {
      id: `wstore_rev_${Date.now()}_${randomName("s")}`,
      projectId: workspaceId,
      programId,
      shopDomain,
      shopCurrency: "USD",
      apiVersion: "2026-10",
      complianceState: "active",
      storeAccessState: "active",
      installationGeneration: "gen_playwright_reviews",
    },
    update: {
      complianceState: "active",
      storeAccessState: "active",
    },
  });

  await prisma.weleticReviewSettings.upsert({
    where: { storeId: store.id },
    create: {
      storeId: store.id,
      enabled: true,
      autoPublish: false,
      photoUploadsEnabled: true,
      videoUploadsEnabled: true,
      requestEmailEnabled: false,
    },
    update: {
      enabled: true,
      photoUploadsEnabled: true,
      videoUploadsEnabled: true,
    },
  });

  return store;
}

test("GET /api/shopify/reviews/admin – rejects unauthorized request without Bearer token with 401", async ({
  request,
  workspace,
}) => {
  const response = await request.get(
    `/api/shopify/reviews/admin?workspaceId=${workspace.id}`,
    {
      headers: {
        Authorization: "",
      },
    },
  );

  expect(response.status()).toBe(401);
});

test("POST /api/shopify/reviews/admin – rejects unauthorized request without Bearer token with 401", async ({
  request,
  workspace,
}) => {
  const response = await request.post(
    `/api/shopify/reviews/admin?workspaceId=${workspace.id}`,
    {
      headers: {
        Authorization: "",
      },
      data: JSON.stringify({ action: "settings", settings: {} }),
    },
  );

  expect(response.status()).toBe(401);
});

test("POST /api/shopify/reviews/admin – rejects malformed or invalid action with 400", async ({
  api,
  workspace,
}) => {
  const { status } = await api.post(
    `/api/shopify/reviews/admin?workspaceId=${workspace.id}`,
    { action: "invalid_action_foo" },
  );

  expect([400, 404]).toContain(status);
});

test("GET /api/shopify/reviews/admin – loads review settings and list when store is connected", async ({
  api,
  workspace,
  program,
}) => {
  const store = await ensureReviewsTestStore(workspace.id, program.id);

  const { status, data } = await api.get<any>(
    `/api/shopify/reviews/admin?workspaceId=${workspace.id}`,
  );

  expect(status).toBe(200);
  expect(data).toMatchObject({
    shopDomain: store.shopDomain,
    settings: expect.objectContaining({
      enabled: true,
      photoUploadsEnabled: true,
      videoUploadsEnabled: true,
    }),
    items: expect.any(Array),
  });
});

test("POST /api/shopify/reviews/admin – toggles videoUploadsEnabled review settings", async ({
  api,
  workspace,
  program,
}) => {
  const store = await ensureReviewsTestStore(workspace.id, program.id);

  const updateResponse = await api.post<any>(
    `/api/shopify/reviews/admin?workspaceId=${workspace.id}`,
    {
      action: "settings",
      settings: {
        enabled: true,
        photoUploadsEnabled: true,
        videoUploadsEnabled: false,
        autoPublish: false,
        sendAfterDays: 7,
        expiresAfterDays: 30,
        requestEmailEnabled: false,
      },
    },
  );

  expect(updateResponse.status).toBe(200);
  expect(updateResponse.data).toMatchObject({
    videoUploadsEnabled: false,
  });

  // Re-read via GET to confirm persistence
  const getResponse = await api.get<any>(
    `/api/shopify/reviews/admin?workspaceId=${workspace.id}`,
  );
  expect(getResponse.status).toBe(200);
  expect(getResponse.data.settings.videoUploadsEnabled).toBe(false);

  // Restore videoUploadsEnabled: true
  await api.post(`/api/shopify/reviews/admin?workspaceId=${workspace.id}`, {
    action: "settings",
    settings: {
      enabled: true,
      photoUploadsEnabled: true,
      videoUploadsEnabled: true,
      autoPublish: false,
      sendAfterDays: 7,
      expiresAfterDays: 30,
      requestEmailEnabled: false,
    },
  });
});
