import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    project: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
    installedIntegration: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    weleticShopifyAppSession: {
      findFirst: vi.fn(),
    },
    weleticShopifyStore: {
      findUnique: vi.fn(),
    },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  },
}));

import { encrypt } from "@/lib/encryption";
import { prisma } from "@/lib/prisma";
import {
  canonicalizeShopifyDomain,
  invalidateShopifyStoreDomainCache,
  normalizeShopDomain,
  resolveShopifyStoreByDomain,
  shopifyCredentialVerificationHash,
  verifyShopifyAccessTokenForDomain,
} from "@/lib/weletic/shopify/store-resolver";

describe("Shopify Canonical Store Resolver & Multi-Domain Alias Suite", () => {
  const workspaceId = "ws_test_canonical_shop_1";
  const programId = "prog_test_canonical_shop_1";
  const testAccessToken = "shpat_test_secret_token_12345";
  const originalEncryptionKey = process.env.ENCRYPTION_KEY;
  let encryptedToken: string;
  const mockFetch = vi.fn<typeof fetch>();

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = "unit-test-only-shopify-store-resolver-key";
    encryptedToken = encrypt(testAccessToken);
  });

  afterAll(() => {
    if (originalEncryptionKey === undefined) {
      delete process.env.ENCRYPTION_KEY;
    } else {
      process.env.ENCRYPTION_KEY = originalEncryptionKey;
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset().mockRejectedValue(new Error("Unexpected network"));
    vi.stubGlobal("fetch", mockFetch);
    vi.mocked(prisma.project.findUnique).mockReset().mockResolvedValue(null);
    vi.mocked(prisma.project.findFirst).mockReset().mockResolvedValue(null);
    vi.mocked(prisma.installedIntegration.findFirst)
      .mockReset()
      .mockResolvedValue(null);
    vi.mocked(prisma.installedIntegration.findUnique)
      .mockReset()
      .mockResolvedValue(null);
    vi.mocked(prisma.installedIntegration.update)
      .mockReset()
      .mockResolvedValue({} as any);
    vi.mocked(prisma.$queryRaw)
      .mockReset()
      .mockResolvedValue([
        {
          id: "wstore_123",
          projectId: workspaceId,
          installationGeneration: "sgen_one",
        },
      ] as any);
    vi.mocked(prisma.$transaction).mockImplementation(async (callback: any) =>
      callback({
        $queryRaw: prisma.$queryRaw,
        installedIntegration: {
          findUnique: prisma.installedIntegration.findUnique,
          update: prisma.installedIntegration.update,
        },
      }),
    );
    vi.mocked(prisma.weleticShopifyAppSession.findFirst)
      .mockReset()
      .mockResolvedValue(null);
    vi.mocked(prisma.weleticShopifyStore.findUnique)
      .mockReset()
      .mockResolvedValue(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("1.1: normalizes shop domains correctly (removes protocols, paths, trailing slashes)", () => {
    expect(normalizeShopDomain("https://yamaxdev.myshopify.com/")).toBe(
      "yamaxdev.myshopify.com",
    );
    expect(normalizeShopDomain("http://montdev.myshopify.com/admin")).toBe(
      "montdev.myshopify.com",
    );
    expect(normalizeShopDomain("  YAMAXDEV.MYSHOPIFY.COM  ")).toBe(
      "yamaxdev.myshopify.com",
    );
    expect(normalizeShopDomain("")).toBe("");
    expect(
      canonicalizeShopifyDomain("https://YAMAXDEV.myshopify.com/admin"),
    ).toBe("yamaxdev.myshopify.com");
    expect(canonicalizeShopifyDomain("yamaxdev.example.com")).toBeNull();
    expect(canonicalizeShopifyDomain("invalid-.myshopify.com")).toBeNull();
  });

  it("1.1b: canonicalizes formatting variants to one database identity", () => {
    const variants = [
      "yamaxdev.myshopify.com",
      "https://YAMAXDEV.myshopify.com",
      "http://yamaxdev.myshopify.com/admin",
    ];
    expect(new Set(variants.map(canonicalizeShopifyDomain))).toEqual(
      new Set(["yamaxdev.myshopify.com"]),
    );
  });

  it("1.2: resolves workspace seamlessly via primary domain (yamaxdev.myshopify.com)", async () => {
    vi.spyOn(prisma.project, "findFirst").mockResolvedValueOnce({
      id: workspaceId,
      shopifyStoreId: "yamaxdev.myshopify.com",
      defaultProgramId: programId,
      installedIntegrations: [
        {
          id: "integration_current_domain",
          credentials: {
            shop: "montdev.myshopify.com",
            scope: "read_products,write_discounts",
            accessToken: encryptedToken,
          },
        },
      ],
      weleticShopifyStore: {
        id: "wstore_123",
        shopDomain: "yamaxdev.myshopify.com",
        installationGeneration: "sgen_one",
      },
    } as any);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          shop: {
            myshopifyDomain: "yamaxdev.myshopify.com",
            currencyCode: "USD",
          },
        },
      }),
    } as Response);
    vi.mocked(prisma.installedIntegration.findUnique).mockResolvedValueOnce({
      id: "integration_current_domain",
      projectId: workspaceId,
      credentials: {
        shop: "montdev.myshopify.com",
        scope: "read_products,write_discounts",
        accessToken: encryptedToken,
      },
    } as any);

    const result = await resolveShopifyStoreByDomain("yamaxdev.myshopify.com");
    expect(result).not.toBeNull();
    expect(result?.workspaceId).toBe(workspaceId);
    expect(result?.programId).toBe(programId);
    expect(result?.accessToken).toBe(testAccessToken);
    expect(result?.primaryDomain).toBe("yamaxdev.myshopify.com");
    expect(result?.myshopifyDomain).toBe("yamaxdev.myshopify.com");
  });

  it("1.3: resolves workspace seamlessly via legacy myshopify domain (montdev.myshopify.com)", async () => {
    // 1st query by shopifyStoreId directly matches montdev or installedIntegrations fallback
    vi.spyOn(prisma.project, "findFirst").mockResolvedValueOnce(null);
    vi.spyOn(prisma.installedIntegration, "findFirst").mockResolvedValueOnce({
      id: "integration_legacy_domain",
      projectId: workspaceId,
      credentials: {
        shop: "montdev.myshopify.com",
        scope: "read_products,write_discounts",
        accessToken: encryptedToken,
        shopVerifiedAt: "2026-08-28T00:00:00.000Z",
        shopVerificationTokenHash:
          shopifyCredentialVerificationHash(testAccessToken),
        installationGeneration: "sgen_one",
      },
      project: {
        id: workspaceId,
        shopifyStoreId: "yamaxdev.myshopify.com",
        defaultProgramId: programId,
        weleticShopifyStore: {
          id: "wstore_123",
          shopDomain: "yamaxdev.myshopify.com",
          installationGeneration: "sgen_one",
        },
      },
    } as any);
    vi.mocked(prisma.installedIntegration.findUnique).mockResolvedValueOnce({
      id: "integration_legacy_domain",
      projectId: workspaceId,
      credentials: {
        shop: "montdev.myshopify.com",
        scope: "read_products,write_discounts",
        accessToken: encryptedToken,
        shopVerifiedAt: "2026-08-28T00:00:00.000Z",
        shopVerificationTokenHash:
          shopifyCredentialVerificationHash(testAccessToken),
        installationGeneration: "sgen_one",
      },
    } as any);

    const result = await resolveShopifyStoreByDomain("montdev.myshopify.com");
    expect(result).not.toBeNull();
    expect(result?.workspaceId).toBe(workspaceId);
    expect(result?.programId).toBe(programId);
    expect(result?.accessToken).toBe(testAccessToken);
    expect(result?.allDomains).toContain("montdev.myshopify.com");
    expect(result?.allDomains).toContain("yamaxdev.myshopify.com");
  });

  it("1.3b: rejects an unverified credential-only alias with a mismatched token", async () => {
    vi.mocked(prisma.installedIntegration.findFirst).mockResolvedValueOnce({
      id: "integration_unverified_alias",
      credentials: {
        shop: "legacy-alias.myshopify.com",
        scope: "write_discounts",
        accessToken: encryptedToken,
      },
      updatedAt: new Date("2026-08-28T00:00:00.000Z"),
      project: {
        id: workspaceId,
        shopifyStoreId: "canonical-shop.myshopify.com",
        defaultProgramId: programId,
        weleticShopifyStore: {
          id: "wstore_canonical_shop",
          shopDomain: "canonical-shop.myshopify.com",
          installationGeneration: "sgen_one",
        },
      },
    } as any);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { shop: { myshopifyDomain: "attacker.myshopify.com" } },
      }),
    } as Response);

    await expect(
      resolveShopifyStoreByDomain("legacy-alias.myshopify.com"),
    ).resolves.toBeNull();
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(prisma.installedIntegration.update).not.toHaveBeenCalled();
  });

  it("1.3c: rejects a credential-only alias with a malformed token binding", async () => {
    vi.mocked(prisma.installedIntegration.findFirst).mockResolvedValueOnce({
      id: "integration_invalid_alias_hash",
      credentials: {
        shop: "invalid-hash-alias.myshopify.com",
        scope: "write_discounts",
        accessToken: encryptedToken,
        shopVerificationTokenHash: "not-a-valid-hash",
      },
      updatedAt: new Date("2026-08-28T00:00:00.000Z"),
      project: {
        id: workspaceId,
        shopifyStoreId: "canonical-shop.myshopify.com",
        defaultProgramId: programId,
        weleticShopifyStore: {
          id: "wstore_canonical_shop",
          shopDomain: "canonical-shop.myshopify.com",
          installationGeneration: "sgen_one",
        },
      },
    } as any);

    await expect(
      resolveShopifyStoreByDomain("invalid-hash-alias.myshopify.com"),
    ).resolves.toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("1.3e: rejects a credential from an older immutable installation generation", async () => {
    vi.mocked(prisma.installedIntegration.findFirst).mockResolvedValueOnce({
      id: "integration_stale_generation",
      projectId: workspaceId,
      credentials: {
        shop: "stale-generation.myshopify.com",
        scope: "write_discounts",
        accessToken: encryptedToken,
        shopVerifiedAt: "2026-08-28T00:00:00.000Z",
        shopVerificationTokenHash:
          shopifyCredentialVerificationHash(testAccessToken),
        installationGeneration: "sgen_old",
      },
      project: {
        id: workspaceId,
        shopifyStoreId: "stale-generation.myshopify.com",
        defaultProgramId: programId,
        weleticShopifyStore: {
          id: "wstore_stale_generation",
          shopDomain: "stale-generation.myshopify.com",
          installationGeneration: "sgen_new",
        },
      },
    } as any);

    await expect(
      resolveShopifyStoreByDomain("stale-generation.myshopify.com"),
    ).resolves.toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(prisma.installedIntegration.update).not.toHaveBeenCalled();
  });

  it("1.3d: never combines a rejected workspace alias with another shop's valid session", async () => {
    vi.mocked(prisma.installedIntegration.findFirst).mockResolvedValueOnce({
      id: "integration_cross_workspace_alias",
      credentials: {
        shop: "session-backed-alias.myshopify.com",
        scope: "write_discounts",
        accessToken: encryptedToken,
      },
      updatedAt: new Date("2026-08-28T00:00:00.000Z"),
      project: {
        id: "workspace_wrong_alias_owner",
        shopifyStoreId: "wrong-owner.myshopify.com",
        defaultProgramId: "program_wrong_alias_owner",
        weleticShopifyStore: {
          id: "wstore_wrong_alias_owner",
          shopDomain: "wrong-owner.myshopify.com",
          installationGeneration: "sgen_one",
        },
      },
    } as any);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { shop: { myshopifyDomain: "wrong-owner.myshopify.com" } },
      }),
    } as Response);
    vi.mocked(prisma.weleticShopifyAppSession.findFirst).mockResolvedValueOnce({
      id: "offline_session-backed-alias.myshopify.com",
      shop: "session-backed-alias.myshopify.com",
      payload: encrypt(
        JSON.stringify([["accessToken", "shpat_valid_other_workspace"]]),
      ),
    } as any);

    await expect(
      resolveShopifyStoreByDomain("session-backed-alias.myshopify.com"),
    ).resolves.toBeNull();
    expect(prisma.weleticShopifyAppSession.findFirst).not.toHaveBeenCalled();
  });

  it("1.4: returns null safely when shop domain is unknown or not connected", async () => {
    const result = await resolveShopifyStoreByDomain(
      "unknown-unconnected-store.myshopify.com",
    );
    expect(result).toBeNull();
    expect(prisma.installedIntegration.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          credentials: {
            path: "$.shop",
            equals: "unknown-unconnected-store.myshopify.com",
          },
        }),
      }),
    );
  });

  it("1.5: resolves the exact workspace through its encrypted offline app session", async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValueOnce({
      id: workspaceId,
      shopifyStoreId: "session-shop.myshopify.com",
      defaultProgramId: programId,
      installedIntegrations: [],
      weleticShopifyStore: {
        id: "wstore_session",
        shopDomain: "session-shop.myshopify.com",
        installationGeneration: "sgen_one",
      },
    } as any);
    vi.mocked(prisma.weleticShopifyAppSession.findFirst).mockResolvedValueOnce({
      shop: "session-shop.myshopify.com",
      payload: encrypt(
        JSON.stringify([
          ["accessToken", testAccessToken],
          ["scope", "read_products,write_discounts"],
        ]),
      ),
    } as any);

    const result = await resolveShopifyStoreByDomain(
      "session-shop.myshopify.com",
    );

    expect(result).toMatchObject({
      workspaceId,
      storeId: "wstore_session",
      myshopifyDomain: "session-shop.myshopify.com",
      accessToken: testAccessToken,
    });
    expect(prisma.weleticShopifyAppSession.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isOnline: false,
          shop: "session-shop.myshopify.com",
        }),
      }),
    );
  });

  it("1.6: verifies and binds a legacy credential without a shop domain", async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValueOnce({
      id: workspaceId,
      shopifyStoreId: "legacy-unbound.myshopify.com",
      defaultProgramId: programId,
      installedIntegrations: [
        {
          id: "integration_legacy_unbound",
          credentials: {
            scope: "read_products,write_discounts",
            accessToken: encryptedToken,
          },
        },
      ],
      weleticShopifyStore: {
        id: "wstore_legacy_unbound",
        shopDomain: "legacy-unbound.myshopify.com",
        installationGeneration: "sgen_one",
      },
    } as any);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          shop: {
            myshopifyDomain: "legacy-unbound.myshopify.com",
            currencyCode: "USD",
          },
        },
      }),
    } as Response);
    vi.mocked(prisma.installedIntegration.findUnique).mockResolvedValueOnce({
      id: "integration_legacy_unbound",
      projectId: workspaceId,
      credentials: {
        scope: "read_products,write_discounts",
        accessToken: encryptedToken,
      },
    } as any);

    const result = await resolveShopifyStoreByDomain(
      "legacy-unbound.myshopify.com",
    );

    expect(result?.accessToken).toBe(testAccessToken);
    expect(prisma.installedIntegration.update).toHaveBeenCalledWith({
      where: { id: "integration_legacy_unbound" },
      data: {
        credentials: expect.objectContaining({
          shop: "legacy-unbound.myshopify.com",
          installationGeneration: "sgen_one",
          shopVerificationTokenHash:
            shopifyCredentialVerificationHash(testAccessToken),
        }),
      },
    });
  });

  it("1.7: rejects an unbound project credential verified for another shop", async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValueOnce({
      id: workspaceId,
      shopifyStoreId: "unbound-cross-tenant.myshopify.com",
      defaultProgramId: programId,
      installedIntegrations: [
        {
          id: "integration_unbound_cross_tenant",
          credentials: {
            scope: "write_discounts",
            accessToken: encryptedToken,
          },
        },
      ],
      weleticShopifyStore: {
        id: "wstore_unbound_cross_tenant",
        shopDomain: "unbound-cross-tenant.myshopify.com",
        installationGeneration: "sgen_one",
      },
    } as any);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { shop: { myshopifyDomain: "attacker.myshopify.com" } },
      }),
    } as Response);

    await expect(
      resolveShopifyStoreByDomain("unbound-cross-tenant.myshopify.com"),
    ).resolves.toBeNull();
    expect(prisma.installedIntegration.update).not.toHaveBeenCalled();
  });

  it("1.8: rejects a token whose live Shopify identity does not match", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { shop: { myshopifyDomain: "other-shop.myshopify.com" } },
      }),
    } as Response);

    await expect(
      verifyShopifyAccessTokenForDomain({
        shopDomain: "expected-shop.myshopify.com",
        accessToken: testAccessToken,
        customFetch: mockFetch,
      }),
    ).resolves.toBe(false);
  });

  it("1.9: rejects a corrupt offline-session alias belonging to another shop", async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValueOnce({
      id: workspaceId,
      shopifyStoreId: "expected-session.myshopify.com",
      defaultProgramId: programId,
      installedIntegrations: [],
      weleticShopifyStore: {
        id: "wstore_expected_session",
        shopDomain: "expected-session.myshopify.com",
        installationGeneration: "sgen_one",
      },
    } as any);
    vi.mocked(prisma.weleticShopifyAppSession.findFirst).mockResolvedValueOnce({
      id: "offline_expected-session",
      shop: "other-session.myshopify.com",
      payload: encrypt(
        JSON.stringify([["accessToken", "shpat_other_tenant_token"]]),
      ),
    } as any);

    await expect(
      resolveShopifyStoreByDomain("expected-session.myshopify.com"),
    ).resolves.toBeNull();
  });

  it("1.10: preserves a concurrently rotated OAuth token during legacy binding", async () => {
    const rotatedToken = "shpat_rotated_token_67890";
    const encryptedRotatedToken = encrypt(rotatedToken);
    vi.mocked(prisma.project.findFirst).mockResolvedValueOnce({
      id: workspaceId,
      shopifyStoreId: "rotated-token.myshopify.com",
      defaultProgramId: programId,
      installedIntegrations: [
        {
          id: "integration_rotated_token",
          credentials: { accessToken: encryptedToken, scope: "read_products" },
        },
      ],
      weleticShopifyStore: {
        id: "wstore_rotated_token",
        shopDomain: "rotated-token.myshopify.com",
        installationGeneration: "sgen_one",
      },
    } as any);
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            shop: {
              myshopifyDomain: "rotated-token.myshopify.com",
              currencyCode: "USD",
            },
          },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            shop: {
              myshopifyDomain: "rotated-token.myshopify.com",
              currencyCode: "USD",
            },
          },
        }),
      } as Response);
    vi.mocked(prisma.installedIntegration.findUnique)
      .mockResolvedValueOnce({
        id: "integration_rotated_token",
        projectId: workspaceId,
        credentials: {
          accessToken: encryptedRotatedToken,
          scope: "read_products,write_discounts",
        },
      } as any)
      .mockResolvedValueOnce({
        id: "integration_rotated_token",
        projectId: workspaceId,
        credentials: {
          accessToken: encryptedRotatedToken,
          scope: "read_products,write_discounts",
        },
      } as any);

    const result = await resolveShopifyStoreByDomain(
      "rotated-token.myshopify.com",
    );

    expect(result?.accessToken).toBe(rotatedToken);
    expect(prisma.installedIntegration.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          credentials: expect.objectContaining({
            accessToken: encryptedRotatedToken,
            shop: "rotated-token.myshopify.com",
            installationGeneration: "sgen_one",
          }),
        },
      }),
    );
  });

  it("1.11: re-reads a same-generation token rotation instead of using process-local cache", async () => {
    const domain = "cache-rotation.myshopify.com";
    const newerToken = "shpat_cache_rotation_newer_token";
    const encryptedNewerToken = encrypt(newerToken);
    const currentGeneration = "sgen_cache_one";
    let currentEncryptedToken = encryptedToken;
    let currentToken = testAccessToken;
    invalidateShopifyStoreDomainCache([domain]);

    const currentCredentials = () => ({
      shop: domain,
      scope: "read_products,write_discounts",
      accessToken: currentEncryptedToken,
      shopVerifiedAt: "2026-08-30T00:00:00.000Z",
      shopVerificationTokenHash:
        shopifyCredentialVerificationHash(currentToken),
      installationGeneration: currentGeneration,
    });
    (prisma.project.findUnique as any).mockImplementation(
      async () =>
        ({
          id: workspaceId,
          shopifyStoreId: domain,
          defaultProgramId: programId,
          installedIntegrations: [
            {
              id: "integration_cache_rotation",
              credentials: currentCredentials(),
            },
          ],
          weleticShopifyStore: {
            id: "wstore_cache_rotation",
            shopDomain: domain,
            installationGeneration: currentGeneration,
          },
        }) as any,
    );
    (prisma.installedIntegration.findUnique as any).mockImplementation(
      async () =>
        ({
          id: "integration_cache_rotation",
          projectId: workspaceId,
          credentials: currentCredentials(),
        }) as any,
    );
    (prisma.$queryRaw as any).mockImplementation(
      async () =>
        [
          {
            id: "wstore_cache_rotation",
            projectId: workspaceId,
            installationGeneration: currentGeneration,
          },
        ] as any,
    );

    const first = await resolveShopifyStoreByDomain(domain);
    expect(first?.accessToken).toBe(testAccessToken);

    currentEncryptedToken = encryptedNewerToken;
    currentToken = newerToken;

    const second = await resolveShopifyStoreByDomain(domain);

    expect(second?.accessToken).toBe(newerToken);
    expect(prisma.weleticShopifyStore.findUnique).not.toHaveBeenCalled();
    expect(prisma.project.findUnique).toHaveBeenCalledTimes(2);
    expect(prisma.installedIntegration.findUnique).toHaveBeenCalledTimes(2);
    expect(mockFetch).not.toHaveBeenCalled();
    invalidateShopifyStoreDomainCache([domain]);
  });
});
