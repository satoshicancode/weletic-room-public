import { prisma } from "@/lib/prisma";
import {
  createLoyaltyMaintenanceLeaseMetadata,
  createLoyaltyMaintenanceOwnerPermit,
  LoyaltyMaintenanceBlockedError,
} from "@/lib/weletic/loyalty/maintenance-write-fence";
import { withActiveStoreLoyaltyMutation } from "@/lib/weletic/loyalty/merchant-write-fence";
import {
  assertShopifyStoreAcceptsOperationalWrites,
  ShopifyStoreOperationalWritesBlockedError,
  withShopifyStoreOperationalWriteFence,
} from "@/lib/weletic/shopify/store-compliance-state";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => {
  const client: any = {
    weleticShopifyStore: { findUnique: vi.fn() },
    weleticLoyaltyProgram: { findUnique: vi.fn() },
    $queryRaw: vi.fn(),
  };
  client.$transaction = vi.fn(async (callback: any) => callback(client));
  return { prisma: client };
});

describe("Shopify store compliance-state operational guard", () => {
  beforeEach(() => vi.clearAllMocks());

  it("allows only the exact active store tenant", async () => {
    vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce({
      id: "store_active",
      complianceState: "active",
    } as any);

    await expect(
      assertShopifyStoreAcceptsOperationalWrites({
        storeId: "store_active",
        action: "customer_sync",
      }),
    ).resolves.toEqual({
      id: "store_active",
      complianceState: "active",
    });
    expect(prisma.weleticShopifyStore.findUnique).toHaveBeenCalledWith({
      where: { id: "store_active" },
      select: {
        id: true,
        complianceState: true,
        shopCurrency: true,
        currencyVerifiedAt: true,
        installationGeneration: true,
        storeAccessState: true,
      },
    });
  });

  it("fails financial writes closed until Shopify currency is authoritative", async () => {
    vi.mocked(prisma.weleticShopifyStore.findUnique)
      .mockResolvedValueOnce({
        id: "store_pending_currency",
        complianceState: "active",
        shopCurrency: "USD",
        currencyVerifiedAt: null,
      } as any)
      .mockResolvedValueOnce({
        id: "store_verified_currency",
        complianceState: "active",
        shopCurrency: "JPY",
        currencyVerifiedAt: new Date("2026-08-30T00:00:00.000Z"),
      } as any);

    await expect(
      assertShopifyStoreAcceptsOperationalWrites({
        storeId: "store_pending_currency",
        action: "reward_redemption",
        requireVerifiedCurrency: true,
      }),
    ).rejects.toMatchObject({
      name: "ShopifyStoreOperationalWritesBlockedError",
      complianceState: "currency_unverified",
    });

    await expect(
      assertShopifyStoreAcceptsOperationalWrites({
        storeId: "store_verified_currency",
        action: "reward_redemption",
        requireVerifiedCurrency: true,
      }),
    ).resolves.toMatchObject({ shopCurrency: "JPY" });
  });

  it.each(["frozen", "redacted"] as const)(
    "blocks operational writes when the store is %s",
    async (complianceState) => {
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce({
        id: "store_blocked",
        complianceState,
      } as any);

      await expect(
        assertShopifyStoreAcceptsOperationalWrites({
          storeId: "store_blocked",
          action: "order_ingestion",
        }),
      ).rejects.toMatchObject({
        name: "ShopifyStoreOperationalWritesBlockedError",
        storeId: "store_blocked",
        complianceState,
      });
    },
  );

  it("fails closed on a missing store unless first-install creation is explicit", async () => {
    vi.mocked(prisma.weleticShopifyStore.findUnique)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    await expect(
      assertShopifyStoreAcceptsOperationalWrites({
        workspaceId: "workspace_missing",
        action: "order_ingestion",
      }),
    ).rejects.toBeInstanceOf(ShopifyStoreOperationalWritesBlockedError);
    await expect(
      assertShopifyStoreAcceptsOperationalWrites({
        workspaceId: "workspace_new_install",
        action: "catalog_sync",
        allowMissing: true,
      }),
    ).resolves.toBeNull();
  });

  it("rejects ambiguous tenant selectors", async () => {
    await expect(
      assertShopifyStoreAcceptsOperationalWrites({
        storeId: "store_a",
        workspaceId: "workspace_b",
        action: "invalid",
      }),
    ).rejects.toThrow("Exactly one of storeId or workspaceId");
  });

  it("claims the active store row inside operational transactions", async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValue([{ id: "store_active", complianceState: "active" }]);
    const tx = { $queryRaw: queryRaw } as any;

    await expect(
      assertShopifyStoreAcceptsOperationalWrites({
        storeId: "store_active",
        action: "reward_redemption",
        tx,
      }),
    ).resolves.toEqual({
      id: "store_active",
      complianceState: "active",
      shopCurrency: "USD",
      currencyVerifiedAt: new Date(0),
      installationGeneration: null,
    });

    expect(queryRaw).toHaveBeenCalledTimes(2);
    const statement = queryRaw.mock.calls[0][0];
    expect(statement.strings.join(" ")).toContain("FOR UPDATE");
    expect(statement.values).toEqual(["store_active"]);
  });

  it("blocks a transaction that claims an already-frozen store row", async () => {
    const tx = {
      $queryRaw: vi
        .fn()
        .mockResolvedValue([{ id: "store_frozen", complianceState: "frozen" }]),
    } as any;

    await expect(
      assertShopifyStoreAcceptsOperationalWrites({
        storeId: "store_frozen",
        action: "order_points_earn",
        tx,
      }),
    ).rejects.toMatchObject({
      name: "ShopifyStoreOperationalWritesBlockedError",
      storeId: "store_frozen",
      complianceState: "frozen",
    });
  });

  it("linearizes a bounded operational publication on the store row", async () => {
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([
        {
          id: "store_active",
          complianceState: "active",
          shopCurrency: "JPY",
          currencyVerifiedAt: new Date("2026-08-30T00:00:00.000Z"),
        },
      ] as any)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "store_frozen",
          complianceState: "frozen",
          shopCurrency: "JPY",
          currencyVerifiedAt: new Date("2026-08-30T00:00:00.000Z"),
        },
      ] as any);
    const publish = vi.fn().mockResolvedValue("published");

    await expect(
      withShopifyStoreOperationalWriteFence({
        storeId: "store_active",
        action: "discount_publication",
        operation: publish,
      }),
    ).resolves.toBe("published");
    await expect(
      withShopifyStoreOperationalWriteFence({
        storeId: "store_frozen",
        action: "discount_publication",
        operation: publish,
      }),
    ).rejects.toMatchObject({ complianceState: "frozen" });

    expect(publish).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    const statement = vi.mocked(prisma.$queryRaw).mock.calls[0][0] as any;
    expect(statement.strings.join(" ")).toContain("FOR UPDATE");
  });

  it("locks store then program and throws the distinct maintenance error", async () => {
    const metadata = createLoyaltyMaintenanceLeaseMetadata({
      existingMetadata: null,
      ownerToken: "owner-token-0123456789abcdef0123456789abcdef",
      runMarker: "weletic-a1-0123456789abcdef",
      fixtureEmails: ["weletic-a1-0123456789abcdef-user@example.com"],
      acquiredAt: new Date("2026-08-31T00:00:00.000Z"),
      recoveryAfter: new Date("2026-08-31T00:30:00.000Z"),
    });
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: "store_active",
          complianceState: "active",
          shopCurrency: "JPY",
          currencyVerifiedAt: new Date("2026-08-30T00:00:00.000Z"),
          installationGeneration: "generation_a1",
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "program_a1",
          storeId: "store_active",
          status: "active",
          killSwitchActive: false,
          metadata,
        },
      ]);

    await expect(
      assertShopifyStoreAcceptsOperationalWrites({
        storeId: "store_active",
        action: "customer_sync",
        tx: { $queryRaw: queryRaw } as any,
      }),
    ).rejects.toBeInstanceOf(LoyaltyMaintenanceBlockedError);

    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(queryRaw.mock.calls[0][0].strings.join(" ")).toContain(
      "FROM WeleticShopifyStore",
    );
    expect(queryRaw.mock.calls[1][0].strings.join(" ")).toContain(
      "FROM WeleticLoyaltyProgram",
    );
  });

  it("allows an exact-store permit through the merchant mutation fence", async () => {
    const ownerToken = "owner-token-0123456789abcdef0123456789abcdef";
    const metadata = createLoyaltyMaintenanceLeaseMetadata({
      existingMetadata: null,
      ownerToken,
      runMarker: "weletic-a1-0123456789abcdef",
      fixtureEmails: ["weletic-a1-0123456789abcdef-user@example.com"],
      acquiredAt: new Date("2026-08-31T00:00:00.000Z"),
      recoveryAfter: new Date("2026-08-31T00:30:00.000Z"),
    });
    const permit = createLoyaltyMaintenanceOwnerPermit({
      storeId: "store_active",
      metadata: metadata as any,
      ownerToken,
    });
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([
        {
          id: "store_active",
          complianceState: "active",
          shopCurrency: "JPY",
          currencyVerifiedAt: new Date("2026-08-30T00:00:00.000Z"),
          installationGeneration: "generation_a1",
        },
      ] as any)
      .mockResolvedValueOnce([
        {
          id: "program_a1",
          storeId: "store_active",
          status: "active",
          killSwitchActive: false,
          metadata,
        },
      ] as any);
    const operation = vi.fn().mockResolvedValue("mutated");

    await expect(
      withActiveStoreLoyaltyMutation({
        storeId: "store_active",
        action: "a1_fixture_mutation",
        expectedInstallationGeneration: "generation_a1",
        loyaltyMaintenancePermit: permit,
        operation,
      }),
    ).resolves.toBe("mutated");
    expect(operation).toHaveBeenCalledWith(expect.anything(), "generation_a1");
  });
});
