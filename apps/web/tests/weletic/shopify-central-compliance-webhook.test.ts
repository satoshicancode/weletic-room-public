import { Prisma } from "@prisma/client";
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveComplianceStore: vi.fn(),
  resolveOperationalStore: vi.fn(),
  persistAndQueue: vi.fn(),
  operationalStoreFindUnique: vi.fn(),
  loyaltyProgramFindUnique: vi.fn(),
  projectFindUnique: vi.fn(),
  webhookEventCreate: vi.fn(),
  webhookEventFindUnique: vi.fn(),
  webhookEventUpdateMany: vi.fn(),
  redisSet: vi.fn(),
  redisEval: vi.fn(),
  publishJSON: vi.fn(),
  transaction: vi.fn(),
  ordersPaid: vi.fn(),
  refundsCreate: vi.fn(),
  customersSync: vi.fn(),
  shopifyAdminGraphqlRequest: vi.fn(),
  discountsDelete: vi.fn(),
  discountsUpdate: vi.fn(),
  segmentMembershipChanged: vi.fn(),
  captureWebhookLog: vi.fn(),
  pendingPrivacy: vi.fn(),
}));

vi.mock("@/lib/api/environment", () => ({ isLocalDev: true }));
vi.mock("@/lib/api-logs/capture-webhook-log", () => ({
  captureWebhookLog: mocks.captureWebhookLog,
}));
vi.mock("@/lib/cron", () => ({
  qstash: { publishJSON: mocks.publishJSON },
}));
vi.mock("@/lib/upstash", () => ({
  redis: { set: mocks.redisSet, eval: mocks.redisEval },
}));
vi.mock("@/lib/weletic/shopify/catalog-sync", () => ({
  syncWeleticShopifyCatalog: vi.fn(),
}));
vi.mock("@/lib/weletic/shopify/compliance-store-resolver", () => ({
  resolveComplianceShopifyStoreByDomain: mocks.resolveComplianceStore,
}));
vi.mock("@/lib/weletic/shopify/compliance-ingress", () => ({
  persistAndQueueShopifyComplianceRequest: mocks.persistAndQueue,
}));
vi.mock("@/lib/weletic/shopify/store-resolver", async (original) => ({
  ...(await original<typeof import("@/lib/weletic/shopify/store-resolver")>()),
  resolveShopifyStoreByDomain: mocks.resolveOperationalStore,
}));
vi.mock("@/lib/weletic/shopify/pending-installation-privacy", () => ({
  handlePendingInstallationPrivacy: mocks.pendingPrivacy,
}));
vi.mock("@/lib/weletic/loyalty/shopify-discounts", () => ({
  shopifyAdminGraphqlRequest: mocks.shopifyAdminGraphqlRequest,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: (() => {
    const client = {
      project: { findUnique: mocks.projectFindUnique },
      weleticShopifyStore: {
        findUnique: mocks.operationalStoreFindUnique,
      },
      weleticLoyaltyProgram: {
        findUnique: mocks.loyaltyProgramFindUnique,
      },
      weleticShopifyWebhookEvent: {
        create: mocks.webhookEventCreate,
        findUnique: mocks.webhookEventFindUnique,
        updateMany: mocks.webhookEventUpdateMany,
      },
    };
    return {
      ...client,
      $transaction: (callback: any) => mocks.transaction(callback, client),
    };
  })(),
}));
vi.mock("@dub/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dub/utils")>()),
  log: vi.fn(),
}));
vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));
vi.mock(
  "../../app/(ee)/api/shopify/integration/webhook/customer-segment-membership",
  () => ({ customerSegmentMembershipChanged: mocks.segmentMembershipChanged }),
);
vi.mock(
  "../../app/(ee)/api/shopify/integration/webhook/customers-sync",
  () => ({ customersSync: mocks.customersSync }),
);
vi.mock(
  "../../app/(ee)/api/shopify/integration/webhook/discounts-sync",
  () => ({
    discountsDelete: mocks.discountsDelete,
    discountsUpdate: mocks.discountsUpdate,
  }),
);
vi.mock("../../app/(ee)/api/shopify/integration/webhook/orders-paid", () => ({
  ordersPaid: mocks.ordersPaid,
}));
vi.mock(
  "../../app/(ee)/api/shopify/integration/webhook/refunds-create",
  () => ({ refundsCreate: mocks.refundsCreate }),
);

import {
  enqueueDebouncedShopifyCatalogSync,
  POST,
} from "../../app/(ee)/api/shopify/integration/webhook/route";
import {
  createLoyaltyMaintenanceLeaseMetadata,
  LOYALTY_MAINTENANCE_DISPOSABLE_CUSTOMER_TAG,
} from "../../lib/weletic/loyalty/maintenance-write-fence";
import {
  createAllShopifyWebhookBodyDigests,
  loadShopifyPrivacyHmacKeyring,
} from "../../lib/weletic/shopify/privacy-identity";
import {
  WELETIC_SHOPIFY_MAX_BODY_BYTES,
  WELETIC_SHOPIFY_MAX_WEBHOOK_BODY_BYTES,
} from "../../lib/weletic/shopify/service-auth";

const secret = "central-compliance-secret-at-least-32-characters";
const currentPrivacyKeyId =
  loadShopifyPrivacyHmacKeyring().current.identityKeyId;
const authenticatedBodyDigestPattern = new RegExp(
  `^hmac:v1:${currentPrivacyKeyId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:[A-F0-9]{64}$`,
);
const maintenanceOwnerToken = "maintenance-owner-token-at-least-32-characters";
const maintenanceRunMarker = "weletic-a1-run-fixture";
const maintenanceFixtureEmail = "fixture@maintenance.invalid";

function activeMaintenanceMetadata() {
  return createLoyaltyMaintenanceLeaseMetadata({
    existingMetadata: null,
    ownerToken: maintenanceOwnerToken,
    runMarker: maintenanceRunMarker,
    fixtureEmails: [maintenanceFixtureEmail],
    acquiredAt: new Date("2026-08-31T00:00:00.000Z"),
    recoveryAfter: new Date("2026-08-31T01:00:00.000Z"),
  });
}

function configureOperationalMaintenanceLease() {
  mocks.resolveOperationalStore.mockResolvedValue({
    storeId: "store_a",
    workspaceId: "workspace_a",
    programId: "program_a",
    myshopifyDomain: "a.myshopify.com",
    accessToken: "test-store-access-token",
  });
  mocks.loyaltyProgramFindUnique.mockResolvedValue({
    storeId: "store_a",
    metadata: activeMaintenanceMetadata(),
  });
}

function signedRequest({
  body,
  shop = "a.myshopify.com",
  topic = "customers/data_request",
  webhookId = "wh_compliance_1",
  triggeredAt,
  maintenanceOwnerToken,
}: {
  body: Record<string, unknown>;
  shop?: string;
  topic?: string;
  webhookId?: string;
  triggeredAt?: string;
  maintenanceOwnerToken?: string;
}) {
  const rawBody = JSON.stringify(body);
  return new Request("https://weletic.test/api/shopify/integration/webhook", {
    method: "POST",
    body: rawBody,
    headers: {
      "content-type": "application/json",
      "x-shopify-topic": topic,
      "x-shopify-shop-domain": shop,
      "x-shopify-webhook-id": webhookId,
      "x-shopify-hmac-sha256": createHmac("sha256", secret)
        .update(rawBody)
        .digest("base64"),
      ...(topic === "app/uninstalled"
        ? {
            "x-shopify-triggered-at":
              triggeredAt ?? new Date(Date.now() - 60_000).toISOString(),
          }
        : {}),
      ...(maintenanceOwnerToken
        ? {
            "x-weletic-loyalty-maintenance-token": maintenanceOwnerToken,
          }
        : {}),
    },
  });
}

function resolvedStore(domain: string) {
  const tenant = domain.startsWith("b.") ? "b" : "a";
  return {
    storeId: `store_${tenant}`,
    workspaceId: `workspace_${tenant}`,
    programId: `program_${tenant}`,
    canonicalShopDomain: `${tenant}.myshopify.com`,
    storageShopDomain: `${tenant}.myshopify.com`,
    complianceState: "active",
    resolvedFromTombstone: false,
  };
}

describe("central durable Shopify compliance ingress", () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SHOPIFY_WEBHOOK_SECRET = secret;
    vi.stubEnv("SHOPIFY_WEBHOOK_SECRET_NEXT", "");
    mocks.resolveComplianceStore.mockImplementation(async (domain: string) =>
      resolvedStore(domain),
    );
    mocks.persistAndQueue.mockResolvedValue({
      requestId: "wcomp_1",
      created: true,
      status: "pending",
    });
    mocks.resolveOperationalStore.mockResolvedValue(null);
    mocks.operationalStoreFindUnique.mockResolvedValue({
      id: "store_a",
      complianceState: "active",
      shopCurrency: "USD",
      currencyVerifiedAt: new Date("2026-08-29T00:00:00.000Z"),
      installationGeneration: "sgen_current",
    });
    mocks.loyaltyProgramFindUnique.mockResolvedValue(null);
    mocks.projectFindUnique.mockResolvedValue({
      id: "workspace_a",
      defaultProgramId: "program_a",
      webhookEnabled: true,
    });
    mocks.webhookEventCreate.mockResolvedValue({ id: "event_1" });
    mocks.webhookEventFindUnique.mockResolvedValue(null);
    mocks.webhookEventUpdateMany.mockResolvedValue({ count: 1 });
    mocks.redisSet.mockResolvedValue("OK");
    mocks.redisEval.mockResolvedValue(1);
    mocks.publishJSON.mockResolvedValue({ messageId: "q_1" });
    mocks.ordersPaid.mockResolvedValue("privacy-minimized order");
    mocks.refundsCreate.mockResolvedValue("privacy-minimized refund");
    mocks.customersSync.mockResolvedValue("customer synchronized");
    mocks.shopifyAdminGraphqlRequest.mockResolvedValue({ customer: null });
    mocks.discountsDelete.mockResolvedValue("discount deleted");
    mocks.discountsUpdate.mockResolvedValue("discount updated");
    mocks.segmentMembershipChanged.mockResolvedValue("segment updated");
    mocks.captureWebhookLog.mockResolvedValue(undefined);
    mocks.transaction.mockImplementation((callback, client) =>
      callback(client),
    );
  });

  it("handles an authenticated unmapped privacy request without customer ingestion", async () => {
    vi.stubEnv("SHOPIFY_API_KEY", "public-app");
    mocks.resolveComplianceStore.mockResolvedValue(null);
    mocks.pendingPrivacy.mockResolvedValue({ disposition: "no_customer_data" });
    const response = await POST(
      signedRequest({
        body: {
          shop_domain: "a.myshopify.com",
          customer: { id: 42 },
          orders_requested: [],
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(mocks.pendingPrivacy).toHaveBeenCalledWith(
      expect.anything(),
      { appId: "public-app", shop: "a.myshopify.com" },
      "customers/data_request",
      null,
    );
    expect(mocks.persistAndQueue).not.toHaveBeenCalled();
    expect(mocks.customersSync).not.toHaveBeenCalled();
    expect(mocks.publishJSON).not.toHaveBeenCalled();
  });

  it("rejects a mismatched unknown header/body tenant before pending privacy", async () => {
    mocks.resolveComplianceStore.mockResolvedValue(null);
    const request = signedRequest({
      body: { shop_domain: "a.myshopify.com", customer: { id: 42 } },
    });
    request.headers.set("x-shopify-shop-domain", "b.myshopify.com");
    expect((await POST(request)).status).toBe(401);
    expect(mocks.pendingPrivacy).not.toHaveBeenCalled();
  });

  it("retries a pending privacy request if company mapping wins the race", async () => {
    vi.stubEnv("SHOPIFY_API_KEY", "public-app");
    mocks.resolveComplianceStore.mockResolvedValue(null);
    mocks.pendingPrivacy.mockResolvedValue({ disposition: "mapped" });
    const response = await POST(
      signedRequest({
        body: { shop_domain: "a.myshopify.com", customer: { id: 42 } },
      }),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("5");
  });

  it("accepts the next signing key only during configured overlap", async () => {
    const next = "central-compliance-next-key-at-least-32-characters";
    const body = {
      shop_domain: "a.myshopify.com",
      customer: { id: 42 },
      orders_requested: [101],
    };
    const makeRequest = () => {
      const request = signedRequest({ body });
      request.headers.set(
        "x-shopify-hmac-sha256",
        createHmac("sha256", next)
          .update(JSON.stringify(body))
          .digest("base64"),
      );
      return request;
    };
    vi.stubEnv("SHOPIFY_WEBHOOK_SECRET_NEXT", next);
    expect((await POST(makeRequest())).status).toBe(200);
    expect(mocks.persistAndQueue).toHaveBeenCalledTimes(1);
    vi.stubEnv("SHOPIFY_WEBHOOK_SECRET_NEXT", "");
    expect((await POST(makeRequest())).status).toBe(401);
    expect(mocks.persistAndQueue).toHaveBeenCalledTimes(1);
  });

  it("persists encrypted durable work before acknowledging and never requires an Admin token", async () => {
    const body = {
      shop_domain: "a.myshopify.com",
      customer: { id: 42 },
      orders_requested: [101],
    };
    const response = await POST(signedRequest({ body }));

    expect(response.status).toBe(200);
    expect(mocks.persistAndQueue).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId: "store_a",
        canonicalShopDomain: "a.myshopify.com",
        storageShopDomain: "a.myshopify.com",
        alreadyRedacted: false,
        webhookId: "wh_compliance_1",
        authenticatedBodyDigests: [
          expect.stringMatching(authenticatedBodyDigestPattern),
        ],
        topic: "customers/data_request",
        payload: body,
      }),
    );
    expect(mocks.resolveOperationalStore).not.toHaveBeenCalled();
    expect(mocks.captureWebhookLog).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: expect.objectContaining({
          authenticatedBodyDigest: expect.stringMatching(
            authenticatedBodyDigestPattern,
          ),
        }),
      }),
    );
  });

  it("accepts an idempotent duplicate without running compliance work inline", async () => {
    mocks.persistAndQueue.mockResolvedValue({
      requestId: "wcomp_existing",
      created: false,
      status: "processing",
    });
    const response = await POST(
      signedRequest({
        body: {
          shop_domain: "a.myshopify.com",
          customer: { id: 42 },
          orders_requested: [],
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("already durable");
  });

  it("rejects a signed body bound to another exact tenant", async () => {
    const response = await POST(
      signedRequest({
        shop: "a.myshopify.com",
        body: {
          shop_domain: "b.myshopify.com",
          customer: { id: 42 },
          orders_requested: [],
        },
      }),
    );
    expect(response.status).toBe(401);
    expect(mocks.persistAndQueue).not.toHaveBeenCalled();
  });

  it("persists app/uninstalled instead of scrubbing credentials on ingress", async () => {
    const payload = { myshopify_domain: "a.myshopify.com" };
    const triggeredAt = new Date(Date.now() - 60_000).toISOString();
    const response = await POST(
      signedRequest({
        topic: "app/uninstalled",
        webhookId: "wh_uninstall_1",
        triggeredAt,
        body: payload,
      }),
    );
    expect(response.status).toBe(200);
    expect(mocks.persistAndQueue).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: "app/uninstalled",
        payload,
        triggeredAt: new Date(triggeredAt),
      }),
    );
  });

  it("rejects a missing or unreasonably future uninstall cutoff after HMAC verification", async () => {
    const payload = { myshopify_domain: "a.myshopify.com" };
    const missing = signedRequest({
      topic: "app/uninstalled",
      webhookId: "wh_uninstall_missing_cutoff",
      body: payload,
    });
    missing.headers.delete("x-shopify-triggered-at");
    expect((await POST(missing)).status).toBe(400);

    const future = signedRequest({
      topic: "app/uninstalled",
      webhookId: "wh_uninstall_future_cutoff",
      triggeredAt: "2999-01-01T00:00:00Z",
      body: payload,
    });
    expect((await POST(future)).status).toBe(400);
    expect(mocks.persistAndQueue).not.toHaveBeenCalled();
  });

  it("rejects invalid HMAC before token-free resolution or persistence", async () => {
    const request = signedRequest({
      body: {
        shop_domain: "a.myshopify.com",
        customer: { id: 42 },
        orders_requested: [],
      },
    });
    request.headers.set("x-shopify-hmac-sha256", "invalid");
    request.headers.set(
      "x-weletic-loyalty-maintenance-token",
      "invalid-hmac-owner-token-must-never-be-consumed",
    );
    const response = await POST(request);
    expect(response.status).toBe(401);
    expect(mocks.resolveComplianceStore).not.toHaveBeenCalled();
    expect(mocks.persistAndQueue).not.toHaveBeenCalled();
    expect(mocks.loyaltyProgramFindUnique).not.toHaveBeenCalled();
  });

  it("returns a retryable response before durable claim for a non-owner webhook during maintenance", async () => {
    configureOperationalMaintenanceLease();

    const response = await POST(
      signedRequest({
        topic: "orders/paid",
        webhookId: "wh_maintenance_non_owner",
        body: { id: 9001 },
      }),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(mocks.webhookEventCreate).not.toHaveBeenCalled();
    expect(mocks.ordersPaid).not.toHaveBeenCalled();
  });

  it("rejects a non-matching maintenance owner credential before durable claim", async () => {
    configureOperationalMaintenanceLease();

    const response = await POST(
      signedRequest({
        topic: "orders/paid",
        webhookId: "wh_maintenance_wrong_owner",
        maintenanceOwnerToken:
          "wrong-maintenance-owner-token-at-least-32-characters",
        body: { id: 9001 },
      }),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(mocks.webhookEventCreate).not.toHaveBeenCalled();
    expect(mocks.ordersPaid).not.toHaveBeenCalled();
  });

  it("threads an authenticated maintenance owner permit through order ingress without exposing the credential", async () => {
    configureOperationalMaintenanceLease();

    const response = await POST(
      signedRequest({
        topic: "orders/paid",
        webhookId: "wh_maintenance_owner",
        maintenanceOwnerToken,
        body: { id: 9001 },
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.ordersPaid).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId: "store_a",
        loyaltyMaintenancePermit: expect.objectContaining({
          authorization: "owner_token",
          storeId: "store_a",
        }),
      }),
    );
    expect(
      JSON.stringify([
        await response.text(),
        mocks.captureWebhookLog.mock.calls,
        mocks.webhookEventCreate.mock.calls,
      ]),
    ).not.toContain(maintenanceOwnerToken);
  });

  it("threads an authenticated maintenance owner permit through refund ingress", async () => {
    configureOperationalMaintenanceLease();

    const response = await POST(
      signedRequest({
        topic: "refunds/create",
        webhookId: "wh_maintenance_owner_refund",
        maintenanceOwnerToken,
        body: { id: 9002, order_id: 9001 },
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.refundsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId: "store_a",
        loyaltyMaintenancePermit: expect.objectContaining({
          authorization: "owner_token",
          storeId: "store_a",
        }),
      }),
    );
  });

  it("authorizes a current-version customers/create only from its exact Admin readback", async () => {
    configureOperationalMaintenanceLease();
    mocks.shopifyAdminGraphqlRequest.mockResolvedValue({
      customer: {
        id: "gid://shopify/Customer/42",
        tags: [
          LOYALTY_MAINTENANCE_DISPOSABLE_CUSTOMER_TAG,
          maintenanceRunMarker,
        ],
      },
    });
    const body = {
      id: 42,
      admin_graphql_api_id: "gid://shopify/Customer/42",
      email: maintenanceFixtureEmail,
      first_name: "A1",
    };

    const accepted = await POST(
      signedRequest({
        topic: "customers/create",
        webhookId: "wh_maintenance_fixture_customer",
        // Customer-resource webhooks no longer contain tags in API 2025-01+.
        body,
      }),
    );

    expect(accepted.status).toBe(200);
    expect(mocks.shopifyAdminGraphqlRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        shopDomain: "a.myshopify.com",
        accessToken: "test-store-access-token",
        variables: { id: "gid://shopify/Customer/42" },
        maxRetries: 0,
        requestTimeoutMs: 1_500,
      }),
    );
    expect(
      mocks.shopifyAdminGraphqlRequest.mock.calls[0][0].query,
    ).not.toContain("email");
    expect(mocks.webhookEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ payload: Prisma.DbNull }),
      }),
    );
    expect(mocks.customersSync).toHaveBeenCalledWith(
      expect.objectContaining({
        event: { ...body, id: "42" },
        storeId: "store_a",
        loyaltyMaintenancePermit: expect.objectContaining({
          authorization: "fixture_customer_create",
          storeId: "store_a",
        }),
      }),
    );
  });

  it("uses the canonical signed customer GID when Shopify's uint64 REST id is rounded", async () => {
    configureOperationalMaintenanceLease();
    const exactCustomerId = "18446744073709551615";
    const roundedCustomerId = Number(exactCustomerId);
    const customerGid = `gid://shopify/Customer/${exactCustomerId}`;
    const body = {
      id: roundedCustomerId,
      admin_graphql_api_id: customerGid,
      email: maintenanceFixtureEmail,
    };
    mocks.shopifyAdminGraphqlRequest.mockResolvedValue({
      customer: {
        id: customerGid,
        tags: [
          LOYALTY_MAINTENANCE_DISPOSABLE_CUSTOMER_TAG,
          maintenanceRunMarker,
        ],
      },
    });

    expect(Number.isSafeInteger(roundedCustomerId)).toBe(false);
    expect(String(roundedCustomerId)).not.toBe(exactCustomerId);

    const response = await POST(
      signedRequest({
        topic: "customers/create",
        webhookId: "wh_maintenance_uint64_customer",
        body,
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.shopifyAdminGraphqlRequest).toHaveBeenCalledWith(
      expect.objectContaining({ variables: { id: customerGid } }),
    );
    expect(mocks.webhookEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payload: Prisma.DbNull,
          authenticatedBodyDigest: createAllShopifyWebhookBodyDigests({
            topic: "customers/create",
            rawBodyBytes: Buffer.from(JSON.stringify(body)),
          })[0],
        }),
      }),
    );
    expect(mocks.customersSync).toHaveBeenCalledWith(
      expect.objectContaining({
        event: { ...body, id: exactCustomerId },
      }),
    );
  });

  it("rejects conflicting exact customer ids before maintenance Admin readback", async () => {
    configureOperationalMaintenanceLease();

    const response = await POST(
      signedRequest({
        topic: "customers/create",
        webhookId: "wh_maintenance_conflicting_customer_ids",
        body: {
          id: 41,
          admin_graphql_api_id: "gid://shopify/Customer/42",
          email: maintenanceFixtureEmail,
        },
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(maintenanceFixtureEmail);
    expect(mocks.shopifyAdminGraphqlRequest).not.toHaveBeenCalled();
    expect(mocks.loyaltyProgramFindUnique).not.toHaveBeenCalled();
    expect(mocks.webhookEventCreate).not.toHaveBeenCalled();
    expect(mocks.customersSync).not.toHaveBeenCalled();
  });

  it.each(["customers/create", "customers/update"] as const)(
    "normalizes the exact signed uint64 customer GID for ordinary %s dispatch",
    async (topic) => {
      mocks.resolveOperationalStore.mockResolvedValue({
        storeId: "store_a",
        workspaceId: "workspace_a",
        programId: "program_a",
        myshopifyDomain: "a.myshopify.com",
        accessToken: "test-store-access-token",
      });
      const exactCustomerId = "18446744073709551615";
      const body = {
        id: Number(exactCustomerId),
        admin_graphql_api_id: `gid://shopify/Customer/${exactCustomerId}`,
        email: "ordinary-customer@example.com",
      };

      const response = await POST(
        signedRequest({
          topic,
          webhookId: `wh_ordinary_uint64_${topic.replace("/", "_")}`,
          body,
        }),
      );

      expect(response.status).toBe(200);
      expect(mocks.shopifyAdminGraphqlRequest).not.toHaveBeenCalled();
      expect(mocks.customersSync).toHaveBeenCalledWith(
        expect.objectContaining({
          event: { ...body, id: exactCustomerId },
          loyaltyMaintenancePermit: undefined,
        }),
      );
    },
  );

  it.each(["customers/create", "customers/update"] as const)(
    "rejects conflicting exact customer ids for ordinary %s before persistence",
    async (topic) => {
      const response = await POST(
        signedRequest({
          topic,
          webhookId: `wh_ordinary_conflicting_ids_${topic.replace("/", "_")}`,
          body: {
            id: "41",
            admin_graphql_api_id: "gid://shopify/Customer/42",
            email: "ordinary-customer@example.com",
          },
        }),
      );

      expect(response.status).toBe(400);
      expect(mocks.resolveOperationalStore).not.toHaveBeenCalled();
      expect(mocks.shopifyAdminGraphqlRequest).not.toHaveBeenCalled();
      expect(mocks.webhookEventCreate).not.toHaveBeenCalled();
      expect(mocks.customersSync).not.toHaveBeenCalled();
    },
  );

  it("keeps complete signed legacy tag evidence authoritative without an Admin lookup", async () => {
    configureOperationalMaintenanceLease();
    const body = {
      id: 42,
      email: maintenanceFixtureEmail,
      tags: `${LOYALTY_MAINTENANCE_DISPOSABLE_CUSTOMER_TAG},${maintenanceRunMarker}`,
    };

    const response = await POST(
      signedRequest({
        topic: "customers/create",
        webhookId: "wh_maintenance_signed_tags",
        body,
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.shopifyAdminGraphqlRequest).not.toHaveBeenCalled();
    expect(mocks.customersSync).toHaveBeenCalledWith(
      expect.objectContaining({ event: body }),
    );
  });

  it.each([
    ["null", null],
    ["empty string", ""],
    ["empty array", []],
    ["missing run marker", [LOYALTY_MAINTENANCE_DISPOSABLE_CUSTOMER_TAG]],
    [
      "mixed array",
      [LOYALTY_MAINTENANCE_DISPOSABLE_CUSTOMER_TAG, 42, maintenanceRunMarker],
    ],
    ["invalid object", { marker: maintenanceRunMarker }],
  ])(
    "treats present %s tags as signed negative evidence without an Admin lookup",
    async (_label, tags) => {
      configureOperationalMaintenanceLease();

      const response = await POST(
        signedRequest({
          topic: "customers/create",
          webhookId: `wh_maintenance_negative_tags_${String(_label).replaceAll(" ", "_")}`,
          body: {
            id: 42,
            admin_graphql_api_id: "gid://shopify/Customer/42",
            email: maintenanceFixtureEmail,
            tags,
          },
        }),
      );

      expect(response.status).toBe(503);
      expect(mocks.shopifyAdminGraphqlRequest).not.toHaveBeenCalled();
      expect(mocks.webhookEventCreate).not.toHaveBeenCalled();
      expect(mocks.customersSync).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["missing", undefined],
    ["mismatched", "not-the-fixture@maintenance.invalid"],
  ])(
    "rejects a current-version body with %s signed email before Admin readback",
    async (_label, email) => {
      configureOperationalMaintenanceLease();
      mocks.shopifyAdminGraphqlRequest.mockResolvedValue({
        customer: {
          id: "gid://shopify/Customer/42",
          tags: [
            LOYALTY_MAINTENANCE_DISPOSABLE_CUSTOMER_TAG,
            maintenanceRunMarker,
          ],
        },
      });
      const body: Record<string, unknown> = {
        id: 42,
        admin_graphql_api_id: "gid://shopify/Customer/42",
      };
      if (email !== undefined) body.email = email;

      const response = await POST(
        signedRequest({
          topic: "customers/create",
          webhookId: `wh_maintenance_${_label}_signed_email`,
          body,
        }),
      );

      expect(response.status).toBe(503);
      expect(mocks.shopifyAdminGraphqlRequest).not.toHaveBeenCalled();
      expect(mocks.webhookEventCreate).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["missing customer", null],
    [
      "different customer id",
      {
        id: "gid://shopify/Customer/43",
        tags: [
          LOYALTY_MAINTENANCE_DISPOSABLE_CUSTOMER_TAG,
          maintenanceRunMarker,
        ],
      },
    ],
    [
      "missing disposable tag",
      {
        id: "gid://shopify/Customer/42",
        tags: [maintenanceRunMarker],
      },
    ],
    [
      "missing run-marker tag",
      {
        id: "gid://shopify/Customer/42",
        tags: [LOYALTY_MAINTENANCE_DISPOSABLE_CUSTOMER_TAG],
      },
    ],
  ])(
    "rejects a %s Admin customer readback before persistence",
    async (_label, customer) => {
      configureOperationalMaintenanceLease();
      mocks.shopifyAdminGraphqlRequest.mockResolvedValue({ customer });

      const rejected = await POST(
        signedRequest({
          topic: "customers/create",
          webhookId: `wh_maintenance_readback_${String(_label).replaceAll(" ", "_")}`,
          body: {
            id: 42,
            admin_graphql_api_id: "gid://shopify/Customer/42",
            email: maintenanceFixtureEmail,
          },
        }),
      );

      expect(rejected.status).toBe(503);
      expect(rejected.headers.get("retry-after")).toBe("5");
      expect(mocks.webhookEventCreate).not.toHaveBeenCalled();
      expect(mocks.customersSync).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["timeout", new Error("Admin readback timed out")],
    ["GraphQL error", new Error("Admin GraphQL response was invalid")],
  ])(
    "maps an Admin readback %s to retryable maintenance blocking",
    async (_label, error) => {
      configureOperationalMaintenanceLease();
      mocks.shopifyAdminGraphqlRequest.mockRejectedValue(error);

      const response = await POST(
        signedRequest({
          topic: "customers/create",
          webhookId: `wh_maintenance_readback_${String(_label).replaceAll(" ", "_")}`,
          body: {
            id: 42,
            admin_graphql_api_id: "gid://shopify/Customer/42",
            email: maintenanceFixtureEmail,
          },
        }),
      );

      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("5");
      expect(await response.text()).not.toContain(error.message);
      expect(mocks.webhookEventCreate).not.toHaveBeenCalled();
      expect(mocks.customersSync).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["missing ids", { email: maintenanceFixtureEmail }],
    [
      "invalid GID",
      {
        id: 42,
        admin_graphql_api_id: "gid://shopify/Order/42",
        email: maintenanceFixtureEmail,
      },
    ],
    [
      "unsafe numeric compatibility id",
      { id: Number.MAX_SAFE_INTEGER + 1, email: maintenanceFixtureEmail },
    ],
  ])("rejects %s without an Admin readback", async (_label, body) => {
    configureOperationalMaintenanceLease();

    const response = await POST(
      signedRequest({
        topic: "customers/create",
        webhookId: `wh_maintenance_invalid_identity_${String(_label).replaceAll(" ", "_")}`,
        body,
      }),
    );

    expect(response.status).toBe(503);
    expect(mocks.shopifyAdminGraphqlRequest).not.toHaveBeenCalled();
    expect(mocks.webhookEventCreate).not.toHaveBeenCalled();
  });

  it("uses a canonical safe numeric customer id only as legacy compatibility", async () => {
    configureOperationalMaintenanceLease();
    mocks.shopifyAdminGraphqlRequest.mockResolvedValue({
      customer: {
        id: "gid://shopify/Customer/42",
        tags: [
          LOYALTY_MAINTENANCE_DISPOSABLE_CUSTOMER_TAG,
          maintenanceRunMarker,
        ],
      },
    });

    const response = await POST(
      signedRequest({
        topic: "customers/create",
        webhookId: "wh_maintenance_numeric_compatibility",
        body: { id: "42", email: maintenanceFixtureEmail },
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.shopifyAdminGraphqlRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        variables: { id: "gid://shopify/Customer/42" },
      }),
    );
  });

  it("accepts a later exact readback retry once and keeps the webhook idempotent", async () => {
    configureOperationalMaintenanceLease();
    const body = {
      id: 42,
      admin_graphql_api_id: "gid://shopify/Customer/42",
      email: maintenanceFixtureEmail,
    };
    const webhookId = "wh_maintenance_readback_retry";
    mocks.shopifyAdminGraphqlRequest.mockResolvedValueOnce({
      customer: {
        id: "gid://shopify/Customer/42",
        tags: [LOYALTY_MAINTENANCE_DISPOSABLE_CUSTOMER_TAG],
      },
    });

    const first = await POST(
      signedRequest({ topic: "customers/create", webhookId, body }),
    );
    expect(first.status).toBe(503);
    expect(mocks.webhookEventCreate).not.toHaveBeenCalled();

    mocks.shopifyAdminGraphqlRequest.mockResolvedValue({
      customer: {
        id: "gid://shopify/Customer/42",
        tags: [
          LOYALTY_MAINTENANCE_DISPOSABLE_CUSTOMER_TAG,
          maintenanceRunMarker,
        ],
      },
    });
    const second = await POST(
      signedRequest({ topic: "customers/create", webhookId, body }),
    );
    expect(second.status).toBe(200);
    expect(mocks.customersSync).toHaveBeenCalledTimes(1);

    const authenticatedBodyDigest = createAllShopifyWebhookBodyDigests({
      topic: "customers/create",
      rawBodyBytes: Buffer.from(JSON.stringify(body)),
    })[0];
    const existing = {
      id: "event_1",
      storeId: "store_a",
      topic: "customers/create",
      status: "processed",
      attempts: 1,
      authenticatedBodyDigest,
      storeInstallationGeneration: "sgen_current",
    };
    mocks.webhookEventCreate.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("duplicate", {
        code: "P2002",
        clientVersion: "test",
      }),
    );
    mocks.webhookEventFindUnique.mockResolvedValue(existing);
    mocks.webhookEventUpdateMany.mockResolvedValueOnce({ count: 0 });

    const duplicate = await POST(
      signedRequest({ topic: "customers/create", webhookId, body }),
    );
    expect(duplicate.status).toBe(200);
    expect(await duplicate.text()).toContain("already processed");
    expect(mocks.webhookEventCreate).toHaveBeenCalledTimes(2);
    expect(mocks.customersSync).toHaveBeenCalledTimes(1);
  });

  it("revalidates the exact maintenance lease inside the persistence transaction", async () => {
    configureOperationalMaintenanceLease();
    mocks.shopifyAdminGraphqlRequest.mockResolvedValue({
      customer: {
        id: "gid://shopify/Customer/42",
        tags: [
          LOYALTY_MAINTENANCE_DISPOSABLE_CUSTOMER_TAG,
          maintenanceRunMarker,
        ],
      },
    });
    const replacementMetadata = createLoyaltyMaintenanceLeaseMetadata({
      existingMetadata: null,
      ownerToken: maintenanceOwnerToken,
      runMarker: maintenanceRunMarker,
      fixtureEmails: [maintenanceFixtureEmail],
      acquiredAt: new Date("2026-08-31T00:00:01.000Z"),
      recoveryAfter: new Date("2026-08-31T01:00:01.000Z"),
    });
    mocks.transaction.mockImplementationOnce(async (callback, client) => {
      const queryRaw = vi
        .fn()
        .mockResolvedValueOnce([
          {
            id: "store_a",
            complianceState: "active",
            shopCurrency: "USD",
            currencyVerifiedAt: new Date("2026-08-29T00:00:00.000Z"),
            installationGeneration: "sgen_current",
          },
        ])
        .mockResolvedValueOnce([
          {
            id: "program_a",
            storeId: "store_a",
            status: "active",
            killSwitchActive: false,
            metadata: replacementMetadata,
          },
        ]);
      return callback({ ...client, $queryRaw: queryRaw });
    });

    const response = await POST(
      signedRequest({
        topic: "customers/create",
        webhookId: "wh_maintenance_lease_replaced",
        body: {
          id: 42,
          admin_graphql_api_id: "gid://shopify/Customer/42",
          email: maintenanceFixtureEmail,
        },
      }),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(mocks.webhookEventCreate).not.toHaveBeenCalled();
    expect(mocks.customersSync).not.toHaveBeenCalled();
  });

  it("rejects an oversized body before HMAC or persistence", async () => {
    const rawBody = JSON.stringify({
      shop_domain: "a.myshopify.com",
      padding: "x".repeat(WELETIC_SHOPIFY_MAX_WEBHOOK_BODY_BYTES),
    });
    const response = await POST(
      new Request("https://weletic.test/api/shopify/integration/webhook", {
        method: "POST",
        body: rawBody,
        headers: {
          "x-shopify-topic": "customers/data_request",
          "x-shopify-shop-domain": "a.myshopify.com",
          "x-shopify-webhook-id": "wh_large",
          "x-shopify-hmac-sha256": "not-evaluated",
        },
      }),
    );
    expect(response.status).toBe(413);
    expect(mocks.resolveComplianceStore).not.toHaveBeenCalled();
  });

  it("accepts a valid external Shopify payload larger than the 256 KiB internal-service cap", async () => {
    mocks.resolveOperationalStore.mockResolvedValue({
      storeId: "store_a",
      workspaceId: "workspace_a",
      programId: "program_a",
    });
    mocks.operationalStoreFindUnique.mockResolvedValue({
      id: "store_a",
      complianceState: "active",
    });
    const response = await POST(
      signedRequest({
        topic: "orders/paid",
        webhookId: "wh_large_valid_order",
        body: {
          id: 9001,
          padding: "x".repeat(WELETIC_SHOPIFY_MAX_BODY_BYTES + 1),
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.ordersPaid).toHaveBeenCalledOnce();
  });

  it.each(["frozen", "redacted"] as const)(
    "acknowledges but does not dispatch operational webhooks for a %s store",
    async (complianceState) => {
      mocks.resolveOperationalStore.mockResolvedValue({
        storeId: "store_a",
        workspaceId: "workspace_a",
        programId: "program_a",
      });
      mocks.operationalStoreFindUnique.mockResolvedValue({
        id: "store_a",
        complianceState,
      });

      const response = await POST(
        signedRequest({
          topic: "customers/update",
          webhookId: `wh_${complianceState}_customer`,
          body: { id: 1001 },
        }),
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toContain("operational webhook ignored");
      expect(mocks.persistAndQueue).not.toHaveBeenCalled();
      expect(mocks.operationalStoreFindUnique).toHaveBeenCalledWith({
        where: { id: "store_a" },
        select: expect.objectContaining({ id: true, complianceState: true }),
      });
    },
  );

  it("fails closed when the Shopify HMAC secret is unavailable", async () => {
    delete process.env.SHOPIFY_WEBHOOK_SECRET;
    const response = await POST(
      signedRequest({
        body: {
          shop_domain: "a.myshopify.com",
          customer: { id: 42 },
          orders_requested: [],
        },
      }),
    );
    expect(response.status).toBe(503);
    expect(mocks.persistAndQueue).not.toHaveBeenCalled();
  });

  it.each([
    ["orders/paid", "wh_late_order", "ordersPaid"],
    ["refunds/create", "wh_late_refund", "refundsCreate"],
  ] as const)(
    "routes a post-erasure %s webhook by HMAC tombstone without retaining the raw domain",
    async (topic, webhookId, handler) => {
      const erasedDomain = "erased.myshopify.com";
      mocks.resolveComplianceStore.mockResolvedValue({
        storeId: "store_a",
        workspaceId: "workspace_a",
        programId: "program_a",
        canonicalShopDomain: erasedDomain,
        storageShopDomain: "redacted-kid-safe.invalid",
        complianceState: "redacted",
        resolvedFromTombstone: true,
      });
      const generation = "sgen_redacted";
      mocks.operationalStoreFindUnique.mockResolvedValue({
        id: "store_a",
        complianceState: "redacted",
        shopCurrency: "USD",
        currencyVerifiedAt: new Date("2026-08-29T00:00:00.000Z"),
        installationGeneration: generation,
      });
      const response = await POST(
        signedRequest({
          topic,
          webhookId,
          shop: erasedDomain,
          maintenanceOwnerToken:
            "ignored-private-owner-header-on-redacted-financial-path",
          body: { id: 9001, order_id: 9000 },
        }),
      );

      expect(response.status).toBe(200);
      expect(mocks.resolveOperationalStore).not.toHaveBeenCalled();
      expect(mocks.loyaltyProgramFindUnique).not.toHaveBeenCalled();
      if (handler === "ordersPaid") {
        expect(mocks.ordersPaid).toHaveBeenCalledWith({
          event: { id: 9001, order_id: 9000 },
          workspace: {
            id: "workspace_a",
            defaultProgramId: "program_a",
            webhookEnabled: true,
          },
          storeId: "store_a",
          expectedInstallationGeneration: generation,
          privacyMinimizedFinancialSettlement: true,
          loyaltyMaintenancePermit: undefined,
        });
      } else {
        expect(mocks.refundsCreate).toHaveBeenCalledWith({
          event: { id: 9001, order_id: 9000 },
          workspaceId: "workspace_a",
          storeId: "store_a",
          expectedInstallationGeneration: generation,
          privacyMinimizedFinancialSettlement: true,
          loyaltyMaintenancePermit: undefined,
        });
      }
      expect(JSON.stringify(mocks.captureWebhookLog.mock.calls)).not.toContain(
        erasedDomain,
      );
      expect(JSON.stringify(mocks.webhookEventCreate.mock.calls)).not.toContain(
        erasedDomain,
      );
      expect(mocks.webhookEventCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            authenticatedBodyDigest: expect.stringMatching(
              authenticatedBodyDigestPattern,
            ),
          }),
        }),
      );
    },
  );

  it("does not persist an operational event when shop freeze wins after the plain precheck", async () => {
    mocks.resolveOperationalStore.mockResolvedValue({
      storeId: "store_a",
      workspaceId: "workspace_a",
      programId: "program_a",
    });
    mocks.operationalStoreFindUnique
      .mockResolvedValueOnce({ id: "store_a", complianceState: "active" })
      .mockResolvedValueOnce({ id: "store_a", complianceState: "frozen" });

    const response = await POST(
      signedRequest({
        topic: "customers/update",
        webhookId: "wh_freeze_between_check_and_create",
        body: { id: 42, email: "raw@example.com" },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("frozen for compliance");
    expect(mocks.webhookEventCreate).not.toHaveBeenCalled();
    expect(mocks.customersSync).not.toHaveBeenCalled();
  });

  it("never persists raw customer identifiers when a post-redaction customer handler crashes", async () => {
    mocks.resolveOperationalStore.mockResolvedValue({
      storeId: "store_a",
      workspaceId: "workspace_a",
      programId: "program_a",
    });
    mocks.operationalStoreFindUnique.mockResolvedValue({
      id: "store_a",
      complianceState: "active",
    });
    mocks.customersSync.mockRejectedValueOnce(
      new Error("customer is independently tombstoned"),
    );

    const response = await POST(
      signedRequest({
        topic: "customers/update",
        webhookId: "wh_customer_after_redact",
        body: { id: 42, email: "raw@example.com" },
      }),
    );

    expect(response.status).toBe(500);
    expect(mocks.webhookEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ payload: Prisma.DbNull }),
      }),
    );
    expect(JSON.stringify(mocks.webhookEventCreate.mock.calls)).not.toContain(
      "raw@example.com",
    );
    expect(mocks.webhookEventUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ payload: Prisma.DbNull }),
      }),
    );
  });

  it("rejects an operational duplicate id bound to different authenticated bytes", async () => {
    mocks.resolveOperationalStore.mockResolvedValue({
      storeId: "store_a",
      workspaceId: "workspace_a",
      programId: "program_a",
    });
    mocks.operationalStoreFindUnique.mockResolvedValue({
      id: "store_a",
      complianceState: "active",
    });
    mocks.webhookEventCreate.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("duplicate", {
        code: "P2002",
        clientVersion: "test",
      }),
    );
    mocks.webhookEventFindUnique.mockResolvedValue({
      id: "event_existing",
      storeId: "store_a",
      topic: "orders/paid",
      status: "processed",
      attempts: 1,
      authenticatedBodyDigest: `hmac:v1:test-v1:${"F".repeat(64)}`,
    });

    const response = await POST(
      signedRequest({
        topic: "orders/paid",
        webhookId: "wh_collision",
        body: { id: 9001 },
      }),
    );

    expect(response.status).toBe(409);
    expect(mocks.ordersPaid).not.toHaveBeenCalled();
    expect(mocks.webhookEventUpdateMany).not.toHaveBeenCalled();
  });

  it.each([
    ["completion", false],
    ["failure", true],
  ] as const)(
    "discards a stale operational %s after its monotonic attempt lease is reclaimed",
    async (_label, handlerFails) => {
      mocks.resolveOperationalStore.mockResolvedValue({
        storeId: "store_a",
        workspaceId: "workspace_a",
        programId: "program_a",
      });
      mocks.operationalStoreFindUnique.mockResolvedValue({
        id: "store_a",
        complianceState: "active",
      });
      mocks.webhookEventUpdateMany.mockResolvedValueOnce({ count: 0 });
      if (handlerFails) {
        mocks.ordersPaid.mockRejectedValueOnce(new Error("handler failed"));
      }

      const response = await POST(
        signedRequest({
          topic: "orders/paid",
          webhookId: `wh_stale_${handlerFails ? "failure" : "completion"}`,
          body: { id: 9001 },
        }),
      );

      expect(response.status).toBe(409);
      expect(mocks.webhookEventUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: "event_1",
            storeId: "store_a",
            topic: "orders/paid",
            status: "received",
            attempts: 1,
            storeInstallationGeneration: null,
          },
        }),
      );
    },
  );

  it("returns retryable failure when a duplicate loser rereads a newly failed reclaim", async () => {
    mocks.resolveOperationalStore.mockResolvedValue({
      storeId: "store_a",
      workspaceId: "workspace_a",
      programId: "program_a",
    });
    mocks.operationalStoreFindUnique.mockResolvedValue({
      id: "store_a",
      complianceState: "active",
    });
    mocks.webhookEventCreate.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("duplicate", {
        code: "P2002",
        clientVersion: "test",
      }),
    );
    const digest = createAllShopifyWebhookBodyDigests({
      topic: "orders/paid",
      rawBodyBytes: Buffer.from(JSON.stringify({ id: 9001 })),
    })[0];
    mocks.webhookEventFindUnique
      .mockResolvedValueOnce({
        id: "event_existing",
        storeId: "store_a",
        topic: "orders/paid",
        status: "failed",
        attempts: 1,
        authenticatedBodyDigest: digest,
      })
      .mockResolvedValueOnce({
        storeId: "store_a",
        topic: "orders/paid",
        status: "failed",
        authenticatedBodyDigest: digest,
      });
    // Worker B reclaimed attempt 2 and failed it before worker A observed its
    // failed-attempt-1 CAS loss.
    mocks.webhookEventUpdateMany.mockResolvedValueOnce({ count: 0 });

    const response = await POST(
      signedRequest({
        topic: "orders/paid",
        webhookId: "wh_failed_reclaim_race",
        body: { id: 9001 },
      }),
    );

    expect(response.status).toBe(503);
    expect(mocks.ordersPaid).not.toHaveBeenCalled();
  });

  it.each([
    ["discounts/delete", "discountsDelete"],
    ["discounts/update", "discountsUpdate"],
    ["customers/update", "customersSync"],
    ["customer.joined_segment", "segmentMembershipChanged"],
  ] as const)(
    "terminally suppresses a failed generation-one %s delivery after generation two is connected",
    async (topic, handlerName) => {
      const generationOne = "sgen_one";
      const generationTwo = "sgen_two";
      mocks.resolveOperationalStore.mockResolvedValue({
        storeId: "store_a",
        workspaceId: "workspace_a",
        programId: "program_a",
      });
      mocks.operationalStoreFindUnique.mockResolvedValue({
        id: "store_a",
        complianceState: "active",
        shopCurrency: "USD",
        currencyVerifiedAt: new Date("2026-08-29T00:00:00.000Z"),
        installationGeneration: generationTwo,
      });
      mocks.webhookEventCreate.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError("duplicate", {
          code: "P2002",
          clientVersion: "test",
        }),
      );
      const body = { id: 9001 };
      const digest = createAllShopifyWebhookBodyDigests({
        topic,
        rawBodyBytes: Buffer.from(JSON.stringify(body)),
      })[0];
      mocks.webhookEventFindUnique.mockResolvedValueOnce({
        id: "event_generation_one",
        storeId: "store_a",
        topic,
        status: "failed",
        attempts: 1,
        authenticatedBodyDigest: digest,
        storeInstallationGeneration: generationOne,
      });

      const response = await POST(
        signedRequest({
          topic,
          webhookId: `wh_generation_one_${handlerName}`,
          body,
        }),
      );

      expect(response.status).toBe(200);
      expect(mocks[handlerName]).not.toHaveBeenCalled();
      expect(mocks.webhookEventUpdateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          id: "event_generation_one",
          storeInstallationGeneration: generationOne,
          status: { in: ["received", "failed"] },
        }),
        data: expect.objectContaining({
          status: "processed",
          error:
            "Suppressed because the Shopify installation generation changed.",
        }),
      });
    },
  );

  it.each([
    ["orders/paid", "ordersPaid"],
    ["refunds/create", "refundsCreate"],
  ] as const)(
    "reclaims a generation-one %s delivery after generation two only through privacy-minimized settlement",
    async (topic, handlerName) => {
      const generationOne = "sgen_one";
      const generationTwo = "sgen_two";
      mocks.resolveOperationalStore.mockResolvedValue({
        storeId: "store_a",
        workspaceId: "workspace_a",
        programId: "program_a",
      });
      mocks.operationalStoreFindUnique.mockResolvedValue({
        id: "store_a",
        complianceState: "active",
        shopCurrency: "USD",
        currencyVerifiedAt: new Date("2026-08-29T00:00:00.000Z"),
        installationGeneration: generationTwo,
      });
      mocks.webhookEventCreate.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError("duplicate", {
          code: "P2002",
          clientVersion: "test",
        }),
      );
      const body = { id: 9001 };
      const digest = createAllShopifyWebhookBodyDigests({
        topic,
        rawBodyBytes: Buffer.from(JSON.stringify(body)),
      })[0];
      mocks.webhookEventFindUnique.mockResolvedValueOnce({
        id: "event_generation_one",
        storeId: "store_a",
        topic,
        status: "failed",
        attempts: 1,
        authenticatedBodyDigest: digest,
        storeInstallationGeneration: generationOne,
      });

      const response = await POST(
        signedRequest({
          topic,
          webhookId: `wh_generation_one_${handlerName}`,
          body,
        }),
      );

      expect(response.status).toBe(200);
      expect(mocks.webhookEventUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "event_generation_one",
            storeInstallationGeneration: generationOne,
          }),
        }),
      );
      expect(mocks[handlerName]).toHaveBeenCalledWith(
        expect.objectContaining({
          event: body,
          storeId: "store_a",
          expectedInstallationGeneration: generationTwo,
          privacyMinimizedFinancialSettlement: true,
        }),
      );
    },
  );

  it("releases a failed catalog reservation and retries with provider idempotency", async () => {
    mocks.publishJSON
      .mockRejectedValueOnce(new Error("definite QStash rejection"))
      .mockResolvedValueOnce({ messageId: "q_retry" });

    await expect(
      enqueueDebouncedShopifyCatalogSync({
        workspaceId: "workspace_a",
        webhookId: "wh_catalog_retry",
      }),
    ).rejects.toThrow("definite QStash rejection");
    await expect(
      enqueueDebouncedShopifyCatalogSync({
        workspaceId: "workspace_a",
        webhookId: "wh_catalog_retry",
      }),
    ).resolves.toBe(true);

    expect(mocks.redisEval).toHaveBeenCalledOnce();
    expect(mocks.publishJSON).toHaveBeenCalledTimes(2);
    expect(mocks.publishJSON.mock.calls[0][0].deduplicationId).toBe(
      "weletic-shopify-catalog:workspace_a:wh_catalog_retry",
    );
    expect(mocks.publishJSON.mock.calls[1][0].deduplicationId).toBe(
      "weletic-shopify-catalog:workspace_a:wh_catalog_retry",
    );
  });
});
