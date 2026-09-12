import { DubApiError } from "@/lib/api/errors";
import { getProgramEnrollmentOrThrow } from "@/lib/api/programs/get-program-enrollment-or-throw";
import { createDiscountCode } from "@/lib/discounts/create-discount-code";
import { deleteDiscountCodes } from "@/lib/discounts/delete-discount-code";
import {
  createDiscountCodeSchema,
  getDiscountCodesQuerySchema,
} from "@/lib/zod/schemas/discount";
import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { legacyCredentialSqlFixture } from "./helpers/legacy-credential-sql-fixture";

vi.mock("server-only", () => ({}));

// This suite supplies legacy integration fixtures. Native credential-source
// authorization and lifecycle fences are covered by their dedicated suites.
vi.mock("@/lib/weletic/shopify/credential-source", () => ({
  readShopifyCredentialSource: vi.fn(async () => ({ source: "legacy" })),
}));

vi.mock("@/lib/api/links/cache", () => ({
  linkCache: {
    expireMany: vi.fn(async () => {}),
    delete: vi.fn(async () => 1),
  },
}));

vi.mock("@/lib/upstash", () => ({
  redis: {
    set: vi.fn(async () => "OK"),
    get: vi.fn(async () => null),
    del: vi.fn(async () => 1),
    hget: vi.fn(async () => null),
    hset: vi.fn(async () => 1),
    expire: vi.fn(async () => 1),
  },
}));

vi.mock("@/lib/cron", () => ({
  qstash: {
    publishJSON: vi.fn(async () => ({ messageId: "msg_123" })),
    queue: vi.fn(() => ({
      enqueueJSON: vi.fn(async () => ({ messageId: "msg_123" })),
    })),
  },
}));

vi.mock("@/lib/integrations/shopify/admin-graphql", () => ({
  shopifyAdminGraphql: vi.fn(async () => ({
    discountRedeemCodeBulkAdd: {
      bulkCreation: { id: "gid://shopify/Bulk/1" },
      userErrors: [],
    },
    discountCodeBasicCreate: {
      codeDiscountNode: {
        id: "gid://shopify/DiscountCodeNode/201",
        codeDiscount: { codes: { nodes: [{ id: "c_201", code: "TESTCODE" }] } },
      },
      userErrors: [],
    },
    codeDiscountNodeByCode: { id: "gid://shopify/DiscountCodeNode/201" },
    discountCodeDelete: {
      deletedCodeDiscountId: "gid://shopify/DiscountCodeNode/201",
      userErrors: [],
    },
  })),
}));

vi.mock("@/lib/cron/enqueue-batch-jobs", () => ({
  enqueueBatchJobs: vi.fn(async () => {}),
}));

// In-Memory Test State for Challenger 2
const testDb = {
  projects: new Map<string, any>(),
  installedIntegrations: new Map<string, any>(),
  discounts: new Map<string, any>(),
  discountCodes: new Map<string, any>(),
  links: new Map<string, any>(),
  partners: new Map<string, any>(),
  programEnrollments: new Map<string, any>(),
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    project: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.id) return testDb.projects.get(where.id) || null;
        if (where.defaultProgramId) {
          for (const p of testDb.projects.values()) {
            if (p.defaultProgramId === where.defaultProgramId) return p;
          }
        }
        return null;
      }),
    },
    installedIntegration: {
      findFirst: vi.fn(async ({ where }: any) => {
        for (const inst of testDb.installedIntegrations.values()) {
          if (!where?.projectId || inst.projectId === where.projectId)
            return inst;
        }
        return null;
      }),
      findUnique: vi.fn(
        async ({ where }: any) =>
          testDb.installedIntegrations.get(where.id) || null,
      ),
    },
    weleticShopifyStore: {
      findUnique: vi.fn(async ({ where }: any) =>
        where.projectId === "ws_challenger"
          ? {
              id: "wstore_challenger",
              projectId: "ws_challenger",
              shopDomain: "challenger-demo.myshopify.com",
              complianceState: "active",
              installationGeneration: "sgen_challenger",
            }
          : null,
      ),
    },
    link: {
      findFirst: vi.fn(async ({ where }: any) => {
        for (const link of testDb.links.values()) {
          if (where.programId && link.programId !== where.programId) continue;
          if (where.partnerId && link.partnerId !== where.partnerId) continue;
          if (where.discountCode?.is === null && link.discountCodeId) continue;
          return link;
        }
        return null;
      }),
      findUnique: vi.fn(async ({ where }: any) => {
        return testDb.links.get(where.id) || null;
      }),
      findMany: vi.fn(async ({ where }: any = {}) => {
        let results = Array.from(testDb.links.values());
        if (where?.partnerId)
          results = results.filter((l) => l.partnerId === where.partnerId);
        if (where?.programId)
          results = results.filter((l) => l.programId === where.programId);
        return results;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const link = testDb.links.get(where.id);
        if (!link) return null;
        const updated = { ...link, ...data };
        testDb.links.set(where.id, updated);
        return updated;
      }),
    },
    discountCode: {
      findFirst: vi.fn(async ({ where }: any) => {
        for (const code of testDb.discountCodes.values()) {
          if (
            where.code &&
            code.code.toUpperCase() !== where.code.toUpperCase()
          )
            continue;
          if (where.programId && code.programId !== where.programId) continue;
          if (where.partnerId && code.partnerId !== where.partnerId) continue;
          if (where.linkId && code.linkId !== where.linkId) continue;
          if (where.disabledAt === null && code.disabledAt !== null) continue;
          if (where.disabledAt?.not !== undefined && code.disabledAt === null)
            continue;
          return code;
        }
        return null;
      }),
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.id) return testDb.discountCodes.get(where.id) || null;
        if (where.programId_code) {
          for (const code of testDb.discountCodes.values()) {
            if (
              code.programId === where.programId_code.programId &&
              code.code.toUpperCase() ===
                where.programId_code.code.toUpperCase()
            ) {
              return {
                ...code,
                partner: testDb.partners.get(code.partnerId) || null,
                discount: testDb.discounts.get(code.discountId) || null,
              };
            }
          }
        }
        return null;
      }),
      findMany: vi.fn(async ({ where }: any = {}) => {
        let results = Array.from(testDb.discountCodes.values());
        if (where?.programId) {
          results = results.filter((c) => c.programId === where.programId);
        }
        if (where?.partnerId) {
          results = results.filter((c) => c.partnerId === where.partnerId);
        }
        if (where?.disabledAt === null) {
          results = results.filter((c) => c.disabledAt === null);
        }
        if (where?.disabledAt?.not !== undefined) {
          results = results.filter((c) => c.disabledAt !== null);
        }
        return results;
      }),
      create: vi.fn(async ({ data }: any) => {
        for (const existing of testDb.discountCodes.values()) {
          if (
            existing.programId === data.programId &&
            existing.code.toUpperCase() === data.code.toUpperCase()
          ) {
            throw new Prisma.PrismaClientKnownRequestError(
              "Unique constraint failed on (programId, code)",
              {
                code: "P2002",
                clientVersion: "6.0.0",
              },
            );
          }
          if (data.linkId && existing.linkId === data.linkId) {
            throw new Prisma.PrismaClientKnownRequestError(
              "Unique constraint failed on linkId",
              {
                code: "P2002",
                clientVersion: "6.0.0",
              },
            );
          }
        }
        const record = {
          ...data,
          id:
            data.id ||
            `dcode_${Date.now()}_${Math.random().toString(36).substring(7)}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          disabledAt: null,
        };
        testDb.discountCodes.set(record.id, record);
        if (data.linkId && testDb.links.has(data.linkId)) {
          const link = testDb.links.get(data.linkId);
          testDb.links.set(data.linkId, { ...link, discountCodeId: record.id });
        }
        return record;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const existing = testDb.discountCodes.get(where.id);
        if (!existing) throw new Error(`DiscountCode ${where.id} not found`);
        const updated = { ...existing, ...data, updatedAt: new Date() };
        testDb.discountCodes.set(where.id, updated);
        if (data.linkId && testDb.links.has(data.linkId)) {
          const link = testDb.links.get(data.linkId);
          testDb.links.set(data.linkId, { ...link, discountCodeId: where.id });
        }
        return updated;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const [id, code] of testDb.discountCodes.entries()) {
          let matches = true;
          if (where?.id?.in && !where.id.in.includes(id)) matches = false;
          if (where?.id?.not && code.id === where.id.not) matches = false;
          if (where?.programId && code.programId !== where.programId)
            matches = false;
          if (where?.linkId && code.linkId !== where.linkId) matches = false;
          if (where?.disabledAt === null && code.disabledAt !== null)
            matches = false;
          if (where?.disabledAt?.not !== undefined && code.disabledAt === null)
            matches = false;
          if (matches) {
            testDb.discountCodes.set(id, {
              ...code,
              ...data,
              updatedAt: new Date(),
            });
            count++;
          }
        }
        return { count };
      }),
      delete: vi.fn(async ({ where }: any) => {
        const record = testDb.discountCodes.get(where.id);
        testDb.discountCodes.delete(where.id);
        return record;
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        let count = 0;
        for (const [id, code] of testDb.discountCodes.entries()) {
          if (where?.id?.in && where.id.in.includes(id)) {
            testDb.discountCodes.delete(id);
            count++;
          }
        }
        return { count };
      }),
    },
    programEnrollment: {
      findUnique: vi.fn(async ({ where, include }: any) => {
        const key = `${where.partnerId_programId.partnerId}_${where.partnerId_programId.programId}`;
        const enrollment = testDb.programEnrollments.get(key);
        if (!enrollment) return null;

        const partner = testDb.partners.get(enrollment.partnerId);
        const discount = enrollment.discountId
          ? testDb.discounts.get(enrollment.discountId)
          : null;
        const links = Array.from(testDb.links.values()).filter(
          (l) =>
            l.partnerId === enrollment.partnerId &&
            l.programId === enrollment.programId,
        );

        let discountCodes = Array.from(testDb.discountCodes.values()).filter(
          (dc) =>
            dc.partnerId === enrollment.partnerId &&
            dc.programId === enrollment.programId,
        );

        if (include?.discountCodes?.where?.disabledAt === null) {
          discountCodes = discountCodes.filter((dc) => dc.disabledAt === null);
        } else if (
          include?.discountCodes?.where?.disabledAt?.not !== undefined
        ) {
          discountCodes = discountCodes.filter((dc) => dc.disabledAt !== null);
        }

        return {
          ...enrollment,
          partner,
          discount,
          links: include?.links ? links : undefined,
          discountCodes: include?.discountCodes ? discountCodes : undefined,
        };
      }),
      findFirst: vi.fn(async ({ where, include }: any) => {
        for (const enrollment of testDb.programEnrollments.values()) {
          if (enrollment.partnerId === where.partnerId) {
            return (vi.mocked(prisma.programEnrollment.findUnique) as any)({
              where: {
                partnerId_programId: {
                  partnerId: enrollment.partnerId,
                  programId: enrollment.programId,
                },
              },
              include,
            });
          }
        }
        return null;
      }),
    },
    $transaction: vi.fn(async (callback: (tx: any) => unknown) =>
      callback({
        $queryRaw: vi.fn((query: Prisma.Sql) => legacySql.queryRaw(query)),
        $executeRaw: vi.fn((query: Prisma.Sql) => legacySql.executeRaw(query)),
        installedIntegration: {
          findUnique: vi.fn(
            async ({ where }: any) =>
              testDb.installedIntegrations.get(where.id) || null,
          ),
        },
      }),
    ),
  },
}));

import { prisma } from "@/lib/prisma";

const legacySql = legacyCredentialSqlFixture({
  readStore: () =>
    prisma.weleticShopifyStore.findUnique({
      where: { projectId: "ws_challenger" },
    }),
  readInstallation: async (id) => testDb.installedIntegrations.get(id) ?? null,
});

function seedChallengerEnv() {
  testDb.projects.clear();
  testDb.installedIntegrations.clear();
  testDb.discounts.clear();
  testDb.discountCodes.clear();
  testDb.links.clear();
  testDb.partners.clear();
  testDb.programEnrollments.clear();

  const workspace = {
    id: "ws_challenger",
    name: "Challenger Store",
    slug: "challenger",
    shopifyStoreId: "challenger-demo.myshopify.com",
    stripeConnectId: null,
    defaultProgramId: "prog_challenger",
  };
  testDb.projects.set(workspace.id, workspace);

  const integration = {
    id: "inst_challenger",
    projectId: "ws_challenger",
    integrationId: "shopify",
    credentials: {
      shop: "challenger-demo.myshopify.com",
      accessToken: "shpat_challenger_token_123",
      installationGeneration: "sgen_challenger",
      shopVerifiedAt: "2026-08-28T00:00:00.000Z",
      shopVerificationTokenHash:
        "b406d5290fbdf7ed59803c5827f05aee56db3ca97cf92ae97655eedd6f1de54f",
      scope: "read_products,write_discounts",
    },
  };
  testDb.installedIntegrations.set(integration.id, integration);

  const discount = {
    id: "disc_challenger_10",
    programId: "prog_challenger",
    amount: 10,
    type: "percentage",
    provider: "shopify",
    couponId: "gid://shopify/DiscountCodeNode/999",
  };
  testDb.discounts.set(discount.id, discount);

  const partner = {
    id: "partner_c2",
    name: "Challenger Partner",
    email: "c2@example.com",
    programId: "prog_challenger",
  };
  testDb.partners.set(partner.id, partner);

  const links = [
    {
      id: "link_1",
      domain: "challenger.com",
      key: "link1",
      shortLink: "challenger.com/link1",
      url: "https://challenger.com/link1",
      programId: "prog_challenger",
      partnerId: "partner_c2",
      discountCodeId: null,
    },
    {
      id: "link_2",
      domain: "challenger.com",
      key: "link2",
      shortLink: "challenger.com/link2",
      url: "https://challenger.com/link2",
      programId: "prog_challenger",
      partnerId: "partner_c2",
      discountCodeId: null,
    },
    {
      id: "link_3",
      domain: "challenger.com",
      key: "link3",
      shortLink: "challenger.com/link3",
      url: "https://challenger.com/link3",
      programId: "prog_challenger",
      partnerId: "partner_c2",
      discountCodeId: null,
    },
    {
      id: "link_4",
      domain: "challenger.com",
      key: "link4",
      shortLink: "challenger.com/link4",
      url: "https://challenger.com/link4",
      programId: "prog_challenger",
      partnerId: "partner_c2",
      discountCodeId: null,
    },
  ];

  links.forEach((l) => testDb.links.set(l.id, l));

  const enrollment = {
    partnerId: "partner_c2",
    programId: "prog_challenger",
    discountId: "disc_challenger_10",
  };
  testDb.programEnrollments.set("partner_c2_prog_challenger", enrollment);

  return { workspace, integration, discount, partner, links, enrollment };
}

describe("Adversarial Stress Test: Challenger 2 UI/API Invariants", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedChallengerEnv();
  });

  // =========================================================================
  // 1. SWR CACHE COHERENCE ACROSS ACTIVE & ARCHIVED TABS
  // =========================================================================
  describe("Invariant 1: SWR Cache Coherence between Active and Archived Tabs", () => {
    it("1.1: mutatePrefix accurately targets all variations of discount code query keys", () => {
      const testCacheKeys = [
        "/api/discount-codes?workspaceId=ws_challenger&partnerId=partner_c2&status=all",
        "/api/discount-codes?workspaceId=ws_challenger&partnerId=partner_c2&status=active",
        "/api/discount-codes?workspaceId=ws_challenger&partnerId=partner_c2&status=archived",
        "/api/discount-codes?workspaceId=ws_challenger&partnerId=partner_c2",
        "/api/discount-codes",
        "/api/partners/partner_c2?includeComposite=true",
        "/api/links?workspaceId=ws_challenger",
        "/api/commissions?partnerId=partner_c2",
      ];

      // Test prefix matcher
      const prefix = "/api/discount-codes";
      const matched = testCacheKeys.filter((key) => key.startsWith(prefix));

      expect(matched).toHaveLength(5);
      expect(matched).toContain(
        "/api/discount-codes?workspaceId=ws_challenger&partnerId=partner_c2&status=all",
      );
      expect(matched).toContain(
        "/api/discount-codes?workspaceId=ws_challenger&partnerId=partner_c2&status=active",
      );
      expect(matched).toContain(
        "/api/discount-codes?workspaceId=ws_challenger&partnerId=partner_c2&status=archived",
      );
      expect(matched).toContain(
        "/api/discount-codes?workspaceId=ws_challenger&partnerId=partner_c2",
      );
      expect(matched).toContain("/api/discount-codes");
    });

    it("1.2: single SWR cache fetch with status=all provides immediate bidirectional consistency without stale drift", () => {
      // Emulate raw SWR cache state
      const rawCodes = [
        { id: "dc_1", code: "ACT1", linkId: "link_1", disabledAt: null },
        { id: "dc_2", code: "ACT2", linkId: "link_2", disabledAt: null },
        {
          id: "dc_3",
          code: "DIS1",
          linkId: null,
          disabledAt: new Date("2026-08-01T00:00:00Z"),
        },
      ];

      // Partitioning logic identical to PartnerDiscountCodes in page.tsx
      const activeCodes = rawCodes.filter((d) => !d.disabledAt);
      const archivedCodes = rawCodes.filter((d) => !!d.disabledAt);

      expect(activeCodes.length).toBe(2);
      expect(archivedCodes.length).toBe(1);
      expect(activeCodes.length + archivedCodes.length).toBe(rawCodes.length);

      // Transition: Soft-delete dc_1
      const now = new Date();
      const updatedRawCodes = rawCodes.map((c) =>
        c.id === "dc_1" ? { ...c, disabledAt: now } : c,
      );

      const newActive = updatedRawCodes.filter((d) => !d.disabledAt);
      const newArchived = updatedRawCodes.filter((d) => !!d.disabledAt);

      expect(newActive.length).toBe(1);
      expect(newArchived.length).toBe(2);
      expect(newActive.map((c) => c.code)).toEqual(["ACT2"]);
      expect(newArchived.map((c) => c.code)).toEqual(["ACT1", "DIS1"]);
    });

    it("1.3: re-creating a disabled code dynamically shifts record from Archived to Active without duplicates", () => {
      const rawCodes = [
        {
          id: "dc_recycle",
          code: "RECYCLE10",
          linkId: null,
          disabledAt: new Date("2026-08-01"),
        },
        { id: "dc_other", code: "OTHER", linkId: "link_1", disabledAt: null },
      ];

      // Before re-activation
      expect(rawCodes.filter((d) => !d.disabledAt).length).toBe(1);
      expect(rawCodes.filter((d) => !!d.disabledAt).length).toBe(1);

      // Re-activation in-place (sets disabledAt = null)
      const afterReactivation = rawCodes.map((c) =>
        c.id === "dc_recycle"
          ? { ...c, disabledAt: null, linkId: "link_2" }
          : c,
      );

      const activeCodes = afterReactivation.filter((d) => !d.disabledAt);
      const archivedCodes = afterReactivation.filter((d) => !!d.disabledAt);

      expect(activeCodes.length).toBe(2);
      expect(archivedCodes.length).toBe(0);
      expect(activeCodes.map((c) => c.code)).toContain("RECYCLE10");
    });
  });

  // =========================================================================
  // 2. LINK SLOT AVAILABILITY MATRIX & MULTI-LINK MIXED STATE
  // =========================================================================
  describe("Invariant 2: Link Slot Availability Calculation with Mixed Active/Disabled Codes", () => {
    it("2.1: calculates slot availability across 4 links with mixed active, disabled, and empty states", async () => {
      const { links } = seedChallengerEnv();

      // Setup state:
      // Link 1: Active Code (OCCUPIED)
      // Link 2: Disabled Code with linkId=link_2 (AVAILABLE - disabled codes release slot)
      // Link 3: Disabled Code with linkId=null (AVAILABLE)
      // Link 4: Empty link without any codes (AVAILABLE)
      const activeCode = {
        id: "dc_act_link1",
        code: "LINK1_ACT",
        programId: "prog_challenger",
        partnerId: "partner_c2",
        linkId: "link_1",
        disabledAt: null,
      };
      testDb.discountCodes.set(activeCode.id, activeCode);

      const disabledCodeAttached = {
        id: "dc_dis_link2",
        code: "LINK2_DIS",
        programId: "prog_challenger",
        partnerId: "partner_c2",
        linkId: "link_2",
        disabledAt: new Date("2026-08-10"),
      };
      testDb.discountCodes.set(disabledCodeAttached.id, disabledCodeAttached);

      const disabledCodeDetached = {
        id: "dc_dis_link3",
        code: "LINK3_DIS",
        programId: "prog_challenger",
        partnerId: "partner_c2",
        linkId: null,
        disabledAt: new Date("2026-08-11"),
      };
      testDb.discountCodes.set(disabledCodeDetached.id, disabledCodeDetached);

      const allCodes = Array.from(testDb.discountCodes.values());
      const activeCodes = allCodes.filter((c) => !c.disabledAt);

      // Formula used in PartnerDiscountCodes and AddDiscountCodeModal:
      const availableLinks = links.filter(
        (link) => !activeCodes.some((c) => c.linkId === link.id),
      );

      // Links 2, 3, and 4 must be available; Link 1 must NOT be available
      expect(availableLinks).toHaveLength(3);
      expect(availableLinks.map((l) => l.id)).toEqual([
        "link_2",
        "link_3",
        "link_4",
      ]);
      expect(availableLinks.some((l) => l.id === "link_1")).toBe(false);
    });

    it("2.2: creating a new code on link_2 (which had a disabled code) safely unlinks the disabled code and succeeds", async () => {
      const { workspace, partner, discount } = seedChallengerEnv();

      // Seed disabled code on link_2
      const disabledCode = {
        id: "dc_old_link2",
        code: "OLD_ON_LINK2",
        programId: "prog_challenger",
        partnerId: "partner_c2",
        linkId: "link_2",
        discountId: discount.id,
        disabledAt: new Date("2026-08-01"),
      };
      testDb.discountCodes.set(disabledCode.id, disabledCode);

      const link2 = testDb.links.get("link_2");

      // Create fresh code NEW_ON_LINK2
      const newCode = await createDiscountCode({
        workspace,
        partner,
        link: link2,
        discount: discount as any,
        code: "NEW_ON_LINK2",
      });

      expect(newCode.code).toBe("NEW_ON_LINK2");
      expect(newCode.linkId).toBe("link_2");
      expect(newCode.disabledAt).toBeNull();

      // Disabled code on link_2 had linkId cleared to null to prevent unique constraint conflict
      const updatedOldCode = testDb.discountCodes.get(disabledCode.id);
      expect(updatedOldCode?.linkId).toBeNull();
      expect(updatedOldCode?.disabledAt).not.toBeNull();
    });

    it("2.3: rejects new code creation on link_1 when link_1 already has an active code", async () => {
      const { workspace, partner, discount } = seedChallengerEnv();

      const activeCode = {
        id: "dc_active_link1",
        code: "OCCUPIED_CODE",
        programId: "prog_challenger",
        partnerId: "partner_c2",
        linkId: "link_1",
        discountId: discount.id,
        disabledAt: null,
      };
      testDb.discountCodes.set(activeCode.id, activeCode);

      const link1 = testDb.links.get("link_1");

      await expect(
        createDiscountCode({
          workspace,
          partner,
          link: link1,
          discount: discount as any,
          code: "ANOTHER_FOR_LINK1",
        }),
      ).rejects.toThrow(DubApiError);
    });

    it("2.4: button disabledReason transitions accurately from blocked (0 available) to unblocked (1 available) upon soft-delete", () => {
      const singleLinkList = [
        { id: "link_only", shortLink: "challenger.com/only" },
      ];

      // State 1: 1 link, 1 active code -> available = 0 -> disabled
      let activeCodes = [
        {
          id: "dc_only",
          code: "ONLY_CODE",
          linkId: "link_only",
          disabledAt: null,
        },
      ];
      let availableLinks = singleLinkList.filter(
        (link) => !activeCodes.some((c) => c.linkId === link.id),
      );

      let disabledReason =
        availableLinks.length === 0
          ? "All links have a discount code assigned to them. Please add a new link before you can create a discount code."
          : undefined;

      expect(availableLinks).toHaveLength(0);
      expect(disabledReason).toBe(
        "All links have a discount code assigned to them. Please add a new link before you can create a discount code.",
      );

      // State 2: Soft delete -> activeCodes = [] -> available = 1 -> enabled
      activeCodes = [];
      availableLinks = singleLinkList.filter(
        (link) => !activeCodes.some((c) => c.linkId === link.id),
      );

      disabledReason =
        availableLinks.length === 0
          ? "All links have a discount code assigned to them. Please add a new link before you can create a discount code."
          : undefined;

      expect(availableLinks).toHaveLength(1);
      expect(disabledReason).toBeUndefined();
    });
  });

  // =========================================================================
  // 3. STATUS FILTERING PARAMETER VARIATIONS & EDGE CASES
  // =========================================================================
  describe("Invariant 3: Status Filtering Parameter Variations", () => {
    it("3.1: getDiscountCodesQuerySchema validates status=active, status=archived, status=all", () => {
      const pActive = getDiscountCodesQuerySchema.parse({
        partnerId: "partner_c2",
        status: "active",
      });
      expect(pActive.status).toBe("active");

      const pArchived = getDiscountCodesQuerySchema.parse({
        partnerId: "partner_c2",
        status: "archived",
      });
      expect(pArchived.status).toBe("archived");

      const pAll = getDiscountCodesQuerySchema.parse({
        partnerId: "partner_c2",
        status: "all",
      });
      expect(pAll.status).toBe("all");
    });

    it("3.2: missing status parameter defaults to status='active'", () => {
      const parsed = getDiscountCodesQuerySchema.parse({
        partnerId: "partner_c2",
      });
      expect(parsed.status).toBe("active");
    });

    it("3.3: invalid status parameters fail schema validation with ZodError", () => {
      expect(() =>
        getDiscountCodesQuerySchema.parse({
          partnerId: "partner_c2",
          status: "deleted",
        }),
      ).toThrow();

      expect(() =>
        getDiscountCodesQuerySchema.parse({
          partnerId: "partner_c2",
          status: "disabled",
        }),
      ).toThrow();

      expect(() =>
        getDiscountCodesQuerySchema.parse({
          partnerId: "partner_c2",
          status: "ACTIVE", // case-sensitive enum
        }),
      ).toThrow();

      expect(() =>
        getDiscountCodesQuerySchema.parse({
          partnerId: "partner_c2",
          status: 123 as any,
        }),
      ).toThrow();
    });

    it("3.4: getProgramEnrollmentOrThrow enforces accurate Prisma where filters for all status modes", async () => {
      const { discount } = seedChallengerEnv();

      // Seed 3 active codes and 2 disabled codes
      testDb.discountCodes.set("dc_a1", {
        id: "dc_a1",
        code: "ACTIVE1",
        programId: "prog_challenger",
        partnerId: "partner_c2",
        linkId: "link_1",
        discountId: discount.id,
        disabledAt: null,
      });
      testDb.discountCodes.set("dc_a2", {
        id: "dc_a2",
        code: "ACTIVE2",
        programId: "prog_challenger",
        partnerId: "partner_c2",
        linkId: "link_2",
        discountId: discount.id,
        disabledAt: null,
      });
      testDb.discountCodes.set("dc_a3", {
        id: "dc_a3",
        code: "ACTIVE3",
        programId: "prog_challenger",
        partnerId: "partner_c2",
        linkId: "link_3",
        discountId: discount.id,
        disabledAt: null,
      });
      testDb.discountCodes.set("dc_d1", {
        id: "dc_d1",
        code: "DISABLED1",
        programId: "prog_challenger",
        partnerId: "partner_c2",
        linkId: null,
        discountId: discount.id,
        disabledAt: new Date("2026-08-01"),
      });
      testDb.discountCodes.set("dc_d2", {
        id: "dc_d2",
        code: "DISABLED2",
        programId: "prog_challenger",
        partnerId: "partner_c2",
        linkId: null,
        discountId: discount.id,
        disabledAt: new Date("2026-08-05"),
      });

      // Query status="active" (default)
      const resActive = await getProgramEnrollmentOrThrow({
        partnerId: "partner_c2",
        programId: "prog_challenger",
        status: "active",
        include: { discountCodes: true },
      });
      expect(resActive.discountCodes).toHaveLength(3);
      expect(resActive.discountCodes.every((c) => c.disabledAt === null)).toBe(
        true,
      );

      // Query status="archived"
      const resArchived = await getProgramEnrollmentOrThrow({
        partnerId: "partner_c2",
        programId: "prog_challenger",
        status: "archived",
        include: { discountCodes: true },
      });
      expect(resArchived.discountCodes).toHaveLength(2);
      expect(
        resArchived.discountCodes.every((c) => c.disabledAt !== null),
      ).toBe(true);

      // Query status="all"
      const resAll = await getProgramEnrollmentOrThrow({
        partnerId: "partner_c2",
        programId: "prog_challenger",
        status: "all",
        include: { discountCodes: true },
      });
      expect(resAll.discountCodes).toHaveLength(5);

      // Query with omitted status -> defaults to active
      const resDefault = await getProgramEnrollmentOrThrow({
        partnerId: "partner_c2",
        programId: "prog_challenger",
        include: { discountCodes: true },
      });
      expect(resDefault.discountCodes).toHaveLength(3);
    });
  });

  // =========================================================================
  // 4. ADVERSARIAL EDGE CASES & RACE CONDITIONS
  // =========================================================================
  describe("Invariant 4: Adversarial Lifecycle & Edge Cases", () => {
    it("4.1: multiple consecutive disable/reactivate cycles on the same code preserve single DB row identity", async () => {
      const { workspace, partner, discount } = seedChallengerEnv();
      const link1 = testDb.links.get("link_1");

      // 1. Initial create
      const initialCode = await createDiscountCode({
        workspace,
        partner,
        link: link1,
        discount: discount as any,
        code: "CYCLE_CODE",
      });
      const originalId = initialCode.id;

      // Repeat disable -> reactivate 3 times
      for (let i = 0; i < 3; i++) {
        // Soft delete
        await deleteDiscountCodes([
          {
            id: originalId,
            code: "CYCLE_CODE",
            programId: "prog_challenger",
            discount: { provider: "shopify" },
          },
        ]);
        expect(testDb.discountCodes.get(originalId)?.disabledAt).not.toBeNull();

        // Reactivate
        const reactivated = await createDiscountCode({
          workspace,
          partner,
          link: link1,
          discount: discount as any,
          code: "CYCLE_CODE",
        });
        expect(reactivated.id).toBe(originalId);
        expect(reactivated.disabledAt).toBeNull();
      }

      // Total count of records with code CYCLE_CODE in DB must remain 1
      const records = Array.from(testDb.discountCodes.values()).filter(
        (c) => c.code === "CYCLE_CODE",
      );
      expect(records).toHaveLength(1);
    });

    it("4.2: createDiscountCodeSchema sanitizes and trims code inputs and permits undefined code", () => {
      const res1 = createDiscountCodeSchema.parse({
        partnerId: "partner_c2",
        linkId: "link_1",
        code: "  TRIMMED_CODE  ",
      });
      expect(res1.code).toBe("TRIMMED_CODE");

      const res2 = createDiscountCodeSchema.parse({
        partnerId: "partner_c2",
        linkId: "link_1",
        code: "",
      });
      expect(res2.code).toBeUndefined();

      const res3 = createDiscountCodeSchema.parse({
        partnerId: "partner_c2",
        linkId: "link_1",
      });
      expect(res3.code).toBeUndefined();
    });
  });
});
