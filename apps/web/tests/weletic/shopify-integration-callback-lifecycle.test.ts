import { prisma } from "@/lib/prisma";
import { syncWeleticShopifyCatalog } from "@/lib/weletic/shopify/catalog-sync";
import { persistAndQueueInternalShopifyDisconnect } from "@/lib/weletic/shopify/compliance-ingress";
import { resolveComplianceShopifyStoreByDomain } from "@/lib/weletic/shopify/compliance-store-resolver";
import { inspectShopifyConnectLifecycle } from "@/lib/weletic/shopify/integration-lifecycle";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PATCH } from "../../app/(ee)/api/shopify/integration/callback/route";

const mocks = vi.hoisted(() => ({
  storeFindUnique: vi.fn(),
  storeFindFirst: vi.fn(),
  shopTombstoneFindMany: vi.fn(),
  shopTombstoneFindFirst: vi.fn(),
  complianceCount: vi.fn(),
  complianceFindMany: vi.fn(),
  cleanupCount: vi.fn(),
  installationFindFirst: vi.fn(),
  installationFindMany: vi.fn(),
  installationFindUnique: vi.fn(),
  installationUpdate: vi.fn(),
  installationUpdateMany: vi.fn(),
  installationDeleteMany: vi.fn(),
  projectUpdate: vi.fn(),
  storeCreate: vi.fn(),
  storeUpdate: vi.fn(),
  storeUpdateMany: vi.fn(),
  programUpdateMany: vi.fn(),
  transaction: vi.fn(),
  persistDisconnect: vi.fn(),
  installIntegration: vi.fn(),
  notifyIntegration: vi.fn(),
  ensureWebhooks: vi.fn(),
  syncCatalog: vi.fn(),
  fetchVerifiedShop: vi.fn(),
  invalidateCache: vi.fn(),
  queryRaw: vi.fn(),
  publishPolicyRevision: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/auth", () => ({
  withWorkspace: (handler: unknown) => handler,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticShopifyStore: {
      create: mocks.storeCreate,
      findUnique: mocks.storeFindUnique,
      findFirst: mocks.storeFindFirst,
      update: mocks.storeUpdate,
      updateMany: mocks.storeUpdateMany,
    },
    weleticShopifyComplianceRequest: {
      count: mocks.complianceCount,
      findMany: mocks.complianceFindMany,
    },
    weleticShopifyVoucherCleanup: { count: mocks.cleanupCount },
    weleticShopifyShopPrivacyTombstone: {
      findMany: mocks.shopTombstoneFindMany,
      findFirst: mocks.shopTombstoneFindFirst,
    },
    installedIntegration: {
      findFirst: mocks.installationFindFirst,
      findMany: mocks.installationFindMany,
      findUnique: mocks.installationFindUnique,
      update: mocks.installationUpdate,
      updateMany: mocks.installationUpdateMany,
      deleteMany: mocks.installationDeleteMany,
    },
    project: { update: mocks.projectUpdate },
    weleticLoyaltyProgram: { updateMany: mocks.programUpdateMany },
    $transaction: mocks.transaction,
  },
}));

vi.mock("@/lib/weletic/shopify/compliance-ingress", () => ({
  persistAndQueueInternalShopifyDisconnect: mocks.persistDisconnect,
}));
vi.mock("@/lib/weletic/loyalty/earn-policy-revision", () => ({
  publishLoyaltyEarnPolicyRevision: mocks.publishPolicyRevision,
}));

vi.mock("@/lib/integrations/install", () => ({
  installIntegration: mocks.installIntegration,
  notifyIntegrationInstalled: mocks.notifyIntegration,
}));

vi.mock("@/lib/weletic/shopify/privacy-identity", () => ({
  deriveAllShopifyShopPrivacyIdentities: vi.fn(() => [
    { identityKeyId: "kid_1", shopDomainDigest: "SAFE_SHOP_DIGEST" },
  ]),
}));

vi.mock("@/lib/weletic/shopify/store-resolver", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/weletic/shopify/store-resolver")
  >("@/lib/weletic/shopify/store-resolver");
  return {
    ...actual,
    fetchVerifiedShopifyShopDetails: mocks.fetchVerifiedShop,
    invalidateShopifyStoreDomainCache: mocks.invalidateCache,
  };
});

vi.mock("@/lib/weletic/shopify/provision-webhooks", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/weletic/shopify/provision-webhooks")
  >()),
  ensureShopifyWebhooksRegistered: mocks.ensureWebhooks,
}));

vi.mock("@/lib/weletic/shopify/catalog-sync", () => ({
  syncWeleticShopifyCatalog: mocks.syncCatalog,
}));

vi.mock("@/lib/cron", () => ({
  qstash: { publishJSON: vi.fn() },
}));

function callbackTransactionClient() {
  return {
    $queryRaw: mocks.queryRaw,
    project: { update: mocks.projectUpdate },
    weleticShopifyStore: {
      create: mocks.storeCreate,
      findFirst: mocks.storeFindFirst,
      update: mocks.storeUpdate,
      updateMany: mocks.storeUpdateMany,
    },
    weleticLoyaltyProgram: { updateMany: mocks.programUpdateMany },
    weleticShopifyComplianceRequest: {
      findMany: mocks.complianceFindMany,
      count: mocks.complianceCount,
    },
    weleticShopifyVoucherCleanup: { count: mocks.cleanupCount },
    weleticShopifyShopPrivacyTombstone: {
      findFirst: mocks.shopTombstoneFindFirst,
    },
    installedIntegration: {
      findMany: mocks.installationFindMany,
      update: mocks.installationUpdate,
    },
  };
}

describe("Shopify integration lifecycle boundary", () => {
  beforeEach(() => {
    vi.stubEnv(
      "ENCRYPTION_KEY",
      "shopify-integration-callback-lifecycle-test-only-key",
    );
    vi.clearAllMocks();
    mocks.complianceCount.mockResolvedValue(0);
    mocks.cleanupCount.mockResolvedValue(0);
    mocks.storeFindFirst.mockResolvedValue(null);
    mocks.shopTombstoneFindMany.mockResolvedValue([]);
    mocks.shopTombstoneFindFirst.mockResolvedValue(null);
    mocks.complianceFindMany.mockResolvedValue([]);
    mocks.persistDisconnect.mockResolvedValue({
      requestId: "wcomp_disconnect",
      status: "pending",
    });
    mocks.installationFindMany.mockResolvedValue([]);
    mocks.installationFindUnique.mockResolvedValue(null);
    mocks.installationUpdate.mockResolvedValue({});
    mocks.installationUpdateMany.mockResolvedValue({ count: 1 });
    mocks.installationDeleteMany.mockResolvedValue({ count: 1 });
    mocks.programUpdateMany.mockResolvedValue({ count: 1 });
    mocks.publishPolicyRevision.mockResolvedValue({ id: "wpolicy_disabled" });
    mocks.storeCreate.mockResolvedValue({ id: "wstore_callback" });
    mocks.syncCatalog.mockResolvedValue(undefined);
    mocks.fetchVerifiedShop.mockResolvedValue({
      shopDomain: "same.myshopify.com",
      shopCurrency: "JPY",
    });
    mocks.installIntegration.mockResolvedValue({
      id: "installation_new",
      updatedAt: new Date("2026-08-30T02:00:00.000Z"),
    });
    mocks.ensureWebhooks.mockResolvedValue({
      success: true,
      callbackUrl: "https://room.test/api/shopify/integration/webhook",
      registered: [
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
      ],
      skipped: [],
      failed: [],
    });
    mocks.queryRaw.mockImplementation(async (query: any) => {
      const sql = query?.strings?.join(" ") ?? "";
      if (sql.includes("WeleticShopifyShopPrivacyTombstone")) return [];
      if (sql.includes("WeleticLoyaltyProgram")) {
        const storeId = query?.values?.[0] ?? "wstore_frozen";
        return [
          {
            id: `program_${storeId}`,
            storeId,
            status: "active",
            killSwitchActive: false,
          },
        ];
      }
      return [
        {
          id: "wstore_frozen",
          projectId: "workspace_1",
          shopDomain: "same.myshopify.com",
          complianceState: "frozen",
          uninstalledAt: new Date("2026-08-30T00:00:00.000Z"),
          installationGeneration: "sgen_existing",
        },
      ];
    });
    mocks.transaction.mockImplementation(async (callback: any) =>
      callback(callbackTransactionClient()),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fails closed when connect attempts to rebind retained store history", async () => {
    mocks.storeFindUnique.mockResolvedValue({
      id: "wstore_retained",
      shopDomain: "original.myshopify.com",
      complianceState: "active",
    });

    await expect(
      inspectShopifyConnectLifecycle({
        workspaceId: "workspace_1",
        canonicalShopDomain: "different.myshopify.com",
      }),
    ).rejects.toThrow("different Shopify store");
  });

  it("never reactivates a redacted store", async () => {
    mocks.storeFindUnique.mockResolvedValue({
      id: "wstore_redacted",
      shopDomain: "same.myshopify.com",
      complianceState: "redacted",
    });

    await expect(
      inspectShopifyConnectLifecycle({
        workspaceId: "workspace_1",
        canonicalShopDomain: "same.myshopify.com",
      }),
    ).rejects.toThrow("cannot be reactivated");
  });

  it("rejects a recycled raw domain retained by a different redacted store", async () => {
    mocks.storeFindUnique.mockResolvedValue(null);
    mocks.shopTombstoneFindMany.mockResolvedValueOnce([
      { storeId: "wstore_redacted_other_workspace" },
    ]);

    await expect(
      inspectShopifyConnectLifecycle({
        workspaceId: "workspace_1",
        canonicalShopDomain: "same.myshopify.com",
      }),
    ).rejects.toThrow("retained by a redacted privacy lifecycle");
  });

  it("accepts fresh same-domain credentials but keeps unresolved cleanup frozen", async () => {
    mocks.storeFindUnique.mockResolvedValue({
      id: "wstore_frozen",
      shopDomain: "same.myshopify.com",
      complianceState: "frozen",
      installationGeneration: "sgen_existing",
    });
    mocks.complianceCount
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);
    mocks.cleanupCount.mockResolvedValue(1);

    await expect(
      inspectShopifyConnectLifecycle({
        workspaceId: "workspace_1",
        canonicalShopDomain: "same.myshopify.com",
      }),
    ).resolves.toEqual({
      mode: "frozen_refresh",
      storeId: "wstore_frozen",
      observedInstallationGeneration: "sgen_existing",
    });
  });

  it("reactivates only after completed uninstall and zero unresolved cleanup", async () => {
    mocks.storeFindUnique.mockResolvedValue({
      id: "wstore_frozen",
      shopDomain: "same.myshopify.com",
      complianceState: "frozen",
      installationGeneration: "sgen_existing",
    });
    mocks.complianceCount
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1);
    mocks.cleanupCount.mockResolvedValue(0);

    await expect(
      inspectShopifyConnectLifecycle({
        workspaceId: "workspace_1",
        canonicalShopDomain: "same.myshopify.com",
      }),
    ).resolves.toEqual({
      mode: "reactivate",
      storeId: "wstore_frozen",
      observedInstallationGeneration: "sgen_existing",
    });
  });

  it("fails closed instead of claiming an active store is frozen when durable erasure is pending", async () => {
    mocks.storeFindUnique.mockResolvedValue({
      id: "wstore_active",
      shopDomain: "same.myshopify.com",
      complianceState: "active",
    });
    mocks.complianceCount.mockResolvedValue(1);

    await expect(
      inspectShopifyConnectLifecycle({
        workspaceId: "workspace_1",
        canonicalShopDomain: "same.myshopify.com",
      }),
    ).rejects.toThrow("blocked while an uninstall or shop-redact request");
  });

  it("rejects connect before verification or provisioning when no default program exists", async () => {
    await expect(
      (PATCH as any)({
        req: new Request("https://room.test/api/shopify/integration/callback", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "connect",
            shopifyStoreId: "same.myshopify.com",
            accessToken: "fresh-token",
            scope: "write_discounts",
          }),
        }),
        workspace: {
          id: "workspace_1",
          shopifyStoreId: null,
          defaultProgramId: null,
        },
        session: { user: { id: "user_1" } },
      }),
    ).rejects.toThrow("Create a default program");

    expect(mocks.fetchVerifiedShop).not.toHaveBeenCalled();
    expect(mocks.ensureWebhooks).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.storeCreate).not.toHaveBeenCalled();
    expect(mocks.projectUpdate).not.toHaveBeenCalled();
    expect(mocks.installIntegration).not.toHaveBeenCalled();
    expect(mocks.syncCatalog).not.toHaveBeenCalled();
  });

  it("atomically creates a compliance-resolvable store before a failing first catalog sync", async () => {
    mocks.storeFindUnique.mockResolvedValue(null);
    mocks.queryRaw.mockResolvedValue([]);
    mocks.projectUpdate.mockResolvedValue({
      shopifyStoreId: "same.myshopify.com",
    });
    mocks.syncCatalog.mockRejectedValueOnce(new Error("catalog unavailable"));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      const response = await (PATCH as any)({
        req: new Request("https://room.test/api/shopify/integration/callback", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "connect",
            shopifyStoreId: "same.myshopify.com",
            accessToken: "fresh-token",
            scope: "write_discounts",
          }),
        }),
        workspace: {
          id: "workspace_1",
          shopifyStoreId: null,
          defaultProgramId: "program_1",
        },
        session: { user: { id: "user_1" } },
      });

      await expect(response.json()).resolves.toEqual({
        shopifyStoreId: "same.myshopify.com",
      });
      expect(mocks.storeCreate).toHaveBeenCalledWith({
        data: {
          id: expect.stringMatching(/^wstore_/),
          projectId: "workspace_1",
          programId: "program_1",
          shopDomain: "same.myshopify.com",
          shopCurrency: "JPY",
          currencyVerifiedAt: expect.any(Date),
          installationGeneration: expect.stringMatching(/^sgen_/),
          apiVersion: "2026-07",
          syncStatus: "pending",
          complianceState: "active",
        },
      });
      expect(mocks.installIntegration).toHaveBeenCalledWith(
        expect.objectContaining({ tx: expect.any(Object) }),
      );
      expect(
        mocks.installIntegration.mock.calls[0]?.[0]?.credentials
          ?.installationGeneration,
      ).toBe(
        mocks.storeCreate.mock.calls[0]?.[0]?.data?.installationGeneration,
      );
      expect(syncWeleticShopifyCatalog).toHaveBeenCalledWith({
        workspaceId: "workspace_1",
      });

      const persistedStore = {
        id: "wstore_callback",
        projectId: "workspace_1",
        programId: "program_1",
        shopDomain: "same.myshopify.com",
        complianceState: "active" as const,
      };
      mocks.storeFindUnique.mockResolvedValue(persistedStore);
      const immediateComplianceResolutions = Object.fromEntries(
        await Promise.all(
          ["app/uninstalled", "shop/redact"].map(async (topic) => [
            topic,
            await resolveComplianceShopifyStoreByDomain("same.myshopify.com"),
          ]),
        ),
      );
      expect(immediateComplianceResolutions).toEqual({
        "app/uninstalled": expect.objectContaining({
          storeId: "wstore_callback",
          workspaceId: "workspace_1",
          programId: "program_1",
          complianceState: "active",
          resolvedFromTombstone: false,
        }),
        "shop/redact": expect.objectContaining({
          storeId: "wstore_callback",
          workspaceId: "workspace_1",
          programId: "program_1",
          complianceState: "active",
          resolvedFromTombstone: false,
        }),
      });
    } finally {
      consoleError.mockRestore();
    }
  });

  it("fails before activation when authoritative Shopify currency cannot be verified", async () => {
    mocks.fetchVerifiedShop.mockResolvedValueOnce(null);

    await expect(
      (PATCH as any)({
        req: new Request("https://room.test/api/shopify/integration/callback", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "connect",
            shopifyStoreId: "same.myshopify.com",
            accessToken: "fresh-token",
            scope: "write_discounts",
          }),
        }),
        workspace: {
          id: "workspace_1",
          shopifyStoreId: null,
          defaultProgramId: "program_1",
        },
        session: { user: { id: "user_1" } },
      }),
    ).rejects.toThrow("authoritative shop currency could not be verified");

    expect(mocks.ensureWebhooks).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.storeCreate).not.toHaveBeenCalled();
  });

  it("maps a concurrent authoritative-store bind to a conflict before alias or credential writes", async () => {
    mocks.storeFindUnique.mockResolvedValue(null);
    mocks.queryRaw.mockResolvedValue([]);
    mocks.storeCreate.mockRejectedValueOnce(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );

    await expect(
      (PATCH as any)({
        req: new Request("https://room.test/api/shopify/integration/callback", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "connect",
            shopifyStoreId: "same.myshopify.com",
            accessToken: "fresh-token",
            scope: "write_discounts",
          }),
        }),
        workspace: {
          id: "workspace_1",
          shopifyStoreId: null,
          defaultProgramId: "program_1",
        },
        session: { user: { id: "user_1" } },
      }),
    ).rejects.toThrow('store "same.myshopify.com" is already in use');

    expect(mocks.projectUpdate).not.toHaveBeenCalled();
    expect(mocks.installIntegration).not.toHaveBeenCalled();
    expect(mocks.notifyIntegration).not.toHaveBeenCalled();
  });

  it("reactivates store operations without silently re-enabling loyalty", async () => {
    mocks.storeFindUnique.mockResolvedValue({
      id: "wstore_frozen",
      shopDomain: "same.myshopify.com",
      complianceState: "frozen",
      installationGeneration: "sgen_existing",
    });
    mocks.complianceCount
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1);
    mocks.cleanupCount.mockResolvedValue(0);
    mocks.projectUpdate.mockResolvedValue({
      shopifyStoreId: "same.myshopify.com",
    });
    mocks.storeUpdateMany.mockResolvedValue({ count: 1 });
    mocks.transaction.mockImplementation(async (callback: any) =>
      callback(callbackTransactionClient()),
    );

    const response = await (PATCH as any)({
      req: new Request("https://room.test/api/shopify/integration/callback", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "connect",
          shopifyStoreId: "same.myshopify.com",
          accessToken: "fresh-token",
          scope: "write_discounts",
        }),
      }),
      workspace: {
        id: "workspace_1",
        shopifyStoreId: null,
        defaultProgramId: "program_1",
      },
      session: { user: { id: "user_1" } },
    });

    await expect(response.json()).resolves.toEqual({
      shopifyStoreId: "same.myshopify.com",
    });
    expect(mocks.storeUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ complianceState: "active" }),
      }),
    );
    const reactivatedGeneration =
      mocks.storeUpdateMany.mock.calls[0]?.[0]?.data?.installationGeneration;
    expect(reactivatedGeneration).toMatch(/^sgen_/);
    expect(reactivatedGeneration).not.toBe("sgen_existing");
    expect(
      mocks.installIntegration.mock.calls[0]?.[0]?.credentials
        ?.installationGeneration,
    ).toBe(reactivatedGeneration);
    expect(mocks.programUpdateMany).not.toHaveBeenCalled();
    expect(mocks.ensureWebhooks).toHaveBeenCalledOnce();
  });

  it("waits for an in-flight voucher generation before publishing a new currency", async () => {
    mocks.storeFindUnique.mockResolvedValue({
      id: "wstore_active",
      shopDomain: "same.myshopify.com",
      complianceState: "active",
      installationGeneration: "sgen_existing",
    });
    mocks.projectUpdate.mockResolvedValue({
      shopifyStoreId: "same.myshopify.com",
    });
    mocks.storeUpdateMany.mockResolvedValue({ count: 1 });

    let releaseProgramLock!: () => void;
    const programLockReleased = new Promise<void>((resolve) => {
      releaseProgramLock = resolve;
    });
    let signalProgramLockReached!: () => void;
    const programLockReached = new Promise<void>((resolve) => {
      signalProgramLockReached = resolve;
    });
    mocks.queryRaw.mockImplementation(async (query: any) => {
      const sql = query?.strings?.join(" ") ?? "";
      if (sql.includes("WeleticShopifyShopPrivacyTombstone")) return [];
      if (sql.includes("WeleticLoyaltyProgram")) {
        signalProgramLockReached();
        await programLockReleased;
        return [
          {
            id: "program_active",
            storeId: "wstore_active",
            status: "active",
            killSwitchActive: false,
          },
        ];
      }
      return [
        {
          id: "wstore_active",
          projectId: "workspace_1",
          shopDomain: "same.myshopify.com",
          complianceState: "active",
          uninstalledAt: null,
          installationGeneration: "sgen_existing",
        },
      ];
    });

    const callback = (PATCH as any)({
      req: new Request("https://room.test/api/shopify/integration/callback", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "connect",
          shopifyStoreId: "same.myshopify.com",
          accessToken: "fresh-token",
          scope: "write_discounts",
        }),
      }),
      workspace: {
        id: "workspace_1",
        shopifyStoreId: "same.myshopify.com",
        defaultProgramId: "program_1",
      },
      session: { user: { id: "user_1" } },
    });

    await programLockReached;
    expect(mocks.storeUpdateMany).not.toHaveBeenCalled();

    releaseProgramLock();
    const response = await callback;
    await expect(response.json()).resolves.toEqual({
      shopifyStoreId: "same.myshopify.com",
    });
    expect(mocks.storeUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          shopCurrency: "JPY",
          currencyVerifiedAt: expect.any(Date),
          installationGeneration: expect.stringMatching(/^sgen_/),
        }),
      }),
    );
    const refreshedGeneration =
      mocks.storeUpdateMany.mock.calls.at(-1)?.[0]?.data
        ?.installationGeneration;
    expect(refreshedGeneration).not.toBe("sgen_existing");
    expect(
      mocks.installIntegration.mock.calls.at(-1)?.[0]?.credentials
        ?.installationGeneration,
    ).toBe(refreshedGeneration);
  });

  it("rejects a slower active connect after a newer callback rotates the observed generation", async () => {
    let currentGeneration = "sgen_existing";
    let currentCurrency = "USD";
    mocks.storeFindUnique.mockImplementation(async () => ({
      id: "wstore_active",
      projectId: "workspace_1",
      shopDomain: "same.myshopify.com",
      complianceState: "active",
      installationGeneration: currentGeneration,
    }));
    mocks.projectUpdate.mockResolvedValue({
      shopifyStoreId: "same.myshopify.com",
    });
    mocks.queryRaw.mockImplementation(async (query: any) => {
      const sql = query?.strings?.join(" ") ?? "";
      if (sql.includes("WeleticShopifyShopPrivacyTombstone")) return [];
      if (sql.includes("WeleticLoyaltyProgram")) {
        return [
          {
            id: "program_active",
            storeId: "wstore_active",
            status: "active",
            killSwitchActive: false,
          },
        ];
      }
      return [
        {
          id: "wstore_active",
          projectId: "workspace_1",
          shopDomain: "same.myshopify.com",
          complianceState: "active",
          uninstalledAt: null,
          installationGeneration: currentGeneration,
        },
      ];
    });
    mocks.storeUpdateMany.mockImplementation(async ({ where, data }: any) => {
      if (where.installationGeneration !== currentGeneration) {
        return { count: 0 };
      }
      currentGeneration = data.installationGeneration;
      currentCurrency = data.shopCurrency;
      return { count: 1 };
    });

    let signalSlowVerificationStarted!: () => void;
    const slowVerificationStarted = new Promise<void>((resolve) => {
      signalSlowVerificationStarted = resolve;
    });
    let releaseSlowVerification!: () => void;
    const slowVerificationRelease = new Promise<void>((resolve) => {
      releaseSlowVerification = resolve;
    });
    mocks.fetchVerifiedShop
      .mockImplementationOnce(async () => {
        signalSlowVerificationStarted();
        await slowVerificationRelease;
        return {
          shopDomain: "same.myshopify.com",
          shopCurrency: "USD",
        };
      })
      .mockResolvedValueOnce({
        shopDomain: "same.myshopify.com",
        shopCurrency: "JPY",
      });

    const connect = (accessToken: string) =>
      (PATCH as any)({
        req: new Request("https://room.test/api/shopify/integration/callback", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "connect",
            shopifyStoreId: "same.myshopify.com",
            accessToken,
            scope: "write_discounts",
          }),
        }),
        workspace: {
          id: "workspace_1",
          shopifyStoreId: "same.myshopify.com",
          defaultProgramId: "program_1",
        },
        session: { user: { id: "user_1" } },
      });

    const slowConnection = connect("slow-old-token");
    await slowVerificationStarted;
    const winningResponse = await connect("newer-token");
    await expect(winningResponse.json()).resolves.toEqual({
      shopifyStoreId: "same.myshopify.com",
    });
    const winningGeneration = currentGeneration;

    releaseSlowVerification();
    await expect(slowConnection).rejects.toThrow(
      "A newer Shopify connection completed",
    );

    expect(currentGeneration).toBe(winningGeneration);
    expect(currentGeneration).not.toBe("sgen_existing");
    expect(currentCurrency).toBe("JPY");
    expect(mocks.storeUpdateMany).toHaveBeenCalledOnce();
    expect(mocks.installIntegration).toHaveBeenCalledOnce();
    expect(mocks.invalidateCache).toHaveBeenCalledWith([
      "same.myshopify.com",
      "same.myshopify.com",
    ]);
  });

  it("lets only the first same-generation frozen credential refresh publish", async () => {
    const retainedGeneration = "sgen_existing";
    let currentCredentials: Record<string, unknown> = {
      shop: "same.myshopify.com",
      accessToken: "old-token",
      scope: "write_discounts",
      installationGeneration: retainedGeneration,
    };
    mocks.storeFindUnique.mockResolvedValue({
      id: "wstore_frozen",
      shopDomain: "same.myshopify.com",
      complianceState: "frozen",
      installationGeneration: retainedGeneration,
    });
    mocks.cleanupCount.mockResolvedValue(1);
    mocks.installationFindMany.mockImplementation(async () => [
      {
        id: "installation_existing",
        userId: "user_1",
        credentials: currentCredentials,
      },
    ]);
    mocks.installIntegration.mockImplementation(async ({ credentials }) => {
      currentCredentials = credentials;
      return { id: "installation_existing" };
    });

    let signalSlowVerificationStarted!: () => void;
    const slowVerificationStarted = new Promise<void>((resolve) => {
      signalSlowVerificationStarted = resolve;
    });
    let releaseSlowVerification!: () => void;
    const slowVerificationRelease = new Promise<void>((resolve) => {
      releaseSlowVerification = resolve;
    });
    mocks.fetchVerifiedShop
      .mockImplementationOnce(async () => {
        signalSlowVerificationStarted();
        await slowVerificationRelease;
        return {
          shopDomain: "same.myshopify.com",
          shopCurrency: "JPY",
        };
      })
      .mockResolvedValueOnce({
        shopDomain: "same.myshopify.com",
        shopCurrency: "JPY",
      });

    const connect = (accessToken: string) =>
      (PATCH as any)({
        req: new Request("https://room.test/api/shopify/integration/callback", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "connect",
            shopifyStoreId: "same.myshopify.com",
            accessToken,
            scope: "write_discounts",
          }),
        }),
        workspace: {
          id: "workspace_1",
          shopifyStoreId: "same.myshopify.com",
          defaultProgramId: "program_1",
        },
        session: { user: { id: "user_1" } },
      });

    const slowRefresh = connect("late-token");
    await slowVerificationStarted;
    const winner = await connect("winning-token");
    await expect(winner.json()).resolves.toMatchObject({
      complianceState: "frozen",
      reactivationPending: true,
    });

    releaseSlowVerification();
    await expect(slowRefresh).rejects.toThrow(
      "A newer Shopify credential completed",
    );
    expect(mocks.installIntegration).toHaveBeenCalledOnce();
    expect(currentCredentials.installationGeneration).toBe(retainedGeneration);
  });

  it("provisions mandatory webhooks while fresh credentials remain frozen", async () => {
    mocks.storeFindUnique.mockResolvedValue({
      id: "wstore_frozen",
      shopDomain: "same.myshopify.com",
      complianceState: "frozen",
      installationGeneration: "sgen_existing",
    });
    mocks.complianceCount
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);
    mocks.cleanupCount.mockResolvedValue(1);

    const response = await (PATCH as any)({
      req: new Request("https://room.test/api/shopify/integration/callback", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "connect",
          shopifyStoreId: "same.myshopify.com",
          accessToken: "fresh-token",
          scope: "write_discounts",
        }),
      }),
      workspace: {
        id: "workspace_1",
        shopifyStoreId: null,
        defaultProgramId: "program_1",
      },
      session: { user: { id: "user_1" } },
    });

    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        complianceState: "frozen",
        reactivationPending: true,
      }),
    );
    expect(mocks.ensureWebhooks).toHaveBeenCalledOnce();
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.installIntegration).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: expect.objectContaining({
          installationGeneration: "sgen_existing",
        }),
        tx: expect.any(Object),
      }),
    );
  });

  it("fails closed when mandatory webhook provisioning fails", async () => {
    mocks.storeFindUnique.mockResolvedValue({
      id: "wstore_frozen",
      shopDomain: "same.myshopify.com",
      complianceState: "frozen",
      installationGeneration: "sgen_existing",
    });
    mocks.complianceCount
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);
    mocks.cleanupCount.mockResolvedValue(1);
    mocks.ensureWebhooks.mockResolvedValueOnce({
      success: false,
      callbackUrl: "https://room.test/api/shopify/integration/webhook",
      registered: ["APP_UNINSTALLED"],
      skipped: [],
      failed: [{ topic: "ORDERS_PAID", error: "missing scope" }],
    });

    await expect(
      (PATCH as any)({
        req: new Request("https://room.test/api/shopify/integration/callback", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "connect",
            shopifyStoreId: "same.myshopify.com",
            accessToken: "fresh-token",
            scope: "write_discounts",
          }),
        }),
        workspace: {
          id: "workspace_1",
          shopifyStoreId: null,
          defaultProgramId: "program_1",
        },
        session: { user: { id: "user_1" } },
      }),
    ).rejects.toThrow("Shopify webhook provisioning failed");
    expect(mocks.installIntegration).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects an incomplete provisioning result even when its success flag is true", async () => {
    mocks.storeFindUnique.mockResolvedValue({
      id: "wstore_frozen",
      shopDomain: "same.myshopify.com",
      complianceState: "frozen",
      installationGeneration: "sgen_existing",
    });
    mocks.complianceCount
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);
    mocks.cleanupCount.mockResolvedValue(1);
    mocks.ensureWebhooks.mockResolvedValueOnce({
      success: true,
      callbackUrl: "https://room.test/api/shopify/integration/webhook",
      registered: ["APP_UNINSTALLED"],
      skipped: [],
      failed: [],
    });

    await expect(
      (PATCH as any)({
        req: new Request("https://room.test/api/shopify/integration/callback", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "connect",
            shopifyStoreId: "same.myshopify.com",
            accessToken: "fresh-token",
            scope: "write_discounts",
          }),
        }),
        workspace: {
          id: "workspace_1",
          shopifyStoreId: null,
          defaultProgramId: "program_1",
        },
        session: { user: { id: "user_1" } },
      }),
    ).rejects.toThrow("Shopify webhook provisioning failed");
    expect(mocks.installIntegration).not.toHaveBeenCalled();
  });

  it("fails closed if shop-redact is persisted during an active credential refresh", async () => {
    mocks.storeFindUnique.mockResolvedValue({
      id: "wstore_active",
      shopDomain: "same.myshopify.com",
      complianceState: "active",
      installationGeneration: "sgen_existing",
    });
    mocks.complianceCount.mockResolvedValueOnce(0);
    mocks.projectUpdate.mockResolvedValue({
      shopifyStoreId: "same.myshopify.com",
    });
    mocks.complianceFindMany.mockResolvedValueOnce([
      {
        requestType: "shop_redact",
        triggeredAt: new Date("2026-08-30T03:00:00.000Z"),
        receivedAt: new Date("2026-08-30T03:00:00.000Z"),
      },
    ]);
    mocks.queryRaw
      .mockResolvedValueOnce([
        {
          id: "wstore_active",
          projectId: "workspace_1",
          shopDomain: "same.myshopify.com",
          complianceState: "active",
          uninstalledAt: null,
          installationGeneration: "sgen_existing",
        },
      ])
      .mockResolvedValueOnce([]);
    mocks.transaction.mockImplementation(async (callback: any) =>
      callback(callbackTransactionClient()),
    );

    await expect(
      (PATCH as any)({
        req: new Request("https://room.test/api/shopify/integration/callback", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "connect",
            shopifyStoreId: "same.myshopify.com",
            accessToken: "fresh-token",
            scope: "write_discounts",
          }),
        }),
        workspace: {
          id: "workspace_1",
          shopifyStoreId: "same.myshopify.com",
          defaultProgramId: "program_1",
        },
        session: { user: { id: "user_1" } },
      }),
    ).rejects.toThrow("newer shop-redact request");
    expect(mocks.storeUpdateMany).not.toHaveBeenCalled();
    expect(mocks.installIntegration).not.toHaveBeenCalled();
  });

  it("publishes the frozen policy at the authenticated uninstall cutoff when uninstall wins an active refresh", async () => {
    const uninstallCutoff = new Date("2026-08-30T03:00:00.000Z");
    mocks.storeFindUnique.mockResolvedValue({
      id: "wstore_active",
      shopDomain: "same.myshopify.com",
      complianceState: "active",
      installationGeneration: "sgen_existing",
    });
    mocks.complianceCount.mockResolvedValueOnce(0);
    mocks.complianceFindMany.mockResolvedValueOnce([
      {
        requestType: "app_uninstalled",
        triggeredAt: uninstallCutoff,
        receivedAt: new Date("2026-08-30T03:00:01.000Z"),
      },
    ]);
    mocks.projectUpdate.mockResolvedValue({
      shopifyStoreId: "same.myshopify.com",
    });
    mocks.queryRaw.mockImplementation(async (query: any) => {
      const sql = query?.strings?.join(" ") ?? "";
      if (sql.includes("WeleticShopifyShopPrivacyTombstone")) return [];
      if (sql.includes("WeleticLoyaltyProgram")) {
        return [
          {
            id: "program_active",
            storeId: "wstore_active",
            status: "active",
            killSwitchActive: false,
            metadata: null,
          },
        ];
      }
      return [
        {
          id: "wstore_active",
          projectId: "workspace_1",
          shopDomain: "same.myshopify.com",
          complianceState: "active",
          uninstalledAt: null,
          installationGeneration: "sgen_existing",
        },
      ];
    });
    const tx = callbackTransactionClient();
    mocks.transaction.mockImplementation(async (callback: any) => callback(tx));

    const response = await (PATCH as any)({
      req: new Request("https://room.test/api/shopify/integration/callback", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "connect",
          shopifyStoreId: "same.myshopify.com",
          accessToken: "fresh-token",
          scope: "write_discounts",
        }),
      }),
      workspace: {
        id: "workspace_1",
        shopifyStoreId: "same.myshopify.com",
        defaultProgramId: "program_1",
      },
      session: { user: { id: "user_1" } },
    });

    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        complianceState: "frozen",
        reactivationPending: true,
      }),
    );
    expect(mocks.publishPolicyRevision).toHaveBeenCalledOnce();
    expect(mocks.publishPolicyRevision).toHaveBeenCalledWith({
      tx,
      storeId: "wstore_active",
      programId: "program_active",
      reason: "shopify_uninstall_frozen",
    });
  });

  it("does not reactivate when a newer uninstall wins the final store lock", async () => {
    mocks.storeFindUnique.mockResolvedValue({
      id: "wstore_frozen",
      shopDomain: "same.myshopify.com",
      complianceState: "frozen",
      installationGeneration: "sgen_existing",
    });
    mocks.complianceCount
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1);
    mocks.cleanupCount.mockResolvedValue(0);
    mocks.complianceFindMany.mockResolvedValueOnce([
      {
        requestType: "app_uninstalled",
        triggeredAt: new Date("2026-08-30T03:00:00.000Z"),
        receivedAt: new Date("2026-08-30T03:00:00.000Z"),
      },
    ]);
    mocks.projectUpdate.mockResolvedValue({
      shopifyStoreId: "same.myshopify.com",
    });
    mocks.transaction.mockImplementation(async (callback: any) =>
      callback(callbackTransactionClient()),
    );

    const response = await (PATCH as any)({
      req: new Request("https://room.test/api/shopify/integration/callback", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "connect",
          shopifyStoreId: "same.myshopify.com",
          accessToken: "fresh-token",
          scope: "write_discounts",
        }),
      }),
      workspace: {
        id: "workspace_1",
        shopifyStoreId: null,
        defaultProgramId: "program_1",
      },
      session: { user: { id: "user_1" } },
    });
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        complianceState: "frozen",
        reactivationPending: true,
      }),
    );
    expect(mocks.storeUpdateMany).not.toHaveBeenCalled();
    expect(mocks.installIntegration).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: expect.objectContaining({
          installationGeneration: "sgen_existing",
        }),
        tx: expect.any(Object),
      }),
    );
  });

  it("rejects a new connection when final redaction wins before the write-point tombstone recheck", async () => {
    mocks.storeFindUnique.mockResolvedValue(null);
    mocks.queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "shop_tombstone_after_finalize" }]);

    await expect(
      (PATCH as any)({
        req: new Request("https://room.test/api/shopify/integration/callback", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "connect",
            shopifyStoreId: "same.myshopify.com",
            accessToken: "fresh-token",
            scope: "write_discounts",
          }),
        }),
        workspace: {
          id: "workspace_1",
          shopifyStoreId: null,
          defaultProgramId: "program_1",
        },
        session: { user: { id: "user_1" } },
      }),
    ).rejects.toThrow("retained by a redacted privacy lifecycle");

    expect(mocks.queryRaw).toHaveBeenCalledTimes(2);
    const firstSql =
      mocks.queryRaw.mock.calls[0]?.[0]?.strings?.join(" ") ?? "";
    const secondSql =
      mocks.queryRaw.mock.calls[1]?.[0]?.strings?.join(" ") ?? "";
    expect(firstSql).toContain("WeleticShopifyStore");
    expect(secondSql).toContain("WeleticShopifyShopPrivacyTombstone");
    expect(mocks.projectUpdate).not.toHaveBeenCalled();
    expect(mocks.installIntegration).not.toHaveBeenCalled();
  });

  it("manual disconnect durably freezes without deleting authority synchronously", async () => {
    mocks.storeFindUnique.mockResolvedValue({
      id: "wstore_disconnect",
      shopDomain: "same.myshopify.com",
      complianceState: "active",
      installationGeneration: "sgen_disconnect",
    });
    mocks.installationFindFirst.mockResolvedValue({
      id: "installation_lifecycle_1",
    });

    const response = await (PATCH as any)({
      req: new Request("https://room.test/api/shopify/integration/callback", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "disconnect", shopifyStoreId: null }),
      }),
      workspace: {
        id: "workspace_1",
        shopifyStoreId: "same.myshopify.com",
        defaultProgramId: null,
      },
      session: { user: { id: "user_1" } },
    });

    await expect(response.json()).resolves.toEqual({
      shopifyStoreId: null,
      complianceState: "frozen",
      disconnectRequestId: "wcomp_disconnect",
    });
    expect(persistAndQueueInternalShopifyDisconnect).toHaveBeenCalledWith({
      storeId: "wstore_disconnect",
      canonicalShopDomain: "same.myshopify.com",
      idempotencyKey: "installation_lifecycle_1:sgen_disconnect",
    });
    expect(mocks.installationDeleteMany).not.toHaveBeenCalled();
    expect(prisma.project.update).not.toHaveBeenCalled();
  });
});
