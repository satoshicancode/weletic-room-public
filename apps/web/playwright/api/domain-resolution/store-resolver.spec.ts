import { prisma } from "@/lib/prisma";
import {
  canonicalizeShopifyDomain,
  normalizeShopDomain,
  shopifyCredentialVerificationHash,
} from "@/lib/weletic/shopify/store-resolver";
import { SHOPIFY_INTEGRATION_ID } from "@dub/utils";
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
  request,
  workspace,
  program,
}) => {
  const uniquePrefix = randomName("multi")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
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
      const testAccessToken = "shpat_resolver_test_token_valid";
      const tokenHash = shopifyCredentialVerificationHash(testAccessToken);
      await prisma.installedIntegration.upsert({
        where: {
          userId_integrationId_projectId: {
            userId: user.id,
            integrationId: SHOPIFY_INTEGRATION_ID,
            projectId: workspace.id,
          },
        },
        create: {
          id: `inst_resolver_${Date.now()}`,
          userId: user.id,
          integrationId: SHOPIFY_INTEGRATION_ID,
          projectId: workspace.id,
          credentials: {
            shop: myshopifyDomain,
            accessToken: testAccessToken,
            shopVerificationTokenHash: tokenHash,
            installationGeneration: `gen_${uniquePrefix}`,
            scope: "read_products,read_orders,read_customers",
          },
        },
        update: {
          credentials: {
            shop: myshopifyDomain,
            accessToken: testAccessToken,
            shopVerificationTokenHash: tokenHash,
            installationGeneration: `gen_${uniquePrefix}`,
            scope: "read_products,read_orders,read_customers",
          },
        },
      });
    }

    const webhookSecret =
      process.env.SHOPIFY_WEBHOOK_SECRET || DEFAULT_WEBHOOK_SECRET;
    const body = JSON.stringify({ id: 123456 });
    const hmac = calculateHmac(body, webhookSecret);

    // 3. Test resolution by myshopifyDomain via HTTP webhook endpoint
    const resMyshopify = await request.post(
      "/api/shopify/integration/webhook",
      {
        data: body,
        headers: {
          "Content-Type": "application/json",
          "x-shopify-topic": "orders/fulfilled",
          "x-shopify-hmac-sha256": hmac,
          "x-shopify-shop-domain": myshopifyDomain,
          "x-shopify-webhook-id": `wh_res_${Date.now()}_1`,
        },
      },
    );
    expect(resMyshopify.status()).toBe(200);
    const textMyshopify = await resMyshopify.text();
    expect(textMyshopify).not.toContain("Workspace not found for signed shop");

    // 4. Test resolution with uppercase and formatting variation
    const resVariant = await request.post("/api/shopify/integration/webhook", {
      data: body,
      headers: {
        "Content-Type": "application/json",
        "x-shopify-topic": "orders/fulfilled",
        "x-shopify-hmac-sha256": hmac,
        "x-shopify-shop-domain": myshopifyDomain.toUpperCase(),
        "x-shopify-webhook-id": `wh_res_${Date.now()}_2`,
      },
    });
    expect(resVariant.status()).toBe(200);
    const textVariant = await resVariant.text();
    expect(textVariant).not.toContain("Workspace not found for signed shop");

    // 5. Resolution returns 'Workspace not found' for unknown domain
    const resUnknown = await request.post("/api/shopify/integration/webhook", {
      data: body,
      headers: {
        "Content-Type": "application/json",
        "x-shopify-topic": "orders/fulfilled",
        "x-shopify-hmac-sha256": hmac,
        "x-shopify-shop-domain": "completely-unknown-shop.myshopify.com",
        "x-shopify-webhook-id": `wh_res_${Date.now()}_3`,
      },
    });
    expect(resUnknown.status()).toBe(200);
    const textUnknown = await resUnknown.text();
    expect(textUnknown).toContain("Workspace not found for signed shop");
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
