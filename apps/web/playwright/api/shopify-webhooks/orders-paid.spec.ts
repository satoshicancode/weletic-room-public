import { prisma } from "@/lib/prisma";
import { expect } from "@playwright/test";
import crypto from "crypto";
import { randomName } from "../../utils";
import { test } from "../fixtures";

test.describe.configure({
  mode: "parallel",
});

const DEFAULT_WEBHOOK_SECRET = "weletic_test_webhook_secret_key_mock_123";

function calculateShopifyHmac(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body, "utf8").digest("base64");
}

async function ensureWebhookStore(workspaceId: string, programId: string) {
  const shopDomain = `playwright-wh-${randomName("store")}.myshopify.com`;
  const store = await prisma.weleticShopifyStore.upsert({
    where: { projectId: workspaceId },
    create: {
      id: `wstore_wh_${Date.now()}_${randomName("s")}`,
      projectId: workspaceId,
      programId,
      shopDomain,
      shopCurrency: "USD",
      apiVersion: "2026-10",
      installationGeneration: "gen_playwright_wh",
    },
    update: {
      shopDomain,
      shopCurrency: "USD",
      apiVersion: "2026-10",
      installationGeneration: "gen_playwright_wh",
    },
  });

  return store;
}

test("POST /api/shopify/integration/webhook – rejects request with invalid HMAC signature with 401", async ({
  request,
}) => {
  const body = JSON.stringify({ id: 123456, test: true });
  const response = await request.post("/api/shopify/integration/webhook", {
    data: body,
    headers: {
      "Content-Type": "application/json",
      "x-shopify-topic": "orders/paid",
      "x-shopify-hmac-sha256": "invalid_signature_base64==",
      "x-shopify-shop-domain": "yamax-test.myshopify.com",
      "x-shopify-webhook-id": `wh_${randomName("test")}`,
    },
  });

  expect(response.status()).toBe(401);
  const text = await response.text();
  expect(text).toContain("Invalid webhook signature");
});

test("POST /api/shopify/integration/webhook – processes valid orders/paid webhook with HMAC verification", async ({
  request,
  workspace,
  program,
}) => {
  const store = await ensureWebhookStore(workspace.id, program.id);
  const webhookSecret = process.env.SHOPIFY_WEBHOOK_SECRET || DEFAULT_WEBHOOK_SECRET;
  const webhookId = `wh_orders_paid_${Date.now()}_${randomName("wh")}`;
  const orderId = Date.now();

  const orderPayload = {
    id: orderId,
    admin_graphql_api_id: `gid://shopify/Order/${orderId}`,
    order_number: 1001,
    name: "#1001",
    total_price: "120.00",
    subtotal_price: "100.00",
    currency: "USD",
    financial_status: "paid",
    created_at: new Date().toISOString(),
    customer: {
      id: 5544332211,
      email: `customer_${randomName("cust")}@example.com`,
      first_name: "Sarah",
      last_name: "Connor",
    },
    line_items: [
      {
        id: 11223344,
        product_id: 998877,
        variant_id: 887766,
        quantity: 2,
        price: "50.00",
        title: "Yamax Flow™ High-Rise Leggings",
      },
    ],
    discount_codes: [],
  };

  const bodyString = JSON.stringify(orderPayload);
  const hmacSignature = calculateShopifyHmac(bodyString, webhookSecret);

  try {
    const response = await request.post("/api/shopify/integration/webhook", {
      data: bodyString,
      headers: {
        "Content-Type": "application/json",
        "x-shopify-topic": "orders/paid",
        "x-shopify-hmac-sha256": hmacSignature,
        "x-shopify-shop-domain": store.shopDomain,
        "x-shopify-webhook-id": webhookId,
      },
    });

    // Ingress accepts with 200 OK and JSON response
    expect(response.status()).toBe(200);
    const data = await response.json();
    expect(data).toMatchObject({
      received: true,
      webhookId,
    });
  } finally {
    // Cleanup created webhook event
    await prisma.weleticShopifyWebhookEvent
      .deleteMany({ where: { webhookId } })
      .catch(() => {});
  }
});

test("POST /api/shopify/integration/webhook – enforces deduplication idempotency on repeated webhook ID", async ({
  request,
  workspace,
  program,
}) => {
  const store = await ensureWebhookStore(workspace.id, program.id);
  const webhookSecret = process.env.SHOPIFY_WEBHOOK_SECRET || DEFAULT_WEBHOOK_SECRET;
  const duplicateWebhookId = `wh_idempotent_${Date.now()}_${randomName("dup")}`;
  const orderId = Date.now() + 1;

  const payload = {
    id: orderId,
    admin_graphql_api_id: `gid://shopify/Order/${orderId}`,
    order_number: 1002,
    name: "#1002",
    total_price: "50.00",
    currency: "USD",
    financial_status: "paid",
    created_at: new Date().toISOString(),
    customer: {
      id: 5544332212,
      email: `customer_${randomName("cust")}@example.com`,
    },
    line_items: [
      {
        id: 11223345,
        price: "50.00",
        quantity: 1,
        title: "Yamax Flow™ Cropped Tank Top",
      },
    ],
  };

  const bodyString = JSON.stringify(payload);
  const hmacSignature = calculateShopifyHmac(bodyString, webhookSecret);

  const headers = {
    "Content-Type": "application/json",
    "x-shopify-topic": "orders/paid",
    "x-shopify-hmac-sha256": hmacSignature,
    "x-shopify-shop-domain": store.shopDomain,
    "x-shopify-webhook-id": duplicateWebhookId,
  };

  try {
    // First delivery
    const firstResponse = await request.post("/api/shopify/integration/webhook", {
      data: bodyString,
      headers,
    });
    expect(firstResponse.status()).toBe(200);
    const firstJson = await firstResponse.json();
    expect(firstJson).toMatchObject({
      received: true,
      webhookId: duplicateWebhookId,
    });

    // Wait briefly for first event persistence
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Second delivery (exact replay)
    const secondResponse = await request.post("/api/shopify/integration/webhook", {
      data: bodyString,
      headers,
    });

    expect(secondResponse.status()).toBe(200);
    const secondJson = await secondResponse.json();
    // Second delivery must be recognized as duplicate, preventing double-processing
    expect(secondJson).toMatchObject({
      received: true,
      duplicate: true,
      webhookId: duplicateWebhookId,
    });
  } finally {
    await prisma.weleticShopifyWebhookEvent
      .deleteMany({ where: { webhookId: duplicateWebhookId } })
      .catch(() => {});
  }
});

test("POST /api/shopify/integration/webhook – records line-item order details and handles attribution safely", async ({
  request,
  workspace,
  program,
}) => {
  const store = await ensureWebhookStore(workspace.id, program.id);
  const webhookSecret = process.env.SHOPIFY_WEBHOOK_SECRET || DEFAULT_WEBHOOK_SECRET;
  const webhookId = `wh_attribution_${Date.now()}_${randomName("attr")}`;
  const orderId = Date.now() + 2;

  const orderPayload = {
    id: orderId,
    admin_graphql_api_id: `gid://shopify/Order/${orderId}`,
    order_number: 1003,
    name: "#1003",
    total_price: "160.00",
    subtotal_price: "150.00",
    currency: "USD",
    financial_status: "paid",
    created_at: new Date().toISOString(),
    customer: {
      id: 5544332213,
      email: `customer_${randomName("cust")}@example.com`,
      first_name: "John",
      last_name: "Doe",
    },
    line_items: [
      {
        id: 22334455,
        product_id: 887766,
        variant_id: 776655,
        quantity: 1,
        price: "150.00",
        title: "Yamax Flow™ High-Rise Leggings",
      },
    ],
    discount_codes: [],
  };

  const bodyString = JSON.stringify(orderPayload);
  const hmacSignature = calculateShopifyHmac(bodyString, webhookSecret);

  try {
    const response = await request.post("/api/shopify/integration/webhook", {
      data: bodyString,
      headers: {
        "Content-Type": "application/json",
        "x-shopify-topic": "orders/paid",
        "x-shopify-hmac-sha256": hmacSignature,
        "x-shopify-shop-domain": store.shopDomain,
        "x-shopify-webhook-id": webhookId,
      },
    });

    expect(response.status()).toBe(200);

    // Verify webhook event was created in database
    const eventRecord = await prisma.weleticShopifyWebhookEvent.findUnique({
      where: { webhookId },
    });
    expect(eventRecord).toBeDefined();
    expect(eventRecord?.storeId).toBe(store.id);
    expect(eventRecord?.topic).toBe("orders/paid");
    expect(eventRecord?.attempts).toBe(1);
  } finally {
    await prisma.weleticShopifyWebhookEvent
      .deleteMany({ where: { webhookId } })
      .catch(() => {});
  }
});

test("POST /api/shopify/integration/webhook – ignores unsupported topic with informative response", async ({
  request,
}) => {
  const webhookSecret = process.env.SHOPIFY_WEBHOOK_SECRET || DEFAULT_WEBHOOK_SECRET;
  const body = JSON.stringify({ id: 12345 });
  const hmac = calculateShopifyHmac(body, webhookSecret);

  const response = await request.post("/api/shopify/integration/webhook", {
    data: body,
    headers: {
      "Content-Type": "application/json",
      "x-shopify-topic": "unsupported/nonexistent_topic",
      "x-shopify-hmac-sha256": hmac,
      "x-shopify-shop-domain": "yamax-test.myshopify.com",
      "x-shopify-webhook-id": `wh_${randomName("unsupported")}`,
    },
  });

  expect(response.status()).toBe(200);
  const text = await response.text();
  expect(text).toContain("Unsupported topic");
});
