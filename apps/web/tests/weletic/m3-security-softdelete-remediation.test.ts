import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: vi.fn(),
}));

const state = vi.hoisted(() => ({
  scopes: "integrations.read",
  isMachine: true,
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(
    async () => new Headers({ Authorization: "Bearer dub_testkey" }),
  ),
}));

vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));

vi.mock("@/lib/axiom/server", () => ({
  withAxiomBodyLog: (handler: any) => handler,
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    flush: vi.fn(async () => {}),
  },
  toErrorFields: (e: unknown) => ({ message: String(e) }),
}));

vi.mock("@/lib/api-logs/capture-request-log", () => ({
  captureRequestLog: vi.fn(async () => {}),
}));

vi.mock("@/lib/edge-config", () => ({
  getFeatureFlags: vi.fn(async () => ({})),
}));

vi.mock("@/lib/auth/token-cache", () => ({
  tokenCache: { get: vi.fn(async () => null), set: vi.fn(async () => {}) },
}));

vi.mock("@/lib/upstash", () => ({
  ratelimit: () => ({ limit: vi.fn(async () => ({ success: false })) }),
  redis: {},
}));

const prismaMocks = vi.hoisted(() => ({
  discountCodeFindFirst: vi.fn(),
  discountCodeFindUnique: vi.fn(),
  discountCodeFindMany: vi.fn(),
  discountCodeUpdate: vi.fn(),
  discountCodeUpdateMany: vi.fn(),
  discountCodeCreate: vi.fn(),
  discountCodeDelete: vi.fn(),
  discountCodeCount: vi.fn(),
  linkFindUnique: vi.fn(),
  linkFindUniqueOrThrow: vi.fn(),
  linkFindMany: vi.fn(),
  linkDelete: vi.fn(),
  linkDeleteMany: vi.fn(),
  projectFindUnique: vi.fn(),
  projectFindFirst: vi.fn(),
  projectUpdate: vi.fn(),
  programFindUnique: vi.fn(),
  programFindUniqueOrThrow: vi.fn(),
  programEnrollmentFindMany: vi.fn(),
  discountFindUnique: vi.fn(),
  discountDeleteMany: vi.fn(),
  weleticShopifyStoreFindUnique: vi.fn(),
  weleticShopifyStoreFindFirst: vi.fn(),
  weleticShopifyStoreFindMany: vi.fn(),
  restrictedTokenFindUnique: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    discountCode: {
      findFirst: prismaMocks.discountCodeFindFirst,
      findUnique: prismaMocks.discountCodeFindUnique,
      findMany: prismaMocks.discountCodeFindMany,
      update: prismaMocks.discountCodeUpdate,
      updateMany: prismaMocks.discountCodeUpdateMany,
      create: prismaMocks.discountCodeCreate,
      delete: prismaMocks.discountCodeDelete,
      count: prismaMocks.discountCodeCount,
    },
    link: {
      findUnique: prismaMocks.linkFindUnique,
      findUniqueOrThrow: prismaMocks.linkFindUniqueOrThrow,
      findMany: prismaMocks.linkFindMany,
      delete: prismaMocks.linkDelete,
      deleteMany: prismaMocks.linkDeleteMany,
    },
    project: {
      findUnique: prismaMocks.projectFindUnique,
      findFirst: prismaMocks.projectFindFirst,
      update: prismaMocks.projectUpdate,
    },
    program: {
      findUnique: prismaMocks.programFindUnique,
      findUniqueOrThrow: prismaMocks.programFindUniqueOrThrow,
    },
    programEnrollment: {
      findMany: prismaMocks.programEnrollmentFindMany,
    },
    discount: {
      findUnique: prismaMocks.discountFindUnique,
      deleteMany: prismaMocks.discountDeleteMany,
    },
    weleticShopifyStore: {
      findUnique: prismaMocks.weleticShopifyStoreFindUnique,
      findFirst: prismaMocks.weleticShopifyStoreFindFirst,
      findMany: prismaMocks.weleticShopifyStoreFindMany,
    },
    restrictedToken: {
      findUnique: prismaMocks.restrictedTokenFindUnique,
      update: vi.fn(async () => ({})),
    },
    $transaction: prismaMocks.transaction,
  },
}));

vi.mock("@/lib/cron/enqueue-batch-jobs", () => ({
  enqueueBatchJobs: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/weletic/shopify/credential-source", () => ({
  readShopifyCredentialSource: vi.fn(async () => ({
    source: "native",
    accessToken: "shpat_test_token_123",
  })),
}));

vi.mock("@/lib/tinybird", () => ({
  recordLink: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/storage", () => ({
  storage: {
    delete: vi.fn().mockResolvedValue(undefined),
    getSignedDownloadUrl: vi.fn().mockResolvedValue("https://signed.test/file"),
  },
}));

vi.mock("@/lib/api/links/cache", () => ({
  linkCache: {
    delete: vi.fn().mockResolvedValue(undefined),
    deleteMany: vi.fn().mockResolvedValue(undefined),
    expireMany: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/lib/discounts/discount-provider", () => ({
  getDiscountProvider: vi.fn(() => ({
    createDiscountCode: vi.fn().mockResolvedValue({ code: "DISCOUNT10" }),
    disableDiscountCode: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { bulkDeleteLinks } from "@/lib/api/links/bulk-delete-links";
import { deleteLink } from "@/lib/api/links/delete-link";
import { withWorkspace } from "@/lib/auth/workspace";
import { workspaceAuthCache } from "@/lib/auth/workspace-cache";
import { deleteDiscountCodes } from "@/lib/discounts/delete-discount-code";
import { registerWeleticPermissions } from "@/lib/weletic/rbac/register";
import { resolveShopifyStoreByDomain } from "@/lib/weletic/shopify/store-resolver";
import * as fs from "fs";
import * as path from "path";

describe("Worker M3: Multi-Tenant, Security Scopes & Soft-Delete Invariants", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaceAuthCache.clear();
    registerWeleticPermissions();

    prismaMocks.restrictedTokenFindUnique.mockImplementation(async () => ({
      id: "tok_m3",
      expires: null,
      scopes: state.scopes,
      projectId: "ws_m3",
      installationId: null,
      project: { plan: "business", trialEndsAt: null },
      user: {
        id: "user_machine_m3",
        name: "M3 Machine User",
        email: "m3@weletic.internal",
        isMachine: state.isMachine,
      },
    }));

    prismaMocks.projectFindUnique.mockImplementation(async () => ({
      id: "ws_m3",
      slug: "weletic-test",
      plan: "business",
      users: [
        { role: "owner", defaultFolderId: null, workspacePreferences: null },
      ],
    }));

    prismaMocks.transaction.mockImplementation(async (arg: any) => {
      if (typeof arg === "function") {
        return arg({
          discountCode: {
            updateMany: prismaMocks.discountCodeUpdateMany,
            delete: prismaMocks.discountCodeDelete,
          },
          link: {
            delete: prismaMocks.linkDelete,
            deleteMany: prismaMocks.linkDeleteMany,
          },
          project: {
            update: prismaMocks.projectUpdate,
          },
          $queryRaw: vi.fn(async () => []),
        });
      }
      return Promise.all(arg);
    });
  });

  // =========================================================================
  // 1. DiscountCode Soft-Delete Coherence & Reuse
  // =========================================================================
  describe("1. DiscountCode Soft-Delete Coherence & Reuse", () => {
    it("1.1: findFreeSuffixedCode includes disabledAt: null so soft-deleted codes can be reused", async () => {
      // Import createDiscountCode dynamically to exercise findFreeSuffixedCode
      const { createDiscountCode } = await import(
        "@/lib/discounts/create-discount-code"
      );

      // Setup: Link has no active code
      prismaMocks.discountCodeFindFirst.mockImplementation(
        async ({ where }: any) => {
          // First call checks activeCodeOnLink: { linkId: 'link_1', disabledAt: null }
          if (where.linkId === "link_1") return null;

          // Second call checks existingDisabledCode for candidate
          // Simulate: "PARTNER2" has a soft-deleted code for the SAME partner
          if (
            where.code === "PARTNER2" &&
            where.disabledAt?.not !== undefined
          ) {
            return {
              id: "dc_disabled_same_partner",
              code: "PARTNER2",
              programId: "prog_1",
              partnerId: "partner_1",
              disabledAt: new Date("2026-08-01"),
            };
          }

          // Candidate checks: where: { programId, code: variant, disabledAt: null }
          // If checking for active code, PARTNER2 has NO active code (disabledAt is not null)
          if (where.code === "PARTNER2" && where.disabledAt === null) {
            return null; // Not taken!
          }

          return null;
        },
      );

      prismaMocks.discountCodeUpdate.mockResolvedValueOnce({
        id: "dc_disabled_same_partner",
        code: "PARTNER2",
        disabledAt: null,
      });

      const result = await createDiscountCode({
        workspace: { id: "ws_1" } as any,
        partner: { id: "partner_1", name: "Partner" },
        link: { id: "link_1" },
        discount: {
          id: "disc_1",
          programId: "prog_1",
          provider: "shopify",
        } as any,
        code: "PARTNER2",
      });

      // Reactivated in-place with disabledAt: null
      expect(prismaMocks.discountCodeUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "dc_disabled_same_partner" },
          data: expect.objectContaining({
            disabledAt: null,
            linkId: "link_1",
          }),
        }),
      );
      expect(result.disabledAt).toBeNull();
    });

    it("1.2: Rejects when active discount code already exists on the link (disabledAt === null)", async () => {
      const { createDiscountCode } = await import(
        "@/lib/discounts/create-discount-code"
      );

      prismaMocks.discountCodeFindFirst.mockResolvedValueOnce({
        id: "dc_active",
        code: "ACTIVE10",
        disabledAt: null,
      });

      await expect(
        createDiscountCode({
          workspace: { id: "ws_1" } as any,
          partner: { id: "partner_1", name: "Partner" },
          link: { id: "link_1" },
          discount: {
            id: "disc_1",
            programId: "prog_1",
            provider: "shopify",
          } as any,
        }),
      ).rejects.toThrow(
        "This link already has a discount code (ACTIVE10) assigned.",
      );
    });
  });

  // =========================================================================
  // 2. Soft-Delete Idempotency & FIN-AUDIT-11 Protection
  // =========================================================================
  describe("2. Soft-Delete Idempotency & FIN-AUDIT-11 Protection", () => {
    it("2.1: deleteDiscountCodes filters disabledAt: null to preserve historical disablement timestamp", async () => {
      prismaMocks.discountCodeUpdateMany.mockResolvedValueOnce({ count: 1 });

      await deleteDiscountCodes([
        {
          id: "dc_historical",
          code: "HISTORICAL10",
          programId: "prog_1",
          discount: { provider: "shopify" },
        },
      ]);

      expect(prismaMocks.discountCodeUpdateMany).toHaveBeenCalledTimes(1);
      const updateManyArgs =
        prismaMocks.discountCodeUpdateMany.mock.calls[0][0];

      // Verifies invariant: where strictly requires disabledAt: null
      expect(updateManyArgs.where).toEqual({
        id: { in: ["dc_historical"] },
        disabledAt: null,
      });
      expect(updateManyArgs.data).toEqual({
        disabledAt: expect.any(Date),
      });
    });

    it("2.2: deleteLink uses soft delete (deleteDiscountCodes) and does not hard-delete DiscountCode", async () => {
      prismaMocks.linkFindUniqueOrThrow.mockResolvedValueOnce({
        id: "link_123",
        projectId: "ws_m3",
        discountCode: {
          id: "dc_link_123",
          code: "LINKCODE",
          programId: "prog_1",
          disabledAt: null,
          discount: { provider: "shopify" },
        },
      });

      prismaMocks.discountCodeUpdateMany.mockResolvedValueOnce({ count: 1 });
      prismaMocks.linkDelete.mockResolvedValueOnce({ id: "link_123" });

      await deleteLink("link_123");

      // Verify query includes disabledAt: null filter on discountCode
      const findArgs = prismaMocks.linkFindUniqueOrThrow.mock.calls[0][0];
      expect(findArgs.include.discountCode.where).toEqual({
        disabledAt: null,
      });

      // Verify soft delete occurred via updateMany
      expect(prismaMocks.discountCodeUpdateMany).toHaveBeenCalledWith({
        where: {
          id: { in: ["dc_link_123"] },
          disabledAt: null,
        },
        data: {
          disabledAt: expect.any(Date),
        },
      });

      // Verify hard delete (prisma.discountCode.delete) was NEVER called
      expect(prismaMocks.discountCodeDelete).not.toHaveBeenCalled();

      // Verify link itself was deleted
      expect(prismaMocks.linkDelete).toHaveBeenCalledWith({
        where: { id: "link_123" },
      });
    });

    it("2.3: bulkDeleteLinks filters disabledAt: null when querying associated discount codes", async () => {
      prismaMocks.discountCodeFindMany.mockResolvedValueOnce([
        {
          id: "dc_bulk",
          code: "BULK10",
          programId: "prog_1",
          discount: { provider: "shopify" },
        },
      ]);
      prismaMocks.discountCodeUpdateMany.mockResolvedValueOnce({ count: 1 });
      prismaMocks.linkDeleteMany.mockResolvedValueOnce({ count: 1 });

      await bulkDeleteLinks([
        {
          id: "link_bulk_1",
          projectId: "ws_m3",
        } as any,
      ]);

      expect(prismaMocks.discountCodeFindMany).toHaveBeenCalledWith({
        where: {
          linkId: { in: ["link_bulk_1"] },
          disabledAt: null,
        },
        include: {
          discount: {
            select: { provider: true },
          },
        },
      });
    });
  });

  // =========================================================================
  // 3. API Token Scope Enforcement (requiredPermissions)
  // =========================================================================
  describe("3. API Token Scope Enforcement (requiredPermissions)", () => {
    function callRouteWithWorkspace(
      options: Parameters<typeof withWorkspace>[1],
      url = "https://api.test/api/weletic/test?workspaceId=ws_m3",
    ) {
      const handler = vi.fn(async () => Response.json({ success: true }));
      const route = withWorkspace(handler as any, options) as any;
      const req = new NextRequest(url, { method: "POST" });
      return {
        handler,
        run: () => route(req, { params: Promise.resolve({}) }),
      };
    }

    it("3.1: Rejects token lacking integrations.read with 403 forbidden", async () => {
      state.scopes = "loyalty.read";
      const { handler, run } = callRouteWithWorkspace({
        requiredPermissions: ["integrations.read"],
      });

      const res = await run();
      expect(res.status).toBe(403);
      expect(handler).not.toHaveBeenCalled();
    });

    it("3.2: Allows token with integrations.read permission", async () => {
      state.scopes = "integrations.read";
      const { handler, run } = callRouteWithWorkspace({
        requiredPermissions: ["integrations.read"],
      });

      const res = await run();
      expect(res.status).toBe(200);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("3.3: Rejects token with integrations.read from accessing integrations.write endpoint", async () => {
      state.scopes = "integrations.read";
      const { handler, run } = callRouteWithWorkspace({
        requiredPermissions: ["integrations.write"],
        requiredRoles: ["owner"],
      });

      const res = await run();
      expect(res.status).toBe(403);
      expect(handler).not.toHaveBeenCalled();
    });

    it("3.4: Allows token with integrations.write permission", async () => {
      state.scopes = "integrations.write";
      const { handler, run } = callRouteWithWorkspace({
        requiredPermissions: ["integrations.write"],
        requiredRoles: ["owner"],
      });

      const res = await run();
      expect(res.status).toBe(200);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("3.5: Rejects token lacking loyalty.read with 403 on reviews admin endpoint", async () => {
      state.scopes = "integrations.read";
      const { handler, run } = callRouteWithWorkspace({
        requiredPermissions: ["loyalty.read"],
      });

      const res = await run();
      expect(res.status).toBe(403);
      expect(handler).not.toHaveBeenCalled();
    });

    it("3.6: Verifies static route files declare requiredPermissions", () => {
      const rootDir = path.resolve(__dirname, "../../app/(ee)/api");

      const routesToCheck: Array<{ file: string; expected: string[] }> = [
        {
          file: "weletic/collections/route.ts",
          expected: ['requiredPermissions: ["integrations.read"]'],
        },
        {
          file: "weletic/products/route.ts",
          expected: ['requiredPermissions: ["integrations.read"]'],
        },
        {
          file: "weletic/segments/route.ts",
          expected: ['requiredPermissions: ["integrations.read"]'],
        },
        {
          file: "weletic/commission-rules/route.ts",
          expected: [
            'requiredPermissions: ["integrations.read"]',
            'requiredPermissions: ["integrations.write"]',
          ],
        },
        {
          file: "weletic/payout-profiles/route.ts",
          expected: ['requiredPermissions: ["integrations.read"]'],
        },
        {
          file: "weletic/payout-profiles/[profileId]/route.ts",
          expected: ['requiredPermissions: ["integrations.write"]'],
        },
        {
          file: "weletic/reconciliation/route.ts",
          expected: [
            'requiredPermissions: ["integrations.read"]',
            'requiredPermissions: ["integrations.write"]',
          ],
        },
        {
          file: "weletic/shopify/install-intent/route.ts",
          expected: ['requiredPermissions: ["integrations.write"]'],
        },
        {
          file: "weletic/shopify/session-health/route.ts",
          expected: ['requiredPermissions: ["integrations.read"]'],
        },
        {
          file: "weletic/shopify/sync/route.ts",
          expected: ['requiredPermissions: ["integrations.write"]'],
        },
        {
          file: "shopify/reviews/admin/route.ts",
          expected: [
            'requiredPermissions: ["loyalty.read"]',
            'requiredPermissions: ["loyalty.write"]',
          ],
        },
      ];

      for (const { file, expected } of routesToCheck) {
        const fullPath = path.join(rootDir, file);
        expect(fs.existsSync(fullPath)).toBe(true);
        const content = fs.readFileSync(fullPath, "utf8");
        for (const exp of expected) {
          expect(content).toContain(exp);
        }
      }
    });
  });

  // =========================================================================
  // 4. Canonical Store Resolution & Zero-Hardcoding Invariant
  // =========================================================================
  describe("4. Canonical Store Resolution & Zero-Hardcoding Invariant", () => {
    it("4.1: Canonical resolution resolves aliases and technical handles without strict shopifyStoreId equality", async () => {
      prismaMocks.weleticShopifyStoreFindUnique.mockResolvedValueOnce({
        id: "store_yamax",
        projectId: "ws_yamax",
        shopDomain: "yamaxdev.myshopify.com",
        installationGeneration: "gen_1",
      });

      prismaMocks.projectFindUnique.mockResolvedValueOnce({
        id: "ws_yamax",
        shopifyStoreId: "montdev.myshopify.com",
        defaultProgramId: "prog_yamax",
        installedIntegrations: [],
        weleticShopifyStore: {
          id: "store_yamax",
          shopDomain: "yamaxdev.myshopify.com",
        },
      });

      const store = await resolveShopifyStoreByDomain("yamaxdev.myshopify.com");
      expect(store).not.toBeNull();
      expect(store?.workspaceId).toBe("ws_yamax");
      expect(store?.storeId).toBe("store_yamax");
      expect(store?.allDomains).toContain("yamaxdev.myshopify.com");
    });

    it("4.2: nudge-collections route file does NOT contain raw shopifyStoreId direct query fallback", () => {
      const nudgePath = path.resolve(
        __dirname,
        "../../app/api/internal/shopify/loyalty/customer/nudge-collections/route.ts",
      );
      expect(fs.existsSync(nudgePath)).toBe(true);
      const content = fs.readFileSync(nudgePath, "utf8");

      // Verify no non-canonical query fallback
      expect(content).not.toContain("where: { shopifyStoreId: shop }");
      expect(content).toContain("resolveShopifyStoreByDomain");
    });
  });

  // =========================================================================
  // 5. Zero Hardcoding of Vendor in Partner Portal UI
  // =========================================================================
  describe("5. Zero Hardcoding of Vendor in Partner Portal UI", () => {
    it("5.1: product-detail-modal.tsx does NOT contain hardcoded Yamax vendor fallback", () => {
      const modalPath = path.resolve(
        __dirname,
        "../../app/(ee)/partners.dub.co/(dashboard)/programs/[programSlug]/(enrolled)/products/product-detail-modal.tsx",
      );
      expect(fs.existsSync(modalPath)).toBe(true);
      const content = fs.readFileSync(modalPath, "utf8");

      expect(content).not.toContain('"Yamax"');
      expect(content).not.toContain("'Yamax'");
      expect(content).toContain('{product.vendor || ""}');
    });

    it("5.2: page-client.tsx does NOT contain hardcoded Yamax vendor fallback", () => {
      const pageClientPath = path.resolve(
        __dirname,
        "../../app/(ee)/partners.dub.co/(dashboard)/programs/[programSlug]/(enrolled)/products/[productId]/page-client.tsx",
      );
      expect(fs.existsSync(pageClientPath)).toBe(true);
      const content = fs.readFileSync(pageClientPath, "utf8");

      expect(content).not.toContain('"Yamax"');
      expect(content).not.toContain("'Yamax'");
      expect(content).toContain('{product.vendor || ""}');
    });
  });
});
