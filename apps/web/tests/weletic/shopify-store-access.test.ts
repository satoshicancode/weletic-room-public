import { prisma } from "@/lib/prisma";
import { lockLoyaltyProgramRow } from "@/lib/weletic/loyalty/program-write-fence";
import { changeShopifyStoreAccess } from "@/lib/weletic/shopify/store-access-operator";
import { isShopifyStoreAccessActive } from "@/lib/weletic/shopify/store-access-policy";
import { assertShopifyStoreAcceptsOperationalWrites } from "@/lib/weletic/shopify/store-compliance-state";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => {
  const client: any = {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    weleticShopifyStore: { findUnique: vi.fn() },
    weleticLoyaltyProgram: { findUnique: vi.fn() },
    weleticShopifyComplianceRequest: { count: vi.fn() },
    weleticShopifyStoreAccessChange: { create: vi.fn() },
  };
  client.$transaction = vi.fn(async (operation: any) => operation(client));
  return { prisma: client };
});

const store = {
  id: "store_company",
  shopDomain: "company.myshopify.com",
  installationGeneration: "generation_1",
  complianceState: "active",
  storeAccessState: "pending_approval",
  storeAccessRevision: 1,
  shopCurrency: "JPY",
  currencyVerifiedAt: new Date(0),
};
const input = {
  storeId: store.id,
  shopDomain: store.shopDomain,
  expectedInstallationGeneration: "generation_1",
  expectedRevision: 1,
  nextState: "active",
  operator: "company-operator",
  reason: "Approved company store",
};

describe("company store admission", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(prisma.$transaction).mockImplementation(async (operation: any) =>
      operation(prisma),
    );
    vi.mocked(prisma.$queryRaw).mockImplementation((async (query: any) =>
      query.sql.includes("FROM WeleticShopifyStore")
        ? [{ ...store }]
        : []) as any);
    vi.mocked(prisma.weleticShopifyComplianceRequest.count).mockResolvedValue(
      0,
    );
    vi.mocked(prisma.$executeRaw).mockResolvedValue(1);
  });

  it.each([undefined, null, "", "pending_approval", "suspended", "unknown"])(
    "fails closed for %s",
    (state) => {
      expect(isShopifyStoreAccessActive(state)).toBe(false);
    },
  );
  it("accepts the explicit active state", () => {
    expect(isShopifyStoreAccessActive("active")).toBe(true);
  });
  it.each(["pending_approval", "suspended"])(
    "blocks ingestion and voucher workers for %s",
    async (storeAccessState) => {
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
        ...store,
        storeAccessState,
      } as any);
      await expect(
        assertShopifyStoreAcceptsOperationalWrites({
          storeId: store.id,
          action: "customer_sync",
        }),
      ).rejects.toMatchObject({ complianceState: storeAccessState });
      vi.mocked(prisma.$queryRaw).mockImplementation((async (query: any) =>
        query.sql.includes("FROM WeleticShopifyStore")
          ? [{ ...store, storeAccessState }]
          : [
              {
                id: "program",
                storeId: store.id,
                status: "active",
                killSwitchActive: false,
                metadata: null,
              },
            ]) as any);
      await expect(
        lockLoyaltyProgramRow({
          tx: prisma as any,
          storeId: store.id,
          mode: "active",
        }),
      ).rejects.toMatchObject({ name: "LoyaltyProgramWriteBlockedError" });
    },
  );
  it("previews without changing state or audit history", async () => {
    await expect(changeShopifyStoreAccess(input)).resolves.toMatchObject({
      applied: false,
      revision: 2,
    });
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(
      prisma.weleticShopifyStoreAccessChange.create,
    ).not.toHaveBeenCalled();
  });
  it("commits a fenced change and its operator audit in one transaction", async () => {
    await expect(
      changeShopifyStoreAccess({ ...input, apply: true }),
    ).resolves.toMatchObject({ applied: true, revision: 2 });
    expect(prisma.$executeRaw).toHaveBeenCalledWith(
      expect.objectContaining({
        values: ["active", 2, store.id, "generation_1", 1, "pending_approval"],
      }),
    );
    expect(prisma.weleticShopifyStoreAccessChange.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        previousState: "pending_approval",
        nextState: "active",
        revision: 2,
        operator: input.operator,
        reason: input.reason,
      }),
    });
  });
  it.each([
    { shopDomain: "other.myshopify.com" },
    { expectedRevision: 2 },
    { expectedInstallationGeneration: "stale_generation" },
    { nextState: "unknown" },
  ])("rejects mismatched or invalid input %j", async (change) => {
    await expect(
      changeShopifyStoreAccess({ ...input, ...change, apply: true }),
    ).rejects.toThrow();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });
  it("never activates a store with pending uninstall or erasure", async () => {
    vi.mocked(prisma.weleticShopifyComplianceRequest.count).mockResolvedValue(
      1,
    );
    await expect(
      changeShopifyStoreAccess({ ...input, apply: true }),
    ).rejects.toThrow("pending privacy");
    expect(
      prisma.weleticShopifyStoreAccessChange.create,
    ).not.toHaveBeenCalled();
  });
  it("does not record an audit if the compare-and-swap loses", async () => {
    vi.mocked(prisma.$executeRaw).mockResolvedValue(0);
    await expect(
      changeShopifyStoreAccess({ ...input, apply: true }),
    ).rejects.toThrow("revision fence");
    expect(
      prisma.weleticShopifyStoreAccessChange.create,
    ).not.toHaveBeenCalled();
  });
});
