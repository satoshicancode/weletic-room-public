import crypto from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  anonymizeWeleticShopper: vi.fn(),
  getShopperDataExport: vi.fn(),
  installIntentDeleteMany: vi.fn(),
  loyaltyProgramUpdate: vi.fn(),
  storeFindUnique: vi.fn(),
  withDistributedLock: vi.fn(),
  resolveComplianceStore: vi.fn(),
  persistAndQueue: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticLoyaltyProgram: { update: mocks.loyaltyProgramUpdate },
    weleticShopifyInstallIntent: { deleteMany: mocks.installIntentDeleteMany },
    weleticShopifyStore: { findUnique: mocks.storeFindUnique },
  },
}));

vi.mock("@/lib/weletic/loyalty/shopper-privacy", () => ({
  anonymizeWeleticShopper: mocks.anonymizeWeleticShopper,
  getShopperDataExport: mocks.getShopperDataExport,
}));

vi.mock("@/lib/weletic/redis-lock", () => ({
  withDistributedLock: mocks.withDistributedLock,
}));
vi.mock("@/lib/weletic/shopify/compliance-store-resolver", () => ({
  resolveComplianceShopifyStoreByDomain: mocks.resolveComplianceStore,
}));
vi.mock("@/lib/weletic/shopify/compliance-ingress", () => ({
  persistAndQueueShopifyComplianceRequest: mocks.persistAndQueue,
}));

import { POST as customersDataRequest } from "../../app/(ee)/api/shopify/gdpr/customers-data-request/route";
import { POST as customersRedact } from "../../app/(ee)/api/shopify/gdpr/customers-redact/route";
import { POST as shopRedact } from "../../app/(ee)/api/shopify/gdpr/shop-redact/route";
import { loadShopifyPrivacyHmacKeyring } from "../../lib/weletic/shopify/privacy-identity";
import {
  WELETIC_SHOPIFY_MAX_BODY_BYTES,
  WELETIC_SHOPIFY_MAX_WEBHOOK_BODY_BYTES,
} from "../../lib/weletic/shopify/service-auth";

const SHOPIFY_SECRET = "shopify-webhook-secret-at-least-32-chars";
const originalWebhookSecret = process.env.SHOPIFY_WEBHOOK_SECRET;
const currentPrivacyKeyId =
  loadShopifyPrivacyHmacKeyring().current.identityKeyId;
const authenticatedBodyDigestPattern = new RegExp(
  `^hmac:v1:${currentPrivacyKeyId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:[A-F0-9]{64}$`,
);

const routeCases = [
  {
    name: "customers data request",
    path: "/api/shopify/gdpr/customers-data-request",
    topic: "customers/data_request",
    payload: {
      shop_domain: "target.myshopify.com",
      customer: { id: 101 },
    },
    post: customersDataRequest,
  },
  {
    name: "customers redact",
    path: "/api/shopify/gdpr/customers-redact",
    topic: "customers/redact",
    payload: {
      shop_domain: "target.myshopify.com",
      customer: { id: 101 },
      orders_to_redact: [9001],
    },
    post: customersRedact,
  },
  {
    name: "shop redact",
    path: "/api/shopify/gdpr/shop-redact",
    topic: "shop/redact",
    payload: { shop_domain: "target.myshopify.com" },
    post: shopRedact,
  },
] as const;

function sign(body: string | Uint8Array, secret = SHOPIFY_SECRET) {
  const hmac = crypto.createHmac("sha256", secret);
  if (typeof body === "string") {
    hmac.update(body, "utf8");
  } else {
    hmac.update(body);
  }
  return hmac.digest("base64");
}

function webhookRequest({
  path,
  topic,
  body,
  signedBody = body,
  signature = sign(signedBody),
  headers,
}: {
  path: string;
  topic: string;
  body: string;
  signedBody?: string;
  signature?: string;
  headers?: Record<string, string>;
}) {
  return new Request(`https://app.weletic.com${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-shopify-hmac-sha256": signature,
      "x-shopify-shop-domain": "target.myshopify.com",
      "x-shopify-topic": topic,
      "x-shopify-webhook-id": `wh_${topic.replaceAll("/", "_")}`,
      ...headers,
    },
    body,
  });
}

function expectNoPrivacySideEffects() {
  expect(mocks.storeFindUnique).not.toHaveBeenCalled();
  expect(mocks.getShopperDataExport).not.toHaveBeenCalled();
  expect(mocks.anonymizeWeleticShopper).not.toHaveBeenCalled();
  expect(mocks.loyaltyProgramUpdate).not.toHaveBeenCalled();
  expect(mocks.installIntentDeleteMany).not.toHaveBeenCalled();
  expect(mocks.persistAndQueue).not.toHaveBeenCalled();
}

describe("Shopify public GDPR webhook authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SHOPIFY_WEBHOOK_SECRET = SHOPIFY_SECRET;
    mocks.storeFindUnique.mockResolvedValue({
      id: "store_target",
      loyaltyProgram: { id: "program_target" },
      projectId: "workspace_target",
    });
    mocks.getShopperDataExport.mockResolvedValue({
      shopperId: "shopper_target",
    });
    mocks.anonymizeWeleticShopper.mockResolvedValue({ found: true });
    mocks.loyaltyProgramUpdate.mockResolvedValue({ id: "program_target" });
    mocks.installIntentDeleteMany.mockResolvedValue({ count: 1 });
    mocks.withDistributedLock.mockImplementation(async ({ fn }) => fn());
    mocks.resolveComplianceStore.mockResolvedValue({
      storeId: "store_target",
      workspaceId: "workspace_target",
      programId: "program_target",
      canonicalShopDomain: "target.myshopify.com",
      storageShopDomain: "target.myshopify.com",
      complianceState: "active",
      resolvedFromTombstone: false,
    });
    mocks.persistAndQueue.mockResolvedValue({
      requestId: "wcomp_target",
      created: true,
      status: "pending",
    });
  });

  afterAll(() => {
    if (originalWebhookSecret === undefined) {
      delete process.env.SHOPIFY_WEBHOOK_SECRET;
    } else {
      process.env.SHOPIFY_WEBHOOK_SECRET = originalWebhookSecret;
    }
  });

  it("accepts authentic HMACs and durably queues each route without inline privacy work", async () => {
    for (const routeCase of routeCases) {
      const body = JSON.stringify(routeCase.payload);
      const response = await routeCase.post(
        webhookRequest({
          path: routeCase.path,
          topic: routeCase.topic,
          body,
        }),
      );

      expect(response.status, routeCase.name).toBe(200);
    }

    expect(mocks.persistAndQueue).toHaveBeenCalledTimes(3);
    for (const [input] of mocks.persistAndQueue.mock.calls) {
      expect(input.authenticatedBodyDigests).toEqual([
        expect.stringMatching(authenticatedBodyDigestPattern),
      ]);
    }
    expect(mocks.getShopperDataExport).not.toHaveBeenCalled();
    expect(mocks.anonymizeWeleticShopper).not.toHaveBeenCalled();
    expect(mocks.loyaltyProgramUpdate).not.toHaveBeenCalled();
    expect(mocks.installIntentDeleteMany).not.toHaveBeenCalled();
  });

  for (const routeCase of routeCases) {
    it(`rejects a missing HMAC before ${routeCase.name} side effects`, async () => {
      const body = JSON.stringify(routeCase.payload);
      const response = await routeCase.post(
        webhookRequest({
          path: routeCase.path,
          topic: routeCase.topic,
          body,
          signature: "",
        }),
      );

      expect(response.status).toBe(401);
      expectNoPrivacySideEffects();
    });

    it(`rejects an invalid HMAC before ${routeCase.name} side effects`, async () => {
      const body = JSON.stringify(routeCase.payload);
      const response = await routeCase.post(
        webhookRequest({
          path: routeCase.path,
          topic: routeCase.topic,
          body,
          signature: "not-a-valid-shopify-hmac",
        }),
      );

      expect(response.status).toBe(401);
      expectNoPrivacySideEffects();
    });

    it(`rejects body tampering before ${routeCase.name} side effects`, async () => {
      const signedBody = JSON.stringify(routeCase.payload);
      const response = await routeCase.post(
        webhookRequest({
          path: routeCase.path,
          topic: routeCase.topic,
          body: `${signedBody} `,
          signedBody,
        }),
      );

      expect(response.status).toBe(401);
      expectNoPrivacySideEffects();
    });

    it(`rejects a wrong Shopify topic before ${routeCase.name} side effects`, async () => {
      const body = JSON.stringify(routeCase.payload);
      const response = await routeCase.post(
        webhookRequest({
          path: routeCase.path,
          topic: "orders/paid",
          body,
        }),
      );

      expect(response.status).toBe(401);
      expectNoPrivacySideEffects();
    });
  }

  it("fails closed without a configured webhook secret", async () => {
    delete process.env.SHOPIFY_WEBHOOK_SECRET;

    for (const routeCase of routeCases) {
      const body = JSON.stringify(routeCase.payload);
      const response = await routeCase.post(
        webhookRequest({
          path: routeCase.path,
          topic: routeCase.topic,
          body,
        }),
      );

      expect(response.status, routeCase.name).toBe(503);
    }
    expectNoPrivacySideEffects();
  });

  it("fails closed when the configured webhook secret is too short", async () => {
    const shortSecret = "short-secret";
    process.env.SHOPIFY_WEBHOOK_SECRET = shortSecret;

    for (const routeCase of routeCases) {
      const body = JSON.stringify(routeCase.payload);
      const response = await routeCase.post(
        webhookRequest({
          path: routeCase.path,
          topic: routeCase.topic,
          body,
          signature: sign(body, shortSecret),
        }),
      );

      expect(response.status, routeCase.name).toBe(503);
    }
    expectNoPrivacySideEffects();
  });

  it("authenticates the raw body before attempting JSON parsing", async () => {
    const response = await customersRedact(
      webhookRequest({
        path: "/api/shopify/gdpr/customers-redact",
        topic: "customers/redact",
        body: "not-json",
        signature: "invalid",
      }),
    );

    expect(response.status).toBe(401);
    expectNoPrivacySideEffects();
  });

  it("verifies the exact UTF-8 bytes before decoding JSON", async () => {
    const body = JSON.stringify({
      shop_domain: "target.myshopify.com",
      customer: { id: 101 },
      note: "Loyalty privacy request — お客様",
    });
    const response = await customersDataRequest(
      webhookRequest({
        path: "/api/shopify/gdpr/customers-data-request",
        topic: "customers/data_request",
        body,
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.persistAndQueue).toHaveBeenCalledOnce();
  });

  it("accepts an authentic GDPR payload larger than the internal 256 KiB limit", async () => {
    const body = JSON.stringify({
      ...routeCases[0].payload,
      padding: "x".repeat(WELETIC_SHOPIFY_MAX_BODY_BYTES + 1024),
    });
    expect(Buffer.byteLength(body)).toBeGreaterThan(
      WELETIC_SHOPIFY_MAX_BODY_BYTES,
    );
    expect(Buffer.byteLength(body)).toBeLessThan(
      WELETIC_SHOPIFY_MAX_WEBHOOK_BODY_BYTES,
    );

    const response = await customersDataRequest(
      webhookRequest({
        path: routeCases[0].path,
        topic: routeCases[0].topic,
        body,
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.persistAndQueue).toHaveBeenCalledOnce();
  });

  for (const routeCase of routeCases) {
    it(`rejects an oversized declared body before ${routeCase.name} side effects`, async () => {
      const body = JSON.stringify(routeCase.payload);
      const response = await routeCase.post(
        webhookRequest({
          path: routeCase.path,
          topic: routeCase.topic,
          body,
          headers: {
            "content-length": String(
              WELETIC_SHOPIFY_MAX_WEBHOOK_BODY_BYTES + 1,
            ),
          },
        }),
      );

      expect(response.status).toBe(413);
      expectNoPrivacySideEffects();
    });
  }

  it("rejects invalid and negative Content-Length before side effects", async () => {
    for (const contentLength of ["", "-1", "1.5", "invalid"]) {
      const body = JSON.stringify(routeCases[0].payload);
      const response = await customersDataRequest(
        webhookRequest({
          path: routeCases[0].path,
          topic: routeCases[0].topic,
          body,
          headers: { "content-length": contentLength },
        }),
      );

      expect(response.status, contentLength).toBe(413);
    }
    expectNoPrivacySideEffects();
  });

  it("cancels a chunked body stream as soon as it crosses the byte limit", async () => {
    let cancelled = false;
    const chunk = new Uint8Array(64 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 65; index += 1) {
          controller.enqueue(chunk);
        }
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request(
      "https://app.weletic.com/api/shopify/gdpr/customers-redact",
      {
        method: "POST",
        headers: {
          "x-shopify-hmac-sha256": sign("{}"),
          "x-shopify-topic": "customers/redact",
        },
        body: stream,
        duplex: "half",
      } as RequestInit & { duplex: "half" },
    );

    const response = await customersRedact(request);

    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expectNoPrivacySideEffects();
  });

  it("checks HMAC against raw non-UTF-8 bytes before JSON decoding", async () => {
    const rawBody = new Uint8Array([0xff, 0xfe, 0xfd]);
    const request = new Request(
      "https://app.weletic.com/api/shopify/gdpr/customers-redact",
      {
        method: "POST",
        headers: {
          "x-shopify-hmac-sha256": sign(rawBody),
          "x-shopify-topic": "customers/redact",
        },
        body: rawBody,
      },
    );

    const response = await customersRedact(request);

    // A 400 proves the byte-level HMAC passed before the decoded body failed JSON parsing.
    expect(response.status).toBe(400);
    expectNoPrivacySideEffects();
  });
});
