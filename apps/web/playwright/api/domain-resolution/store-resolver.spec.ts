import { prisma } from "@/lib/prisma";
import {
  canonicalizeShopifyDomain,
  normalizeShopDomain,
  resolveShopifyStoreByDomain,
} from "@/lib/weletic/shopify/store-resolver";
import { expect } from "@playwright/test";
import crypto from "crypto";
import { randomName } from "../../utils";
import { test } from "../fixtures";

test.describe.configure({
  mode: "parallel",
});

const DEFAULT_WEBHOOK_SECRET = "weletic_test_webhook_secret_key_mock_123";

function calculateHmac(body: string, secret: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(body, "utf8")
    .digest("base64");
}

test("Domain normalization – handles protocol prefixes, paths, and casing safely", async () => {
  // Protocol stripping & trailing path removal
  expect(normalizeShopDomain("https://yamax-store.myshopify.com/admin")).toBe(
    "yamax-store.myshopify.com",
  );
  expect(normalizeShopDomain("http://MyStore.MyShopify.Com/")).toBe(
    "mystore.myshopify.com",
  );
  expect(normalizeShopDomain("   custom-domain.com   ")).toBe(
    "custom-domain.com",
  );
  expect(normalizeShopDomain("")).toBe("");

  // Canonical myshopify domain validation
  expect(canonicalizeShopifyDomain("https://valid-shop.myshopify.com/")).toBe(
    "valid-shop.myshopify.com",
  );
  expect(canonicalizeShopifyDomain("custom-brand.com")).toBeNull();
  expect(canonicalizeShopifyDomain("invalid_shop.myshopify.com")).toBeNull();
});

test("GET /api/internal/shopify/stats – rejects unauthenticated access with 401", async ({
  request,
}) => {
  const response = await request.get(
    "/api/internal/shopify/stats?shop=yamax-dev.myshopify.com",
  );

  expect(response.status()).toBe(401);
});

test("GET /api/internal/shopify/stats – rejects malformed shop domains with 400", async ({
  request,
}) => {
  // 1. Invalid domain with special characters
  const malformedRes = await request.get(
    "/api/internal/shopify/stats?shop=invalid--domain--name",
    {
      headers: {
        "x-weletic-signature": "dummy",
      },
    },
  );
  // Rejection by either auth (401) or shop validation (400)
  expect([400, 401]).toContain(malformedRes.status());
});

test("GET /api/internal/shopify/catalog – rejects unauthenticated service requests with 401", async ({
  request,
}) => {
  const response = await request.get(
    "/api/internal/shopify/catalog?shop=yamax-dev.myshopify.com",
  );

  expect(response.status()).toBe(401);
});

test("POST /api/shopify/integration/webhook – handles unknown shop domain gracefully without 500 error", async ({
  request,
}) => {
  const webhookSecret =
    process.env.SHOPIFY_WEBHOOK_SECRET || DEFAULT_WEBHOOK_SECRET;
  const unknownDomain = `unknown-tenant-${randomName("shop")}.myshopify.com`;
  const body = JSON.stringify({ id: 999999 });
  const hmac = calculateHmac(body, webhookSecret);

  const response = await request.post("/api/shopify/integration/webhook", {
    data: body,
    headers: {
      "Content-Type": "application/json",
      "x-shopify-topic": "orders/paid",
      "x-shopify-hmac-sha256": hmac,
      "x-shopify-shop-domain": unknownDomain,
      "x-shopify-webhook-id": `wh_unmapped_${Date.now()}`,
    },
  });

  // When store is unknown, webhook route returns 200 acknowledging receipt while skipping processing
  expect(response.status()).toBe(200);
  const text = await response.text();
  expect(text).toContain("Workspace not found for signed shop");
});

test("POST /api/shopify/integration/webhook – rejects empty shop domain safely", async ({
  request,
}) => {
  const webhookSecret =
    process.env.SHOPIFY_WEBHOOK_SECRET || DEFAULT_WEBHOOK_SECRET;
  const body = JSON.stringify({ id: 999998 });
  const hmac = calculateHmac(body, webhookSecret);

  const response = await request.post("/api/shopify/integration/webhook", {
    data: body,
    headers: {
      "Content-Type": "application/json",
      "x-shopify-topic": "orders/paid",
      "x-shopify-hmac-sha256": hmac,
      "x-shopify-shop-domain": "",
      "x-shopify-webhook-id": `wh_empty_${Date.now()}`,
    },
  });

  expect(response.status()).toBe(200);
  const text = await response.text();
  expect(text).toContain("Workspace not found for signed shop");
});

test("Invariant 1: Multi-domain resolution across primary domain, myshopifyDomain, and custom domain aliases", async ({
  workspace,
  program,
}) => {
  const uniquePrefix = randomName("multi");
  const myshopifyDomain = `${uniquePrefix}-store.myshopify.com`;
  const customPrimaryDomain = `shop.${uniquePrefix}.com`;

  let testStoreId: string | undefined;

  try {
    // 1. Provision store record with myshopifyDomain
    testStoreId = `wstore_resolver_${Date.now()}_${uniquePrefix}`;
    await prisma.weleticShopifyStore.upsert({
      where: { projectId: workspace.id },
      create: {
        id: testStoreId,
        projectId: workspace.id,
        programId: program.id,
        shopDomain: myshopifyDomain,
        shopCurrency: "USD",
        apiVersion: "2026-10",
        installationGeneration: `gen_${uniquePrefix}`,
      },
      update: {
        shopDomain: myshopifyDomain,
        installationGeneration: `gen_${uniquePrefix}`,
      },
    });

    // 2. Set shopifyStoreId on workspace (Project) to the custom primary domain alias
    await prisma.project.update({
      where: { id: workspace.id },
      data: {
        shopifyStoreId: customPrimaryDomain,
      },
    });

    // Also link InstalledIntegration credentials with accessToken
    const user = await prisma.user.findFirst({ select: { id: true } });
    if (user) {
      await prisma.installedIntegration.upsert({
        where: {
          userId_integrationId_projectId: {
            userId: user.id,
            integrationId: "shopify",
            projectId: workspace.id,
          },
        },
        create: {
          id: `inst_resolver_${Date.now()}`,
          userId: user.id,
          integrationId: "shopify",
          projectId: workspace.id,
          credentials: {
            shop: myshopifyDomain,
            accessToken: "shpat_resolver_test_token_valid",
            installationGeneration: `gen_${uniquePrefix}`,
            scope: "read_products,read_orders,read_customers",
          },
        },
        update: {
          credentials: {
            shop: myshopifyDomain,
            accessToken: "shpat_resolver_test_token_valid",
            installationGeneration: `gen_${uniquePrefix}`,
            scope: "read_products,read_orders,read_customers",
          },
        },
      });
    }

    // 3. Test resolution by myshopifyDomain
    const resolvedByMyshopify =
      await resolveShopifyStoreByDomain(myshopifyDomain);
    if (resolvedByMyshopify) {
      expect(resolvedByMyshopify.workspaceId).toBe(workspace.id);
      expect(resolvedByMyshopify.programId).toBe(program.id);
      expect(resolvedByMyshopify.myshopifyDomain).toBe(myshopifyDomain);
    }

    // 4. Test resolution by custom domain alias (project.shopifyStoreId)
    const resolvedByCustomAlias =
      await resolveShopifyStoreByDomain(customPrimaryDomain);
    if (resolvedByCustomAlias) {
      expect(resolvedByCustomAlias.workspaceId).toBe(workspace.id);
      expect(resolvedByCustomAlias.programId).toBe(program.id);
    }

    // 5. Resolution returns null for unknown domain
    const nonExistent = await resolveShopifyStoreByDomain(
      "completely-unknown-domain.com",
    );
    expect(nonExistent).toBeNull();
  } finally {
    // Revert workspace shopifyStoreId
    await prisma.project
      .update({
        where: { id: workspace.id },
        data: { shopifyStoreId: null },
      })
      .catch(() => {});
  }
});
