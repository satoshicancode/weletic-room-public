import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  storeFindUnique: vi.fn(),
  storeUpdateMany: vi.fn(),
  programUpdateMany: vi.fn(),
  sessionDeleteMany: vi.fn(),
  installIntentDeleteMany: vi.fn(),
  integrationFindMany: vi.fn(),
  integrationDeleteMany: vi.fn(),
  projectFindUnique: vi.fn(),
  projectUpdateMany: vi.fn(),
  queryRaw: vi.fn(),
  invalidateCache: vi.fn(),
  voucherStep: vi.fn(),
  redactFriendShopBatch: vi.fn(),
  freezeStore: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    weleticShopifyStore: {
      findUnique: mocks.storeFindUnique,
      updateMany: mocks.storeUpdateMany,
    },
    weleticLoyaltyProgram: { updateMany: mocks.programUpdateMany },
    weleticShopifyAppSession: { deleteMany: mocks.sessionDeleteMany },
    weleticShopifyInstallIntent: {
      deleteMany: mocks.installIntentDeleteMany,
    },
    installedIntegration: {
      findMany: mocks.integrationFindMany,
      deleteMany: mocks.integrationDeleteMany,
    },
    project: {
      findUnique: mocks.projectFindUnique,
      updateMany: mocks.projectUpdateMany,
    },
  },
}));

vi.mock("@/lib/weletic/loyalty/voucher-privacy-cleanup", () => ({
  processStoreVoucherCleanupComplianceStep: mocks.voucherStep,
}));
vi.mock("@/lib/weletic/loyalty/referral-friend-claim", () => ({
  redactReferralFriendClaimsForShopBatch: mocks.redactFriendShopBatch,
}));
vi.mock("@/lib/weletic/shopify/compliance-ingress", () => ({
  freezeShopifyStoreForUninstall: mocks.freezeStore,
}));

vi.mock("@/lib/weletic/shopify/store-resolver", () => ({
  normalizeShopDomain: (value: string) =>
    value
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, ""),
  invalidateShopifyStoreDomainCache: mocks.invalidateCache,
}));

import {
  appUninstalled,
  processAppUninstalledComplianceStep,
} from "../../app/(ee)/api/shopify/integration/webhook/app-uninstalled";

const baseStep = {
  requestId: "compliance_uninstall_1",
  workspaceId: "workspace_a",
  storeId: "store_a",
  shopDomain: "a-current.myshopify.com",
  cursor: null,
  progress: null,
  workerId: "compliance-worker-1",
  receivedAt: new Date("2026-08-29T23:59:00.000Z"),
  installationGeneration: "sgen_one",
};

describe("durable Shopify app-uninstalled lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.storeFindUnique.mockResolvedValue({
      id: "store_a",
      projectId: "workspace_a",
      shopDomain: "a-current.myshopify.com",
      complianceState: "active",
      uninstalledAt: new Date("2026-08-30T00:00:00.000Z"),
      installationGeneration: "sgen_one",
    });
    mocks.storeUpdateMany.mockReturnValue({ operation: "store" });
    mocks.programUpdateMany.mockReturnValue({ operation: "program" });
    mocks.sessionDeleteMany.mockReturnValue({ operation: "sessions" });
    mocks.installIntentDeleteMany.mockReturnValue({ operation: "intents" });
    mocks.integrationDeleteMany.mockReturnValue({ operation: "integration" });
    mocks.projectUpdateMany.mockReturnValue({ operation: "project" });
    mocks.queryRaw.mockResolvedValue([
      {
        id: "store_a",
        projectId: "workspace_a",
        shopDomain: "a-current.myshopify.com",
        complianceState: "frozen",
        uninstalledAt: baseStep.receivedAt,
        installationGeneration: "sgen_one",
      },
    ]);
    mocks.transaction.mockImplementation(async (callback: any) =>
      callback({
        $queryRaw: mocks.queryRaw,
        project: {
          findUnique: mocks.projectFindUnique,
          updateMany: mocks.projectUpdateMany,
        },
        installedIntegration: {
          findMany: mocks.integrationFindMany,
          deleteMany: mocks.integrationDeleteMany,
        },
        weleticShopifyAppSession: {
          deleteMany: mocks.sessionDeleteMany,
        },
        weleticShopifyInstallIntent: {
          deleteMany: mocks.installIntentDeleteMany,
        },
      }),
    );
    mocks.projectFindUnique.mockResolvedValue({
      shopifyStoreId: "a-current.myshopify.com",
    });
    mocks.integrationFindMany.mockResolvedValue([
      {
        id: "installation_1",
        credentials: {
          shop: "a-old.myshopify.com",
          accessToken: "secret",
          installationGeneration: "sgen_one",
        },
      },
    ]);
    mocks.freezeStore.mockResolvedValue({
      complianceState: "frozen",
      cutoff: baseStep.receivedAt,
    });
    mocks.redactFriendShopBatch.mockResolvedValue({
      scrubbed: 0,
      hasMore: false,
      lastId: undefined,
    });
  });

  it("freezes loyalty immediately but retains credentials for durable cleanup", async () => {
    const result = await processAppUninstalledComplianceStep({
      ...baseStep,
      phase: "received",
    });

    expect(result).toEqual({
      completed: false,
      phase: "enumerate_vouchers",
      cursor: expect.anything(),
      progress: { frozen: true },
    });
    expect(mocks.freezeStore).toHaveBeenCalledWith({
      workspaceId: "workspace_a",
      storeId: "store_a",
      canonicalShopDomain: "a-current.myshopify.com",
      cutoff: baseStep.receivedAt,
      expectedInstallationGeneration: "sgen_one",
    });
    expect(mocks.sessionDeleteMany).not.toHaveBeenCalled();
    expect(mocks.integrationDeleteMany).not.toHaveBeenCalled();
  });

  it("does not scrub credentials while any voucher cleanup is outstanding", async () => {
    mocks.voucherStep.mockResolvedValue({
      completed: false,
      phase: "voucher_cleanup",
      progress: { outstanding: 1, completed: 2, deadLetter: 0 },
    });

    const result = await processAppUninstalledComplianceStep({
      ...baseStep,
      phase: "credential_scrub",
    });

    expect(result.phase).toBe("voucher_cleanup");
    expect(mocks.sessionDeleteMany).not.toHaveBeenCalled();
    expect(mocks.integrationDeleteMany).not.toHaveBeenCalled();
    expect(mocks.invalidateCache).not.toHaveBeenCalled();
  });

  it("deactivates anonymous friend vouchers before credential scrub", async () => {
    mocks.redactFriendShopBatch.mockResolvedValueOnce({
      scrubbed: 20,
      hasMore: true,
      lastId: "wreferral_020",
    });

    const result = await processAppUninstalledComplianceStep({
      ...baseStep,
      phase: "credential_scrub",
    });

    expect(result).toMatchObject({
      completed: false,
      phase: "scrub_friend_referral_claims",
      cursor: { lastId: "wreferral_020" },
      progress: { friendReferralClaimsScrubbed: 20 },
    });
    expect(mocks.voucherStep).not.toHaveBeenCalled();
    expect(mocks.integrationDeleteMany).not.toHaveBeenCalled();
  });

  it("retains dead-letter audit, then invalidates aliases and scrubs credentials", async () => {
    mocks.voucherStep.mockResolvedValue({
      completed: false,
      phase: "credential_scrub",
      progress: {
        outstanding: 0,
        completed: 2,
        deadLetter: 1,
        unresolvedVoucherCleanup: true,
      },
    });

    const result = await processAppUninstalledComplianceStep({
      ...baseStep,
      phase: "credential_scrub",
    });

    expect(result).toEqual({
      completed: false,
      phase: "finalize",
      cursor: expect.anything(),
      progress: expect.objectContaining({
        deadLetter: 1,
        unresolvedVoucherCleanup: true,
      }),
    });
    expect(mocks.invalidateCache).toHaveBeenCalledWith([
      "a-current.myshopify.com",
      "a-old.myshopify.com",
    ]);
    expect(mocks.invalidateCache).toHaveBeenCalledTimes(1);
    expect(mocks.sessionDeleteMany).toHaveBeenCalledWith({
      where: {
        shop: { in: ["a-current.myshopify.com", "a-old.myshopify.com"] },
      },
    });
    expect(mocks.integrationDeleteMany).toHaveBeenCalledWith({
      where: {
        projectId: "workspace_a",
        id: { in: ["installation_1"] },
      },
    });
    expect(mocks.projectUpdateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "workspace_a",
      }),
      data: { shopifyStoreId: null },
    });
    expect(
      JSON.stringify(mocks.projectUpdateMany.mock.calls[0][0].where),
    ).not.toContain("updatedAt");
  });

  it("scrubs the same generation after verification bookkeeping advances updatedAt", async () => {
    mocks.voucherStep.mockResolvedValue({
      completed: false,
      phase: "credential_scrub",
      progress: { outstanding: 0, completed: 1, deadLetter: 0 },
    });
    mocks.integrationFindMany.mockResolvedValue([
      {
        id: "installation_after_verification",
        updatedAt: new Date(baseStep.receivedAt.getTime() + 60_000),
        credentials: {
          shop: "a-current.myshopify.com",
          installationGeneration: "sgen_one",
          shopVerifiedAt: new Date(
            baseStep.receivedAt.getTime() + 60_000,
          ).toISOString(),
        },
      },
    ]);

    await processAppUninstalledComplianceStep({
      ...baseStep,
      phase: "credential_scrub",
    });

    expect(mocks.integrationDeleteMany).toHaveBeenCalledWith({
      where: {
        projectId: "workspace_a",
        id: { in: ["installation_after_verification"] },
      },
    });
    expect(
      JSON.stringify(mocks.integrationDeleteMany.mock.calls),
    ).not.toContain("updatedAt");
  });

  it("leaves the durable request retryable when credential scrubbing partially fails", async () => {
    mocks.voucherStep.mockResolvedValue({
      completed: false,
      phase: "credential_scrub",
      progress: { outstanding: 0, completed: 3, deadLetter: 0 },
    });
    mocks.transaction.mockRejectedValueOnce(
      new Error("database unavailable during credential scrub"),
    );

    await expect(
      processAppUninstalledComplianceStep({
        ...baseStep,
        phase: "credential_scrub",
      }),
    ).rejects.toThrow("database unavailable during credential scrub");

    expect(mocks.invalidateCache).toHaveBeenCalledTimes(1);
  });

  it("keeps the legacy webhook helper freeze-only", async () => {
    await appUninstalled({
      workspaceId: "workspace_a",
      storeId: "store_a",
      shopDomains: [
        "https://A-CURRENT.myshopify.com/",
        "a-current.myshopify.com",
      ],
    });

    expect(mocks.freezeStore).toHaveBeenCalledOnce();
    expect(mocks.sessionDeleteMany).not.toHaveBeenCalled();
    expect(mocks.integrationDeleteMany).not.toHaveBeenCalled();
  });

  it("fails closed when the retained store does not match the request", async () => {
    mocks.storeFindUnique.mockResolvedValue({
      id: "store_other",
      projectId: "workspace_other",
      shopDomain: "other.myshopify.com",
      complianceState: "active",
    });
    mocks.freezeStore.mockRejectedValueOnce(
      new Error(
        "The uninstall lifecycle does not match the retained Shopify store.",
      ),
    );

    await expect(
      processAppUninstalledComplianceStep({
        ...baseStep,
        phase: "received",
      }),
    ).rejects.toThrow("does not match the retained Shopify store");

    expect(mocks.storeUpdateMany).not.toHaveBeenCalled();
    expect(mocks.programUpdateMany).not.toHaveBeenCalled();
  });
});
