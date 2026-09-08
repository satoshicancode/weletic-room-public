import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  activateShopifyInstallationGeneration,
  SHOPIFY_INSTALLATION_ACTIVATION_MAINTENANCE_FENCE,
} from "../../scripts/loyalty/activate-shopify-installation-generation";

const mocks = vi.hoisted(() => ({
  storeFindUnique: vi.fn(),
  installationFindMany: vi.fn(),
  installationFindUnique: vi.fn(),
  installationUpdate: vi.fn(),
  programCount: vi.fn(),
  redemptionCount: vi.fn(),
  outboxCount: vi.fn(),
  backfillCount: vi.fn(),
  complianceCount: vi.fn(),
  storeUpdateMany: vi.fn(),
  transaction: vi.fn(),
  queryRaw: vi.fn(),
  lockProgram: vi.fn(),
  fetchVerifiedShop: vi.fn(),
  ensureWebhooks: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/encryption", () => ({
  decryptOrPassthrough: (value: string) => value,
}));

vi.mock("@/lib/prisma", () => {
  const tx = {
    $queryRaw: mocks.queryRaw,
    weleticLoyaltyProgram: { count: mocks.programCount },
    weleticRewardRedemption: { count: mocks.redemptionCount },
    weleticLoyaltyOutboxJob: { count: mocks.outboxCount },
    weleticLoyaltyBackfillJob: { count: mocks.backfillCount },
    weleticShopifyComplianceRequest: { count: mocks.complianceCount },
    weleticShopifyStore: { updateMany: mocks.storeUpdateMany },
    installedIntegration: {
      findUnique: mocks.installationFindUnique,
      update: mocks.installationUpdate,
    },
  };
  return {
    prisma: {
      weleticShopifyStore: { findUnique: mocks.storeFindUnique },
      installedIntegration: { findMany: mocks.installationFindMany },
      weleticLoyaltyProgram: { count: mocks.programCount },
      weleticRewardRedemption: { count: mocks.redemptionCount },
      weleticLoyaltyOutboxJob: { count: mocks.outboxCount },
      weleticLoyaltyBackfillJob: { count: mocks.backfillCount },
      weleticShopifyComplianceRequest: { count: mocks.complianceCount },
      $transaction: mocks.transaction,
    },
  };
});

vi.mock("@/lib/weletic/loyalty/program-write-fence", () => ({
  lockLoyaltyProgramRowIfPresent: mocks.lockProgram,
}));

vi.mock("@/lib/weletic/shopify/store-resolver", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/weletic/shopify/store-resolver")
  >("@/lib/weletic/shopify/store-resolver");
  return {
    ...actual,
    fetchVerifiedShopifyShopDetails: mocks.fetchVerifiedShop,
  };
});

vi.mock("@/lib/weletic/shopify/provision-webhooks", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/weletic/shopify/provision-webhooks")
  >()),
  ensureShopifyWebhooksRegistered: mocks.ensureWebhooks,
}));

const store = {
  id: "wstore_generation",
  projectId: "workspace_generation",
  shopDomain: "generation.myshopify.com",
  shopCurrency: "USD",
  complianceState: "active",
  installationGeneration: null,
};
const credentials = {
  shop: store.shopDomain,
  scope: "read_orders,write_discounts",
  accessToken: "shpat_generation_token",
};
const installation = {
  id: "installation_generation",
  projectId: store.projectId,
  credentials,
};
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

describe("legacy Shopify installation-generation activation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.storeFindUnique.mockResolvedValue({ ...store });
    mocks.installationFindMany.mockResolvedValue([{ ...installation }]);
    mocks.installationFindUnique.mockResolvedValue({ ...installation });
    mocks.programCount.mockImplementation(async ({ where }: any) =>
      where.killSwitchActive === true ? 1 : 0,
    );
    mocks.redemptionCount.mockResolvedValue(0);
    mocks.outboxCount.mockResolvedValue(0);
    mocks.backfillCount.mockResolvedValue(0);
    mocks.complianceCount.mockResolvedValue(0);
    mocks.fetchVerifiedShop.mockResolvedValue({
      shopDomain: store.shopDomain,
      shopCurrency: "JPY",
    });
    mocks.ensureWebhooks.mockResolvedValue({
      success: true,
      callbackUrl:
        "https://dev-webhook.weletic.com/api/shopify/integration/webhook",
      registered: canonicalTopics,
      skipped: [],
      failed: [],
    });
    mocks.queryRaw.mockResolvedValue([
      {
        id: store.id,
        projectId: store.projectId,
        shopDomain: store.shopDomain,
        complianceState: "active",
        installationGeneration: null,
      },
    ]);
    mocks.lockProgram.mockResolvedValue({
      id: "program_generation",
      storeId: store.id,
      status: "active",
      killSwitchActive: true,
    });
    mocks.storeUpdateMany.mockResolvedValue({ count: 1 });
    mocks.installationUpdate.mockResolvedValue({ id: installation.id });
    mocks.transaction.mockImplementation(async (callback) =>
      callback({
        $queryRaw: mocks.queryRaw,
        weleticLoyaltyProgram: { count: mocks.programCount },
        weleticRewardRedemption: { count: mocks.redemptionCount },
        weleticLoyaltyOutboxJob: { count: mocks.outboxCount },
        weleticLoyaltyBackfillJob: { count: mocks.backfillCount },
        weleticShopifyComplianceRequest: { count: mocks.complianceCount },
        weleticShopifyStore: { updateMany: mocks.storeUpdateMany },
        installedIntegration: {
          findUnique: mocks.installationFindUnique,
          update: mocks.installationUpdate,
        },
      }),
    );
  });

  it("dry-runs a live credential and currency check without remote writes", async () => {
    await expect(
      activateShopifyInstallationGeneration({
        storeDomain: " GENERATION.MYSHOPIFY.COM ",
      }),
    ).resolves.toMatchObject({
      dryRun: true,
      alreadyActive: false,
      readyToApply: true,
      verifiedCurrency: "JPY",
      maintenanceFence: {
        writeEnabledPrograms: 0,
        fencedActivePrograms: 1,
        provisioningRedemptions: 0,
        blockingOutboxJobs: 0,
        committingBackfills: 0,
        blockingLifecycleRequests: 0,
      },
    });
    expect(mocks.fetchVerifiedShop).toHaveBeenCalledWith({
      shopDomain: store.shopDomain,
      accessToken: credentials.accessToken,
    });
    expect(mocks.ensureWebhooks).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("fails closed before Shopify writes when the maintenance fence is not drained", async () => {
    mocks.outboxCount.mockResolvedValueOnce(1);

    await expect(
      activateShopifyInstallationGeneration({
        storeDomain: store.shopDomain,
        apply: true,
        maintenanceFence: SHOPIFY_INSTALLATION_ACTIVATION_MAINTENANCE_FENCE,
      }),
    ).rejects.toThrow("blockingOutboxJobs=1");
    expect(mocks.fetchVerifiedShop).not.toHaveBeenCalled();
    expect(mocks.ensureWebhooks).not.toHaveBeenCalled();
    expect(mocks.outboxCount).toHaveBeenCalledWith({
      where: {
        storeId: store.id,
        status: {
          in: ["pending", "processing", "failed", "dead_letter"],
        },
      },
    });
  });

  it("does not report readiness without exactly one active kill-switched program", async () => {
    mocks.programCount.mockResolvedValue(0);

    await expect(
      activateShopifyInstallationGeneration({ storeDomain: store.shopDomain }),
    ).resolves.toMatchObject({
      dryRun: true,
      readyToApply: false,
      maintenanceFence: { fencedActivePrograms: 0 },
    });
  });

  it("rejects a pending deletion lifecycle before remote Shopify writes", async () => {
    mocks.complianceCount.mockResolvedValueOnce(1);

    await expect(
      activateShopifyInstallationGeneration({
        storeDomain: store.shopDomain,
        apply: true,
        maintenanceFence: SHOPIFY_INSTALLATION_ACTIVATION_MAINTENANCE_FENCE,
      }),
    ).rejects.toThrow("blockingLifecycleRequests=1");
    expect(mocks.fetchVerifiedShop).not.toHaveBeenCalled();
    expect(mocks.ensureWebhooks).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("publishes one generation only after live verification, webhook provisioning, and locked rechecks", async () => {
    const result = await activateShopifyInstallationGeneration({
      storeDomain: store.shopDomain,
      apply: true,
      maintenanceFence: SHOPIFY_INSTALLATION_ACTIVATION_MAINTENANCE_FENCE,
    });

    expect(result).toMatchObject({
      dryRun: false,
      alreadyActive: false,
      verifiedCurrency: "JPY",
      webhookTopics: canonicalTopics.length,
    });
    expect(result.installationGeneration).toMatch(/^sgen_/);
    expect(mocks.ensureWebhooks).toHaveBeenCalledOnce();
    expect(mocks.queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.ensureWebhooks.mock.invocationCallOrder[0],
    );
    expect(mocks.storeUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: store.id,
          installationGeneration: null,
        }),
        data: expect.objectContaining({
          shopCurrency: "JPY",
          installationGeneration: result.installationGeneration,
        }),
      }),
    );
    expect(mocks.installationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: installation.id },
        data: {
          credentials: expect.objectContaining({
            accessToken: credentials.accessToken,
            installationGeneration: result.installationGeneration,
            shopVerificationTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          }),
        },
      }),
    );
  });

  it("does not publish local authority when mandatory webhooks are incomplete", async () => {
    mocks.ensureWebhooks.mockResolvedValueOnce({
      success: true,
      callbackUrl:
        "https://dev-webhook.weletic.com/api/shopify/integration/webhook",
      registered: canonicalTopics.slice(0, -1),
      skipped: [],
      failed: [],
    });

    await expect(
      activateShopifyInstallationGeneration({
        storeDomain: store.shopDomain,
        apply: true,
        maintenanceFence: SHOPIFY_INSTALLATION_ACTIVATION_MAINTENANCE_FENCE,
      }),
    ).rejects.toThrow("APP_UNINSTALLED");
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.storeUpdateMany).not.toHaveBeenCalled();
    expect(mocks.installationUpdate).not.toHaveBeenCalled();
  });
});
