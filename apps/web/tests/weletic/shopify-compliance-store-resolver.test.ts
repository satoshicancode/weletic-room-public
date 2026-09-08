import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  storeFindUnique: vi.fn(),
  tombstoneFindMany: vi.fn(),
  deriveShopIdentities: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticShopifyStore: { findUnique: mocks.storeFindUnique },
    weleticShopifyShopPrivacyTombstone: {
      findMany: mocks.tombstoneFindMany,
    },
  },
}));
vi.mock("@/lib/weletic/shopify/privacy-identity", () => ({
  deriveAllShopifyShopPrivacyIdentities: mocks.deriveShopIdentities,
}));

import { resolveComplianceShopifyStoreByDomain } from "../../lib/weletic/shopify/compliance-store-resolver";

describe("token-independent Shopify compliance store resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.storeFindUnique.mockResolvedValue(null);
    mocks.tombstoneFindMany.mockResolvedValue([]);
    mocks.deriveShopIdentities.mockReturnValue([]);
  });

  it("resolves an exact canonical store without reading installation credentials", async () => {
    mocks.storeFindUnique.mockResolvedValue({
      id: "store_1",
      projectId: "workspace_1",
      programId: "program_1",
      shopDomain: "target.myshopify.com",
      complianceState: "frozen",
    });

    await expect(
      resolveComplianceShopifyStoreByDomain(
        "https://TARGET.myshopify.com/admin",
      ),
    ).resolves.toEqual({
      storeId: "store_1",
      workspaceId: "workspace_1",
      programId: "program_1",
      canonicalShopDomain: "target.myshopify.com",
      storageShopDomain: "target.myshopify.com",
      complianceState: "frozen",
      resolvedFromTombstone: false,
    });
    expect(mocks.storeFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shopDomain: "target.myshopify.com" },
      }),
    );
  });

  it("resolves an already-erased store through its keyed-HMAC tombstone", async () => {
    mocks.deriveShopIdentities.mockReturnValue([
      { identityKeyId: "kid_1", shopDomainDigest: "SAFE_DIGEST" },
    ]);
    mocks.tombstoneFindMany.mockResolvedValue([
      {
        store: {
          id: "store_redacted",
          projectId: "workspace_1",
          programId: "program_1",
          shopDomain: "redacted-kid-safe.invalid",
          complianceState: "redacted",
        },
      },
    ]);

    const result = await resolveComplianceShopifyStoreByDomain(
      "erased.myshopify.com",
    );
    expect(result).toMatchObject({
      storeId: "store_redacted",
      canonicalShopDomain: "erased.myshopify.com",
      storageShopDomain: "redacted-kid-safe.invalid",
      complianceState: "redacted",
      resolvedFromTombstone: true,
    });
    expect(mocks.tombstoneFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          identityKeyId: "kid_1",
          shopDomainDigest: "SAFE_DIGEST",
          expiresAt: { gt: expect.any(Date) },
        }),
      }),
    );
  });

  it("does not resolve an expired shop tombstone", async () => {
    mocks.deriveShopIdentities.mockReturnValue([
      { identityKeyId: "kid_1", shopDomainDigest: "SAFE_DIGEST" },
    ]);
    mocks.tombstoneFindMany.mockResolvedValue([]);

    await expect(
      resolveComplianceShopifyStoreByDomain("expired.myshopify.com"),
    ).resolves.toBeNull();
    expect(mocks.tombstoneFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ expiresAt: { gt: expect.any(Date) } }),
      }),
    );
  });

  it("fails closed when an exact recycled domain conflicts with an old owner", async () => {
    mocks.storeFindUnique.mockResolvedValue({
      id: "store_new",
      projectId: "workspace_new",
      programId: "program_new",
      shopDomain: "recycled.myshopify.com",
      complianceState: "active",
    });
    mocks.deriveShopIdentities.mockReturnValue([
      { identityKeyId: "kid_1", shopDomainDigest: "SAFE_DIGEST" },
    ]);
    mocks.tombstoneFindMany.mockResolvedValue([
      {
        store: {
          id: "store_old",
          projectId: "workspace_old",
          programId: "program_old",
          shopDomain: "redacted-old.invalid",
          complianceState: "redacted",
        },
      },
    ]);

    await expect(
      resolveComplianceShopifyStoreByDomain("recycled.myshopify.com"),
    ).resolves.toBeNull();
  });

  it("fails closed when different key versions bind one domain to different stores", async () => {
    mocks.deriveShopIdentities.mockReturnValue([
      { identityKeyId: "current", shopDomainDigest: "CURRENT_DIGEST" },
      { identityKeyId: "previous", shopDomainDigest: "PREVIOUS_DIGEST" },
    ]);
    mocks.tombstoneFindMany
      .mockResolvedValueOnce([
        {
          store: {
            id: "store_a",
            projectId: "workspace_a",
            programId: "program_a",
            shopDomain: "redacted-a.invalid",
            complianceState: "redacted",
          },
        },
      ])
      .mockResolvedValueOnce([
        {
          store: {
            id: "store_b",
            projectId: "workspace_b",
            programId: "program_b",
            shopDomain: "redacted-b.invalid",
            complianceState: "redacted",
          },
        },
      ]);

    await expect(
      resolveComplianceShopifyStoreByDomain("ambiguous.myshopify.com"),
    ).resolves.toBeNull();
  });
});
