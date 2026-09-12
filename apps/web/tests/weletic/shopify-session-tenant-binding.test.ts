import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sessionUpsert = vi.fn();
const integrationFindMany = vi.fn();
const integrationUpdate = vi.fn();
const transaction = vi.fn();
const storeFindUnique = vi.fn();
const queryRaw = vi.fn();
const complianceCount = vi.fn();
const resolveComplianceStore = vi.fn();
const shopTombstoneFindFirst = vi.fn();
const programCount = vi.fn();
const redemptionCount = vi.fn();
const outboxCount = vi.fn();
const backfillCount = vi.fn();
const storeUpdateMany = vi.fn();
const lockProgram = vi.fn();
const fetchVerifiedShop = vi.fn();
const ensureWebhooks = vi.fn();
const advanceLegacyRevision = vi.fn();
vi.mock(
  "@/lib/weletic/shopify/store-owned-credential",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/weletic/shopify/store-owned-credential")
    >()),
    assertLegacyShopifyCredentialAuthority: vi.fn(async () => undefined),
  }),
);

// These fixtures model pre-admission custom installations, not public installs.
vi.mock(
  "@/lib/weletic/shopify/installation-admission",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/weletic/shopify/installation-admission")
    >()),
    readPendingInstallation: vi.fn(async () => null),
  }),
);

vi.mock(
  "@/lib/weletic/shopify/session-coordination",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/weletic/shopify/session-coordination")
    >()),
    advanceLegacyShopifySessionRevision: advanceLegacyRevision,
    observeShopifySessionCoordination: vi.fn(async () => ({
      revision: "0",
      epoch: "0",
    })),
  }),
);

vi.mock("@/lib/encryption", () => ({
  decrypt: vi.fn((value: string) => value),
  decryptOrPassthrough: vi.fn((value: string) => value),
  encrypt: vi.fn((value: string) => value),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: transaction,
    installedIntegration: {
      findMany: integrationFindMany,
      update: integrationUpdate,
    },
    weleticShopifyAppSession: {
      upsert: sessionUpsert,
    },
    weleticShopifyStore: { findUnique: storeFindUnique },
    weleticLoyaltyProgram: { count: programCount },
    weleticRewardRedemption: { count: redemptionCount },
    weleticLoyaltyOutboxJob: { count: outboxCount },
    weleticLoyaltyBackfillJob: { count: backfillCount },
    weleticShopifyComplianceRequest: { count: complianceCount },
  },
}));

vi.mock("@/lib/weletic/shopify/compliance-store-resolver", () => ({
  resolveComplianceShopifyStoreByDomain: resolveComplianceStore,
}));
vi.mock("@/lib/weletic/shopify/privacy-identity", () => ({
  deriveAllShopifyShopPrivacyIdentities: vi.fn(() => [
    {
      identityKeyId: "kid_1",
      shopDomainDigest: "SAFE_SHOP_DIGEST",
    },
  ]),
}));

vi.mock("@/lib/weletic/shopify/service-auth", () => ({
  readWeleticShopifyRequestBody: vi.fn((request: Request) => request.text()),
  verifyWeleticShopifyRequest: vi.fn(() => true),
}));

vi.mock("@/lib/weletic/loyalty/program-write-fence", () => ({
  lockLoyaltyProgramRowIfPresent: lockProgram,
}));

vi.mock("@/lib/weletic/shopify/store-resolver", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/weletic/shopify/store-resolver")
  >("@/lib/weletic/shopify/store-resolver");
  return {
    ...actual,
    fetchVerifiedShopifyShopDetails: fetchVerifiedShop,
  };
});

vi.mock("@/lib/weletic/shopify/provision-webhooks", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/weletic/shopify/provision-webhooks")
  >()),
  ensureShopifyWebhooksRegistered: ensureWebhooks,
}));

const shop = "n0pvef-cs.myshopify.com";
const existingToken = "shopify-existing-token";
const canonicalTopics = [
  "PRODUCTS_CREATE",
  "PRODUCTS_UPDATE",
  "PRODUCTS_DELETE",
  "MARKETS_CREATE",
  "MARKETS_UPDATE",
  "MARKETS_DELETE",
  "ORDERS_PAID",
  "ORDERS_FULFILLED",
  "ORDERS_CANCELLED",
  "CUSTOMERS_CREATE",
  "CUSTOMERS_UPDATE",
  "REFUNDS_CREATE",
  "DISCOUNTS_CREATE",
  "DISCOUNTS_UPDATE",
  "DISCOUNTS_DELETE",
  "APP_UNINSTALLED",
];

function tokenHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function offlineSessionRequest({
  accessToken = "shopify-offline-token",
  expectedToken = existingToken,
}: {
  accessToken?: string;
  expectedToken?: string | null;
} = {}) {
  return new Request("https://app.weletic.com/api/internal/shopify/sessions", {
    method: "POST",
    body: JSON.stringify({
      expectedCredentialTokenHash:
        expectedToken === null ? null : tokenHash(expectedToken),
      properties: [
        ["id", `offline_${shop}`],
        ["shop", shop],
        ["state", "oauth-state"],
        ["isOnline", false],
        ["scope", "read_products,write_discounts"],
        ["accessToken", accessToken],
      ],
    }),
  });
}

describe("Shopify offline session tenant binding", () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("SHOPIFY_API_KEY", "session-boundary-test");
    advanceLegacyRevision.mockResolvedValue(undefined);
    sessionUpsert.mockResolvedValue({});
    integrationFindMany.mockResolvedValue([
      {
        id: "installation_1",
        credentials: {
          shop,
          scope: "read_products,write_discounts",
          accessToken: existingToken,
          installationGeneration: "sgen_1",
          shopVerificationTokenHash:
            "30d8b95f5ad03e1419ed89bc3f599d61f15f14f90e08c51a00188182473c1126",
        },
      },
    ]);
    integrationUpdate.mockResolvedValue({});
    storeFindUnique.mockResolvedValue({ id: "store_1" });
    resolveComplianceStore.mockResolvedValue({
      storeId: "store_1",
      workspaceId: "workspace_1",
      canonicalShopDomain: shop,
      storageShopDomain: shop,
      complianceState: "active",
      resolvedFromTombstone: false,
    });
    queryRaw.mockImplementation(async (query: any) => {
      const sql = query?.strings?.join(" ") ?? "";
      return sql.includes("WeleticShopifyShopPrivacyTombstone")
        ? []
        : [
            {
              id: "store_1",
              projectId: "workspace_1",
              shopDomain: shop,
              complianceState: "active",
              installationGeneration: "sgen_1",
            },
          ];
    });
    complianceCount.mockResolvedValue(0);
    shopTombstoneFindFirst.mockResolvedValue(null);
    programCount.mockResolvedValue(0);
    redemptionCount.mockResolvedValue(0);
    outboxCount.mockResolvedValue(0);
    backfillCount.mockResolvedValue(0);
    storeUpdateMany.mockResolvedValue({ count: 1 });
    lockProgram.mockResolvedValue({
      id: "program_1",
      storeId: "store_1",
      status: "active",
      killSwitchActive: true,
    });
    fetchVerifiedShop.mockResolvedValue({
      shopDomain: shop,
      shopCurrency: "JPY",
    });
    ensureWebhooks.mockResolvedValue({
      success: true,
      callbackUrl:
        "https://dev-webhook.weletic.com/api/shopify/integration/webhook",
      registered: canonicalTopics,
      skipped: [],
      failed: [],
    });
    transaction.mockImplementation(async (callback: any) =>
      callback({
        $queryRaw: queryRaw,
        weleticShopifyComplianceRequest: { count: complianceCount },
        weleticShopifyShopPrivacyTombstone: {
          findFirst: shopTombstoneFindFirst,
        },
        weleticShopifyAppSession: { upsert: sessionUpsert },
        weleticShopifyStore: { updateMany: storeUpdateMany },
        weleticLoyaltyProgram: { count: programCount },
        weleticRewardRedemption: { count: redemptionCount },
        weleticLoyaltyOutboxJob: { count: outboxCount },
        weleticLoyaltyBackfillJob: { count: backfillCount },
        installedIntegration: {
          findMany: integrationFindMany,
          update: integrationUpdate,
        },
      }),
    );
  });

  it.each([
    ["accountOwner", "false"],
    ["collaborator", "false"],
    ["userId", 9007199254740992],
    ["associatedUserScope", false],
  ])(
    "rejects malformed online %s before any credential transaction",
    async (key, value) => {
      const { POST } = await import(
        "../../app/api/internal/shopify/sessions/route"
      );
      const response = await POST(
        new Request("http://localhost/api/internal/shopify/sessions", {
          method: "POST",
          body: JSON.stringify({
            properties: [
              ["id", "store.myshopify.com_123"],
              ["shop", "store.myshopify.com"],
              ["state", ""],
              ["isOnline", true],
              [key, value],
            ],
          }),
        }),
      );
      expect(response.status).toBe(400);
      expect(transaction).not.toHaveBeenCalled();
      expect(sessionUpsert).not.toHaveBeenCalled();
      expect(storeFindUnique).not.toHaveBeenCalled();
    },
  );

  it("atomically updates the exact generation-bound installation", async () => {
    const { POST } = await import(
      "../../app/api/internal/shopify/sessions/route"
    );
    const response = await POST(offlineSessionRequest());

    expect(response.status).toBe(200);
    expect(integrationUpdate).toHaveBeenCalledWith({
      where: { id: "installation_1" },
      data: {
        credentials: expect.objectContaining({
          shop,
          scope: "read_products,write_discounts",
          accessToken: "shopify-offline-token",
          installationGeneration: "sgen_1",
          shopVerificationTokenHash: tokenHash("shopify-offline-token"),
        }),
      },
    });
  });

  it("bootstraps the first generation from a fresh Shopify token only behind the drained maintenance fence", async () => {
    const legacyInstallation = {
      id: "installation_1",
      credentials: {
        shop,
        scope: "read_products,write_discounts",
        accessToken: existingToken,
      },
    };
    storeFindUnique.mockResolvedValueOnce({
      id: "store_1",
      projectId: "workspace_1",
      installationGeneration: null,
      complianceState: "active",
    });
    integrationFindMany.mockResolvedValue([legacyInstallation]);
    programCount.mockImplementation(async ({ where }: any) =>
      where.killSwitchActive === true ? 1 : 0,
    );
    queryRaw.mockImplementation(async (query: any) => {
      const sql = query?.strings?.join(" ") ?? "";
      return sql.includes("WeleticShopifyShopPrivacyTombstone")
        ? []
        : [
            {
              id: "store_1",
              projectId: "workspace_1",
              shopDomain: shop,
              complianceState: "active",
              installationGeneration: null,
            },
          ];
    });

    const { POST } = await import(
      "../../app/api/internal/shopify/sessions/route"
    );
    const response = await POST(
      offlineSessionRequest({ accessToken: "fresh-offline-token" }),
    );

    expect(response.status).toBe(200);
    expect(fetchVerifiedShop).toHaveBeenCalledWith({
      shopDomain: shop,
      accessToken: "fresh-offline-token",
    });
    expect(ensureWebhooks).toHaveBeenCalledOnce();
    expect(ensureWebhooks).toHaveBeenCalledWith({
      shopDomain: shop,
      accessToken: "fresh-offline-token",
      allowSdkFallback: false,
    });
    expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      ensureWebhooks.mock.invocationCallOrder[0],
    );
    const publishedGeneration = storeUpdateMany.mock.calls[0][0].data
      .installationGeneration as string;
    expect(publishedGeneration).toMatch(/^sgen_/);
    expect(storeUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "store_1",
          installationGeneration: null,
        }),
        data: expect.objectContaining({
          shopCurrency: "JPY",
          installationGeneration: publishedGeneration,
        }),
      }),
    );
    expect(integrationUpdate).toHaveBeenCalledWith({
      where: { id: "installation_1" },
      data: {
        credentials: expect.objectContaining({
          accessToken: "fresh-offline-token",
          installationGeneration: publishedGeneration,
          shopVerificationTokenHash: tokenHash("fresh-offline-token"),
        }),
      },
    });
  });

  it("rejects legacy generation bootstrap before Shopify I/O when the financial queue is not drained", async () => {
    storeFindUnique.mockResolvedValueOnce({
      id: "store_1",
      projectId: "workspace_1",
      installationGeneration: null,
      complianceState: "active",
    });
    integrationFindMany.mockResolvedValueOnce([
      {
        id: "installation_1",
        credentials: { shop, accessToken: existingToken },
      },
    ]);
    programCount.mockImplementation(async ({ where }: any) =>
      where.killSwitchActive === true ? 1 : 0,
    );
    outboxCount.mockResolvedValueOnce(1);

    const { POST } = await import(
      "../../app/api/internal/shopify/sessions/route"
    );
    const response = await POST(offlineSessionRequest());

    expect(response.status).toBe(409);
    expect(fetchVerifiedShop).not.toHaveBeenCalled();
    expect(ensureWebhooks).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(outboxCount).toHaveBeenCalledWith({
      where: {
        storeId: "store_1",
        status: {
          in: ["pending", "processing", "failed", "dead_letter"],
        },
      },
    });
  });

  it("rejects legacy bootstrap on a pending deletion lifecycle before Shopify I/O", async () => {
    storeFindUnique.mockResolvedValueOnce({
      id: "store_1",
      projectId: "workspace_1",
      complianceState: "active",
      installationGeneration: null,
    });
    complianceCount.mockResolvedValueOnce(1);

    const { POST } = await import(
      "../../app/api/internal/shopify/sessions/route"
    );
    const response = await POST(offlineSessionRequest());

    expect(response.status).toBe(409);
    expect(fetchVerifiedShop).not.toHaveBeenCalled();
    expect(ensureWebhooks).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("serializes legacy bootstrap against a deletion lifecycle that starts after preflight", async () => {
    storeFindUnique.mockResolvedValueOnce({
      id: "store_1",
      projectId: "workspace_1",
      complianceState: "active",
      installationGeneration: null,
    });
    integrationFindMany.mockResolvedValue([
      {
        id: "installation_1",
        credentials: { shop, accessToken: existingToken },
      },
    ]);
    programCount.mockImplementation(async ({ where }: any) =>
      where.killSwitchActive === true ? 1 : 0,
    );
    complianceCount.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    queryRaw.mockImplementation(async (query: any) => {
      const sql = query?.strings?.join(" ") ?? "";
      return sql.includes("WeleticShopifyShopPrivacyTombstone")
        ? []
        : [
            {
              id: "store_1",
              projectId: "workspace_1",
              shopDomain: shop,
              complianceState: "active",
              installationGeneration: null,
            },
          ];
    });

    const { POST } = await import(
      "../../app/api/internal/shopify/sessions/route"
    );
    const response = await POST(offlineSessionRequest());

    expect(response.status).toBe(409);
    expect(queryRaw).toHaveBeenCalled();
    expect(fetchVerifiedShop).not.toHaveBeenCalled();
    expect(ensureWebhooks).not.toHaveBeenCalled();
    expect(storeUpdateMany).not.toHaveBeenCalled();
  });

  it("lets only the first same-generation session refresh publish", async () => {
    let credentials: Record<string, unknown> = {
      shop,
      accessToken: existingToken,
      installationGeneration: "sgen_1",
    };
    integrationFindMany.mockImplementation(async () => [
      { id: "installation_1", credentials },
    ]);
    integrationUpdate.mockImplementation(async ({ data }: any) => {
      credentials = data.credentials;
      return {};
    });
    const { POST } = await import(
      "../../app/api/internal/shopify/sessions/route"
    );
    const expectedOldToken = { expectedToken: existingToken };

    const winner = await POST(
      offlineSessionRequest({
        ...expectedOldToken,
        accessToken: "winning-token",
      }),
    );
    const lateLoser = await POST(
      offlineSessionRequest({
        ...expectedOldToken,
        accessToken: "late-token",
      }),
    );

    expect(winner.status).toBe(200);
    expect(lateLoser.status).toBe(409);
    expect(integrationUpdate).toHaveBeenCalledOnce();
    expect(credentials).toEqual(
      expect.objectContaining({
        accessToken: "winning-token",
        installationGeneration: "sgen_1",
      }),
    );
    expect(sessionUpsert).toHaveBeenCalledOnce();
  });

  it("rejects a stale same-generation session token CAS", async () => {
    const { POST } = await import(
      "../../app/api/internal/shopify/sessions/route"
    );
    const response = await POST(
      offlineSessionRequest({ expectedToken: "stale-token" }),
    );

    expect(response.status).toBe(409);
    expect(sessionUpsert).not.toHaveBeenCalled();
    expect(integrationUpdate).not.toHaveBeenCalled();
  });

  it("rejects ambiguous installation authority instead of picking a row", async () => {
    integrationFindMany.mockResolvedValueOnce([
      { id: "installation_1", credentials: {} },
      { id: "installation_2", credentials: {} },
    ]);

    const { POST } = await import(
      "../../app/api/internal/shopify/sessions/route"
    );
    const response = await POST(offlineSessionRequest());

    expect(response.status).toBe(409);
    expect(sessionUpsert).not.toHaveBeenCalled();
    expect(integrationUpdate).not.toHaveBeenCalled();
  });

  it("rejects a credential whose immutable installation generation is stale", async () => {
    integrationFindMany.mockResolvedValueOnce([
      {
        id: "installation_1",
        credentials: {
          shop,
          accessToken: existingToken,
          installationGeneration: "sgen_old",
        },
      },
    ]);

    const { POST } = await import(
      "../../app/api/internal/shopify/sessions/route"
    );
    const response = await POST(offlineSessionRequest());

    expect(response.status).toBe(409);
    expect(sessionUpsert).not.toHaveBeenCalled();
    expect(integrationUpdate).not.toHaveBeenCalled();
  });

  it("rejects session and credential writes while shop-redact is pending", async () => {
    complianceCount.mockResolvedValueOnce(1);

    const { POST } = await import(
      "../../app/api/internal/shopify/sessions/route"
    );
    const response = await POST(offlineSessionRequest());

    expect(response.status).toBe(409);
    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(sessionUpsert).not.toHaveBeenCalled();
    expect(integrationUpdate).not.toHaveBeenCalled();
  });

  it("rejects raw-domain resurrection after shop redaction", async () => {
    storeFindUnique.mockResolvedValue(null);
    resolveComplianceStore.mockResolvedValue({
      storeId: "store_1",
      workspaceId: "workspace_1",
      canonicalShopDomain: shop,
      storageShopDomain: "redacted-kid-digest.invalid",
      complianceState: "redacted",
      resolvedFromTombstone: true,
    });

    const { POST } = await import(
      "../../app/api/internal/shopify/sessions/route"
    );
    const response = await POST(offlineSessionRequest());

    expect(response.status).toBe(409);
    expect(transaction).not.toHaveBeenCalled();
    expect(sessionUpsert).not.toHaveBeenCalled();
  });

  it("fails closed for frozen session writes until reconnect intent propagation is wired", async () => {
    queryRaw
      .mockResolvedValueOnce([
        { id: "store_1", shopDomain: shop, complianceState: "frozen" },
      ])
      .mockResolvedValueOnce([]);
    complianceCount
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1);

    const { POST } = await import(
      "../../app/api/internal/shopify/sessions/route"
    );
    const response = await POST(offlineSessionRequest());

    expect(response.status).toBe(409);
    expect(sessionUpsert).not.toHaveBeenCalled();
    expect(integrationUpdate).not.toHaveBeenCalled();
  });

  it("rejects a frozen refresh without an uninstall reconnect lifecycle", async () => {
    queryRaw
      .mockResolvedValueOnce([
        { id: "store_1", shopDomain: shop, complianceState: "frozen" },
      ])
      .mockResolvedValueOnce([]);
    complianceCount.mockResolvedValue(0);

    const { POST } = await import(
      "../../app/api/internal/shopify/sessions/route"
    );
    const response = await POST(offlineSessionRequest());

    expect(response.status).toBe(409);
    expect(sessionUpsert).not.toHaveBeenCalled();
    expect(integrationUpdate).not.toHaveBeenCalled();
  });

  it("rechecks shop tombstones inside the credential-write transaction", async () => {
    storeFindUnique.mockResolvedValue(null);
    resolveComplianceStore.mockResolvedValue(null);
    queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "shop_tombstone_1" }]);

    const { POST } = await import(
      "../../app/api/internal/shopify/sessions/route"
    );
    const response = await POST(offlineSessionRequest());

    expect(response.status).toBe(409);
    expect(queryRaw).toHaveBeenCalledTimes(2);
    const firstSql = queryRaw.mock.calls[0]?.[0]?.strings?.join(" ") ?? "";
    const secondSql = queryRaw.mock.calls[1]?.[0]?.strings?.join(" ") ?? "";
    expect(firstSql).toContain("WeleticShopifyStore");
    expect(secondSql).toContain("WeleticShopifyShopPrivacyTombstone");
    expect(sessionUpsert).not.toHaveBeenCalled();
  });

  it("rechecks a store that appears during the no-store write window", async () => {
    storeFindUnique.mockResolvedValue(null);
    resolveComplianceStore.mockResolvedValue(null);
    queryRaw
      .mockResolvedValueOnce([
        {
          id: "store_just_redacted",
          shopDomain: "redacted-kid-digest.invalid",
          complianceState: "redacted",
        },
      ])
      .mockResolvedValueOnce([]);

    const { POST } = await import(
      "../../app/api/internal/shopify/sessions/route"
    );
    const response = await POST(offlineSessionRequest());

    expect(response.status).toBe(409);
    expect(sessionUpsert).not.toHaveBeenCalled();
  });
});
