import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { DubApiError } from "@/lib/api/errors";
import { prisma } from "@/lib/prisma";
import { ShopifyCredentialUnavailableError } from "@/lib/weletic/shopify/credential-errors";
import { readShopifyCredentialSource } from "@/lib/weletic/shopify/credential-source";
import { getWeleticShopifyInstallation } from "@/lib/weletic/shopify/get-installation";
import {
  canonicalizeShopifyDomain,
  normalizeShopDomain,
  readShopifyCredentialTokenHash,
  resolveShopifyStoreByDomain,
} from "@/lib/weletic/shopify/store-resolver";
import { Prisma } from "@prisma/client";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    project: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findFirst: vi.fn(),
    },
    weleticShopifyStore: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    installedIntegration: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    weleticShopifyAppSession: {
      findFirst: vi.fn(),
    },
    $transaction: vi.fn(async (cb) => {
      if (typeof cb === "function") {
        return await cb(prisma);
      }
      return cb;
    }),
    $queryRaw: vi.fn(),
  },
}));

vi.mock("@/lib/weletic/shopify/credential-source", () => ({
  readShopifyCredentialSource: vi.fn(),
}));

vi.mock("@/lib/weletic/shopify/legacy-connection-fence", () => ({
  lockLegacyShopifyConnection: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/weletic/shopify/session-coordination", () => ({
  advanceLegacyShopifySessionRevision: vi.fn().mockResolvedValue(undefined),
}));

describe("Milestone 4 Adversarial Schema Decoupling & Query Boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // 1. DMMF SCHEMA DECOUPLING & ISOLATION INVARIANTS
  // =========================================================================
  describe("1. Prisma DMMF Decoupling Invariants", () => {
    it("guarantees Dub upstream models contain zero references to Weletic models", () => {
      const models = Prisma.dmmf.datamodel.models;
      const dubCoreModels = [
        "Project",
        "Program",
        "Payout",
        "Commission",
        "Link",
        "Partner",
        "Customer",
        "Reward",
      ];

      for (const modelName of dubCoreModels) {
        const model = models.find((m) => m.name === modelName);
        expect(model, `Expected model ${modelName} to exist in DMMF`).toBeDefined();

        const weleticFields = model!.fields.filter((f) =>
          f.name.toLowerCase().includes("weletic") ||
          f.type.toLowerCase().includes("weletic"),
        );
        expect(
          weleticFields,
          `Model ${modelName} contains un-decoupled Weletic references: ${weleticFields.map((f) => f.name).join(", ")}`,
        ).toHaveLength(0);
      }
    });

    it("guarantees Weletic models have zero Prisma relational fields to Dub core models", () => {
      const models = Prisma.dmmf.datamodel.models;
      const dubModelTypes = new Set([
        "Project",
        "Program",
        "Partner",
        "Link",
        "Payout",
        "Commission",
        "User",
        "Invoice",
      ]);

      const weleticModels = models.filter((m) => m.name.startsWith("Weletic"));
      expect(weleticModels.length).toBeGreaterThan(10);

      const crossRelations: Array<{ model: string; field: string; type: string }> = [];
      for (const m of weleticModels) {
        for (const f of m.fields) {
          if (dubModelTypes.has(f.type)) {
            crossRelations.push({ model: m.name, field: f.name, type: f.type });
          }
        }
      }

      expect(
        crossRelations,
        `Found direct Prisma relations from Weletic to Dub models: ${JSON.stringify(crossRelations)}`,
      ).toHaveLength(0);
    });

    it("verifies Weletic models retain indexed scalar foreign keys for Dub references", () => {
      const models = Prisma.dmmf.datamodel.models;

      // WeleticShopifyStore should have scalar projectId & programId
      const storeModel = models.find((m) => m.name === "WeleticShopifyStore")!;
      const storeFieldNames = storeModel.fields.map((f) => f.name);
      expect(storeFieldNames).toContain("projectId");
      expect(storeFieldNames).toContain("programId");

      // WeleticProductLink should have scalar programId, partnerId, linkId
      const prodLinkModel = models.find((m) => m.name === "WeleticProductLink")!;
      const prodLinkFieldNames = prodLinkModel.fields.map((f) => f.name);
      expect(prodLinkFieldNames).toContain("programId");
      expect(prodLinkFieldNames).toContain("partnerId");
      expect(prodLinkFieldNames).toContain("linkId");

      // WeleticPayoutQuote should have scalar payoutId
      const quoteModel = models.find((m) => m.name === "WeleticPayoutQuote")!;
      expect(quoteModel.fields.map((f) => f.name)).toContain("payoutId");
    });
  });

  // =========================================================================
  // 2. getWeleticShopifyInstallation ADVERSARIAL MATRIX
  // =========================================================================
  describe("2. getWeleticShopifyInstallation Adversarial Matrix", () => {
    const workspaceId = "ws_test_adversarial_1";

    it("throws when workspace record does not exist in Project", async () => {
      vi.mocked(prisma.project.findUniqueOrThrow).mockRejectedValueOnce(
        new Error("Record to update not found."),
      );
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce(null);

      await expect(getWeleticShopifyInstallation(workspaceId)).rejects.toThrow(
        "Record to update not found.",
      );
    });

    it("throws DubApiError 400 when store record is missing and installedIntegrations is empty", async () => {
      vi.mocked(prisma.project.findUniqueOrThrow).mockResolvedValueOnce({
        id: workspaceId,
        shopifyStoreId: "mystore.myshopify.com",
        defaultProgramId: "prog_123",
        installedIntegrations: [],
      } as any);
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce(null);

      await expect(getWeleticShopifyInstallation(workspaceId)).rejects.toThrow(
        new DubApiError({
          code: "bad_request",
          message: "The Shopify installation is missing for this workspace.",
        }),
      );
    });

    it("throws DubApiError 400 when store record is missing and installation credentials lacks accessToken", async () => {
      vi.mocked(prisma.project.findUniqueOrThrow).mockResolvedValueOnce({
        id: workspaceId,
        shopifyStoreId: "mystore.myshopify.com",
        defaultProgramId: "prog_123",
        installedIntegrations: [
          {
            credentials: {
              shop: "mystore.myshopify.com",
              accessToken: "",
              scope: "read_products,read_markets,read_orders,read_translations,read_customers",
            },
          },
        ],
      } as any);
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce(null);

      await expect(getWeleticShopifyInstallation(workspaceId)).rejects.toThrow(
        new DubApiError({
          code: "bad_request",
          message: "The Shopify installation has no access token.",
        }),
      );
    });

    it("throws DubApiError 400 when shop domain cannot be determined from credentials or project", async () => {
      vi.mocked(prisma.project.findUniqueOrThrow).mockResolvedValueOnce({
        id: workspaceId,
        shopifyStoreId: null,
        defaultProgramId: "prog_123",
        installedIntegrations: [
          {
            credentials: {
              shop: "",
              accessToken: "shpat_dummy_token",
              scope: "read_products,read_markets,read_orders,read_translations,read_customers",
            },
          },
        ],
      } as any);
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce(null);

      await expect(getWeleticShopifyInstallation(workspaceId)).rejects.toThrow(
        new DubApiError({
          code: "bad_request",
          message: "Connect Shopify and create a default partner program first.",
        }),
      );
    });

    it("throws DubApiError 400 when project lacks defaultProgramId", async () => {
      vi.mocked(prisma.project.findUniqueOrThrow).mockResolvedValueOnce({
        id: workspaceId,
        shopifyStoreId: "store.myshopify.com",
        defaultProgramId: null, // missing defaultProgramId
        installedIntegrations: [
          {
            credentials: {
              shop: "store.myshopify.com",
              accessToken: "shpat_dummy_token",
              scope: "read_products,read_markets,read_orders,read_translations,read_customers",
            },
          },
        ],
      } as any);
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce(null);

      await expect(getWeleticShopifyInstallation(workspaceId)).rejects.toThrow(
        new DubApiError({
          code: "bad_request",
          message: "Connect Shopify and create a default partner program first.",
        }),
      );
    });

    it("throws DubApiError 403 when required scopes are missing", async () => {
      vi.mocked(prisma.project.findUniqueOrThrow).mockResolvedValueOnce({
        id: workspaceId,
        shopifyStoreId: "store.myshopify.com",
        defaultProgramId: "prog_123",
        installedIntegrations: [
          {
            credentials: {
              shop: "store.myshopify.com",
              accessToken: "shpat_dummy_token",
              scope: "read_products,read_markets", // missing read_orders, read_translations, read_customers
            },
          },
        ],
      } as any);
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce(null);

      await expect(getWeleticShopifyInstallation(workspaceId)).rejects.toThrow(
        /Reinstall the Shopify app with scopes:/,
      );
    });

    it("accepts write equivalent scopes in lieu of read scopes", async () => {
      vi.mocked(prisma.project.findUniqueOrThrow).mockResolvedValueOnce({
        id: workspaceId,
        shopifyStoreId: "store.myshopify.com",
        defaultProgramId: "prog_123",
        installedIntegrations: [
          {
            credentials: {
              shop: "store.myshopify.com",
              accessToken: "shpat_test_pass",
              scope: "write_products,write_markets,write_orders,write_translations,write_customers",
            },
          },
        ],
      } as any);
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce(null);

      const installation = await getWeleticShopifyInstallation(workspaceId);
      expect(installation).toEqual({
        workspaceId,
        programId: "prog_123",
        shopDomain: "store.myshopify.com",
        accessToken: "shpat_test_pass",
        installationGeneration: null,
      });
    });

    it("handles ShopifyCredentialUnavailableError from native credential source cleanly", async () => {
      vi.mocked(prisma.project.findUniqueOrThrow).mockResolvedValueOnce({
        id: workspaceId,
        shopifyStoreId: "store.myshopify.com",
        defaultProgramId: "prog_123",
        installedIntegrations: [],
      } as any);
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce({
        id: "store_db_id",
        shopDomain: "store.myshopify.com",
        installationGeneration: "gen_1",
      } as any);

      vi.mocked(readShopifyCredentialSource).mockRejectedValueOnce(
        new ShopifyCredentialUnavailableError("Token expired"),
      );

      await expect(getWeleticShopifyInstallation(workspaceId)).rejects.toThrow(
        new DubApiError({
          code: "bad_request",
          message: "Reconnect the Shopify app before accessing this store.",
        }),
      );
    });

    it("succeeds with native credential source when store and credentials are active", async () => {
      vi.mocked(prisma.project.findUniqueOrThrow).mockResolvedValueOnce({
        id: workspaceId,
        shopifyStoreId: "store.myshopify.com",
        defaultProgramId: "prog_123",
        installedIntegrations: [],
      } as any);
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce({
        id: "store_db_id",
        shopDomain: "store.myshopify.com",
        installationGeneration: "gen_42",
      } as any);

      vi.mocked(readShopifyCredentialSource).mockResolvedValueOnce({
        source: "native",
        accessToken: "shpat_native_active_token",
        scope: "read_products,read_markets,read_orders,read_translations,read_customers",
        installationGeneration: "gen_42",
      } as any);

      const result = await getWeleticShopifyInstallation(workspaceId);
      expect(result).toEqual({
        workspaceId,
        programId: "prog_123",
        shopDomain: "store.myshopify.com",
        accessToken: "shpat_native_active_token",
        installationGeneration: "gen_42",
      });
    });
  });

  // =========================================================================
  // 3. store-resolver.ts ADVERSARIAL MATRIX
  // =========================================================================
  describe("3. resolveShopifyStoreByDomain Adversarial Matrix", () => {
    it("returns null on empty, blank, or malformed domain inputs", async () => {
      expect(await resolveShopifyStoreByDomain("")).toBeNull();
      expect(await resolveShopifyStoreByDomain("   ")).toBeNull();
      expect(await resolveShopifyStoreByDomain(null as any)).toBeNull();
      expect(await resolveShopifyStoreByDomain(undefined as any)).toBeNull();
    });

    it("normalizes protocol, casing, and trailing slashes correctly", async () => {
      expect(normalizeShopDomain("https://My-Store.myshopify.com/admin/settings")).toBe(
        "my-store.myshopify.com",
      );
      expect(canonicalizeShopifyDomain("HTTP://TEST-STORE.myshopify.com/")).toBe(
        "test-store.myshopify.com",
      );
      expect(canonicalizeShopifyDomain("not-a-myshopify-domain.com")).toBeNull();
    });

    it("returns null gracefully when store record exists but project record is missing (orphaned store)", async () => {
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce({
        id: "store_orphan",
        projectId: "ws_deleted_project",
        shopDomain: "orphan.myshopify.com",
        installationGeneration: "gen_1",
      } as any);
      vi.mocked(prisma.project.findUnique).mockResolvedValueOnce(null);
      vi.mocked(prisma.project.findFirst).mockResolvedValueOnce(null);

      const result = await resolveShopifyStoreByDomain("orphan.myshopify.com");
      expect(result).toBeNull();
    });

    it("returns null when project record exists but defaultProgramId is missing", async () => {
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce({
        id: "store_no_prog",
        projectId: "ws_no_prog",
        shopDomain: "noprog.myshopify.com",
        installationGeneration: "gen_1",
      } as any);
      vi.mocked(prisma.project.findUnique).mockResolvedValueOnce({
        id: "ws_no_prog",
        shopifyStoreId: "noprog.myshopify.com",
        defaultProgramId: null, // missing!
        installedIntegrations: [],
      } as any);

      const result = await resolveShopifyStoreByDomain("noprog.myshopify.com");
      expect(result).toBeNull();
    });

    it("blocks impersonation: returns null when queried domain does not match native store shopDomain", async () => {
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce(null);
      // Project found by shopifyStoreId
      vi.mocked(prisma.project.findUnique).mockResolvedValueOnce({
        id: "ws_spoof",
        shopifyStoreId: "victim.myshopify.com",
        defaultProgramId: "prog_spoof",
        installedIntegrations: [],
      } as any);
      // But weleticShopifyStore for this project has a different shopDomain
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce({
        id: "store_legit",
        projectId: "ws_spoof",
        shopDomain: "attacker.myshopify.com",
        installationGeneration: "gen_1",
      } as any);
      vi.mocked(readShopifyCredentialSource).mockResolvedValueOnce({
        source: "native",
        accessToken: "shpat_attacker_token",
      } as any);

      const result = await resolveShopifyStoreByDomain("victim.myshopify.com");
      expect(result).toBeNull();
    });

    it("resolves store cleanly with native credentials when domain matches", async () => {
      const shopDomain = "yamax-prod.myshopify.com";
      const projectId = "ws_yamax_1";
      const programId = "prog_yamax_1";

      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce({
        id: "store_yamax",
        projectId,
        shopDomain,
        installationGeneration: "gen_active",
      } as any);
      vi.mocked(prisma.project.findUnique).mockResolvedValueOnce({
        id: projectId,
        shopifyStoreId: shopDomain,
        defaultProgramId: programId,
        installedIntegrations: [],
      } as any);

      vi.mocked(readShopifyCredentialSource).mockResolvedValueOnce({
        source: "native",
        accessToken: "shpat_yamax_valid_access_token",
      } as any);

      const result = await resolveShopifyStoreByDomain(shopDomain);
      expect(result).not.toBeNull();
      expect(result?.shopId).toBe(`shop_${projectId}`);
      expect(result?.primaryDomain).toBe(shopDomain);
      expect(result?.myshopifyDomain).toBe(shopDomain);
      expect(result?.workspaceId).toBe(projectId);
      expect(result?.programId).toBe(programId);
      expect(result?.accessToken).toBe("shpat_yamax_valid_access_token");
      expect(result?.storeId).toBe("store_yamax");
    });

    it("returns null when exact integration credentials cannot be bound or verified", async () => {
      const domain = "unverified.myshopify.com";
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce(null);
      vi.mocked(prisma.project.findUnique).mockResolvedValueOnce({
        id: "ws_unverified",
        shopifyStoreId: domain,
        defaultProgramId: "prog_unverified",
        installedIntegrations: [
          {
            id: "inst_1",
            credentials: { accessToken: "shpat_raw_invalid" },
            updatedAt: new Date(),
          },
        ],
      } as any);
      // Matching store for project
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce({
        id: "store_unverified",
        projectId: "ws_unverified",
        shopDomain: domain,
        installationGeneration: "gen_unverified",
      } as any);

      vi.mocked(readShopifyCredentialSource).mockResolvedValueOnce({
        source: "legacy",
      } as any);

      // Raw transaction query fails verification
      vi.mocked(prisma.$transaction).mockResolvedValueOnce(null);

      const result = await resolveShopifyStoreByDomain(domain);
      expect(result).toBeNull();
    });

    it("correctly hashes credentials token for optimistic concurrency CAS checks", () => {
      const hash1 = readShopifyCredentialTokenHash({
        accessToken: "shpat_deterministic_test_12345",
      });
      const hash2 = readShopifyCredentialTokenHash({
        accessToken: "shpat_deterministic_test_12345",
      });
      expect(hash1).toBeDefined();
      expect(hash1).toEqual(hash2);

      const hashNull = readShopifyCredentialTokenHash({});
      expect(hashNull).toBeNull();
    });
  });
});
