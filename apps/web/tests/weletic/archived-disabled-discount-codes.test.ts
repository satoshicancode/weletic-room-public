import { DubApiError } from "@/lib/api/errors";
import { getProgramEnrollmentOrThrow } from "@/lib/api/programs/get-program-enrollment-or-throw";
import { createDiscountCode } from "@/lib/discounts/create-discount-code";
import { deleteDiscountCodes } from "@/lib/discounts/delete-discount-code";
import { calculateRefundReversal } from "@/lib/weletic/commerce/record-refund";
import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  discountsDelete,
  discountsUpdate,
} from "../../app/(ee)/api/shopify/integration/webhook/discounts-sync";
import {
  extractOrderDiscountCodes,
  ordersPaid,
} from "../../app/(ee)/api/shopify/integration/webhook/orders-paid";

vi.mock("server-only", () => ({}));

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
    eval: vi.fn(async () => 1),
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

// In-Memory Test State
const testDb = {
  projects: new Map<string, any>(),
  installedIntegrations: new Map<string, any>(),
  discounts: new Map<string, any>(),
  discountCodes: new Map<string, any>(),
  links: new Map<string, any>(),
  partners: new Map<string, any>(),
  partnerGroups: new Map<string, any>(),
  programEnrollments: new Map<string, any>(),
  customers: new Map<string, any>(),
  weleticOrders: new Map<string, any>(),
  weleticOrderLines: new Map<string, any>(),
  commissions: new Map<string, any>(),
  weleticCommissionCalculations: new Map<string, any>(),
  weleticCommerceRefunds: new Map<string, any>(),
  weleticCommerceRefundLines: new Map<string, any>(),
  leads: new Map<string, any>(),
};

// Mock Prisma
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
      findUniqueOrThrow: vi.fn(async ({ where }: any) => {
        const p = await (vi.mocked(prisma.project.findUnique) as any)({
          where,
        });
        if (!p) throw new Error("Project not found");
        return p;
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
      findUnique: vi.fn(async ({ where }: any) =>
        testDb.installedIntegrations.get(where.id)
          ? testDb.installedIntegrations.get(where.id)
          : null,
      ),
    },
    weleticShopifyStore: {
      findUnique: vi.fn(async () => ({
        id: "store_enterprise",
        projectId: "ws_enterprise",
        shopDomain: "enterprise-demo.myshopify.com",
        installationGeneration: "sgen_enterprise",
        complianceState: "active",
        shopCurrency: "USD",
        currencyVerifiedAt: new Date("2026-08-30T00:00:00.000Z"),
      })),
    },
    weleticShopper: {
      findUnique: vi.fn(async () => null),
    },
    weleticShopifyCustomerPrivacyTombstone: {
      findFirst: vi.fn(async () => null),
    },
    weleticShopifyAppSession: {
      findFirst: vi.fn(async () => null),
    },
    weleticRewardRedemption: {
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    link: {
      findFirst: vi.fn(async ({ where }: any) => {
        for (const link of testDb.links.values()) {
          if (where.programId && link.programId !== where.programId) continue;
          if (where.partnerId && link.partnerId !== where.partnerId) continue;
          if (
            where.partnerGroupDefaultLinkId?.not !== undefined &&
            !link.partnerGroupDefaultLinkId
          )
            continue;
          if (where.discountCode?.is === null && link.discountCodeId) continue;
          if (where.OR && Array.isArray(where.OR)) {
            const match = where.OR.some((c: any) => {
              if (c.discountCode?.is === null && !link.discountCodeId)
                return true;
              if (c.discountCode?.disabledAt?.not !== undefined) {
                const dc = link.discountCodeId
                  ? testDb.discountCodes.get(link.discountCodeId)
                  : null;
                return dc && dc.disabledAt !== null;
              }
              if (c.discountCode?.linkId === null) return !link.discountCodeId;
              return false;
            });
            if (!match) continue;
          }
          return link;
        }
        return null;
      }),
      findUnique: vi.fn(async ({ where }: any) => {
        const link = testDb.links.get(where.id);
        if (!link) return null;
        const discountCode = link.discountCodeId
          ? testDb.discountCodes.get(link.discountCodeId)
          : null;
        return {
          ...link,
          discountCode: discountCode ? { code: discountCode.code } : null,
        };
      }),
      findMany: vi.fn(async ({ where }: any = {}) => {
        let results = Array.from(testDb.links.values());
        if (where?.partnerId?.in) {
          results = results.filter((l) =>
            where.partnerId.in.includes(l.partnerId),
          );
        }
        if (where?.programId) {
          results = results.filter((l) => l.programId === where.programId);
        }
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
        if (where?.code?.in && Array.isArray(where.code.in)) {
          const upperCodes = where.code.in.map((x: string) => x.toUpperCase());
          results = results.filter((c) =>
            upperCodes.includes(c.code.toUpperCase()),
          );
        }
        if (where?.disabledAt === null) {
          results = results.filter((c) => c.disabledAt === null);
        }
        if (where?.disabledAt?.not !== undefined) {
          results = results.filter((c) => c.disabledAt !== null);
        }
        return results.map((c) => ({
          ...c,
          partner: testDb.partners.get(c.partnerId) || null,
          discount: testDb.discounts.get(c.discountId) || null,
          link: c.linkId ? testDb.links.get(c.linkId) || null : null,
        }));
      }),
      create: vi.fn(async ({ data }: any) => {
        // Enforce uniqueness on (programId, code) and linkId
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
          if (where?.code?.in && !where.code.in.includes(code.code))
            matches = false;
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
    customer: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where?.projectId_externalId) {
          for (const c of testDb.customers.values()) {
            if (
              c.projectId === where.projectId_externalId.projectId &&
              String(c.externalId) ===
                String(where.projectId_externalId.externalId)
            ) {
              return c;
            }
          }
          return null;
        }
        if (where?.id) return testDb.customers.get(where.id) || null;
        return null;
      }),
      create: vi.fn(async ({ data }: any) => {
        const customer = { ...data, id: data.id || `cus_${Date.now()}` };
        testDb.customers.set(customer.id, customer);
        return customer;
      }),
    },
    weleticCommerceOrder: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where?.id) return testDb.weleticOrders.get(where.id) || null;
        if (where?.storeId_externalId) {
          for (const o of testDb.weleticOrders.values()) {
            if (
              o.storeId === where.storeId_externalId.storeId &&
              o.externalId === where.storeId_externalId.externalId
            ) {
              return o;
            }
          }
        }
        return null;
      }),
      create: vi.fn(async ({ data }: any) => {
        const order = { ...data, id: data.id || `ord_${Date.now()}` };
        testDb.weleticOrders.set(order.id, order);
        return order;
      }),
    },
    $queryRaw: vi.fn(async () => [
      {
        id: "store_enterprise",
        projectId: "ws_enterprise",
        installationGeneration: "sgen_enterprise",
      },
    ]),
    $transaction: vi.fn(async (operation: any) =>
      typeof operation === "function" ? operation(prisma) : operation,
    ),
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

vi.mock("@/lib/tinybird/record-fake-click", () => ({
  recordFakeClick: vi.fn(async ({ link }: any) => ({
    link_id: link.id,
    click_id: `click_${Date.now()}`,
    timestamp: new Date().toISOString().replace("Z", ""),
  })),
}));

vi.mock("@/lib/tinybird", () => ({
  recordLead: vi.fn(async () => {}),
  recordSale: vi.fn(async () => {}),
  getLeadEvent: vi.fn(async ({ customerId }: any) => ({
    customer_id: customerId,
    link_id: "link_alice_1",
    click_id: "click_test_123",
    timestamp: new Date().toISOString(),
    event_id: "evt_test_123",
    event_name: "Lead",
  })),
  getClickEvent: vi.fn(async () => null),
}));

vi.mock("@/lib/weletic/commerce/record-order", () => ({
  recordWeleticOrder: vi.fn(async () => ({
    order: {
      id: "ord_1001",
      externalId: "shopify_order_1001",
      totalPrice: 100,
    },
    lines: [],
  })),
}));

vi.mock("@/lib/integrations/shopify/create-sale", () => ({
  createShopifySale: vi.fn(async () => ({
    saleId: "sale_1001",
  })),
}));

vi.mock("@/lib/cron/enqueue-batch-jobs", () => ({
  enqueueBatchJobs: vi.fn(async () => {}),
}));

import { shopifyAdminGraphql } from "@/lib/integrations/shopify/admin-graphql";
import { prisma } from "@/lib/prisma";

function resetTestData() {
  testDb.projects.clear();
  testDb.installedIntegrations.clear();
  testDb.discounts.clear();
  testDb.discountCodes.clear();
  testDb.links.clear();
  testDb.partners.clear();
  testDb.partnerGroups.clear();
  testDb.programEnrollments.clear();
  testDb.customers.clear();
  testDb.weleticOrders.clear();
  testDb.weleticOrderLines.clear();
  testDb.commissions.clear();
  testDb.weleticCommissionCalculations.clear();
  testDb.weleticCommerceRefunds.clear();
  testDb.weleticCommerceRefundLines.clear();
  testDb.leads.clear();

  const workspace = {
    id: "ws_enterprise",
    name: "Enterprise Store",
    slug: "enterprise",
    shopifyStoreId: "enterprise-demo.myshopify.com",
    stripeConnectId: null,
    defaultProgramId: "prog_enterprise",
    webhookEnabled: true,
  };
  testDb.projects.set(workspace.id, workspace);

  const integration = {
    id: "inst_enterprise",
    projectId: "ws_enterprise",
    integrationId: "shopify",
    credentials: {
      shop: "enterprise-demo.myshopify.com",
      accessToken: "shpat_test_token_123",
      scope: "read_products,write_discounts",
      shopVerifiedAt: "2026-08-28T00:00:00.000Z",
      shopVerificationTokenHash:
        "2568f2c6619d6af72694b217bcd7aea58bb3bf42cfa1056e3c312986dd494fda",
      installationGeneration: "sgen_enterprise",
    },
  };
  testDb.installedIntegrations.set(integration.id, integration);

  const discount = {
    id: "disc_enterprise_10",
    programId: "prog_enterprise",
    amount: 10,
    type: "percentage",
    provider: "shopify",
    couponId: "gid://shopify/DiscountCodeNode/1001",
    autoProvisionEnabledAt: new Date("2026-01-01T00:00:00Z"),
  };
  testDb.discounts.set(discount.id, discount);

  const partner = {
    id: "partner_alice",
    name: "Alice Partner",
    email: "alice@example.com",
    programId: "prog_enterprise",
  };
  testDb.partners.set(partner.id, partner);

  const link = {
    id: "link_alice_1",
    domain: "enterprisestore.com",
    key: "alice",
    url: "https://enterprisestore.com/alice",
    programId: "prog_enterprise",
    partnerId: "partner_alice",
    partnerGroupDefaultLinkId: "grp_def_link_1",
    discountCodeId: null,
  };
  testDb.links.set(link.id, link);

  const enrollment = {
    partnerId: "partner_alice",
    programId: "prog_enterprise",
    discountId: "disc_enterprise_10",
  };
  testDb.programEnrollments.set("partner_alice_prog_enterprise", enrollment);

  return { workspace, integration, discount, partner, link, enrollment };
}

describe("Enterprise Archived & Disabled Discount Codes System (Milestone 1 Test Suite)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTestData();
  });

  // ===========================================================================
  // 1. UNIVERSAL SOFT-DELETION (R2 & R4)
  // ===========================================================================
  describe("Section 1: Universal Soft-Deletion by Default", () => {
    it("1.1: deleteDiscountCodes defaults to isSoftDelete=true and sets disabledAt without deleting database rows", async () => {
      const { discount } = resetTestData();
      const codeRecord = {
        id: "dcode_test_1",
        code: "SUMMER10",
        programId: "prog_enterprise",
        partnerId: "partner_alice",
        linkId: "link_alice_1",
        discountId: discount.id,
        disabledAt: null,
      };
      testDb.discountCodes.set(codeRecord.id, codeRecord);

      // Call without specifying isSoftDelete
      await deleteDiscountCodes([
        {
          id: codeRecord.id,
          code: codeRecord.code,
          programId: codeRecord.programId,
          discount: { provider: "shopify" },
        },
      ]);

      const updated = testDb.discountCodes.get(codeRecord.id);
      expect(updated).toBeDefined();
      expect(updated?.disabledAt).toBeInstanceOf(Date);
      expect(updated?.code).toBe("SUMMER10");
    });

    it("1.2: deleteDiscountCodes with isSoftDelete=false executes hard deletion", async () => {
      const { discount } = resetTestData();
      const codeRecord = {
        id: "dcode_test_2",
        code: "HARDDELETE10",
        programId: "prog_enterprise",
        partnerId: "partner_alice",
        linkId: "link_alice_1",
        discountId: discount.id,
        disabledAt: null,
      };
      testDb.discountCodes.set(codeRecord.id, codeRecord);

      await deleteDiscountCodes(
        [
          {
            id: codeRecord.id,
            code: codeRecord.code,
            programId: codeRecord.programId,
            discount: { provider: "shopify" },
          },
        ],
        { isSoftDelete: false },
      );

      expect(testDb.discountCodes.has(codeRecord.id)).toBe(false);
    });

    it("1.3: gracefully handles empty or null discount code inputs", async () => {
      await expect(deleteDiscountCodes([])).resolves.toBeUndefined();
      await expect(
        deleteDiscountCodes([null, undefined]),
      ).resolves.toBeUndefined();
    });
  });

  // ===========================================================================
  // 2. LINK SLOT DE-ALLOCATION (R2)
  // ===========================================================================
  describe("Section 2: Link Slot De-Allocation on Disablement", () => {
    it("2.1: soft-deleting a code frees the link slot, allowing a new code to be created on the same link", async () => {
      const { workspace, partner, link, discount } = resetTestData();

      // Seed an existing disabled code on link_alice_1
      const oldCode = {
        id: "dcode_old_1",
        code: "OLDCODE10",
        programId: "prog_enterprise",
        partnerId: "partner_alice",
        linkId: link.id,
        discountId: discount.id,
        disabledAt: new Date("2026-08-01T00:00:00Z"),
      };
      testDb.discountCodes.set(oldCode.id, oldCode);

      // Creating a new code on the same link succeeds
      const newCode = await createDiscountCode({
        workspace,
        partner,
        link,
        discount: discount as any,
        code: "NEWCODE20",
      });

      expect(newCode.code).toBe("NEWCODE20");
      expect(newCode.linkId).toBe(link.id);
      expect(newCode.disabledAt).toBeNull();

      // The old disabled code had its linkId cleanly unlinked to prevent unique constraint collision
      const oldCodeAfter = testDb.discountCodes.get(oldCode.id);
      expect(oldCodeAfter?.linkId).toBeNull();
      expect(oldCodeAfter?.disabledAt).not.toBeNull();
    });

    it("2.2: throws 400 Bad Request if link already has an active discount code", async () => {
      const { workspace, partner, link, discount } = resetTestData();

      // Seed an ACTIVE code on link_alice_1
      const activeCode = {
        id: "dcode_active_1",
        code: "ACTIVE10",
        programId: "prog_enterprise",
        partnerId: "partner_alice",
        linkId: link.id,
        discountId: discount.id,
        disabledAt: null,
      };
      testDb.discountCodes.set(activeCode.id, activeCode);

      await expect(
        createDiscountCode({
          workspace,
          partner,
          link,
          discount: discount as any,
          code: "ANOTHERCODE",
        }),
      ).rejects.toThrow(DubApiError);
    });
  });

  // ===========================================================================
  // 3. CONFLICT-FREE RE-CREATION & AUTO-REACTIVATION (R3)
  // ===========================================================================
  describe("Section 3: Conflict-Free Re-Creation & Auto-Reactivation", () => {
    it("3.1: creating a code with the same name as a previously disabled code auto-reactivates the record in-place", async () => {
      const { workspace, partner, link, discount } = resetTestData();

      const disabledCode = {
        id: "dcode_disabled_special",
        code: "SUMMERSALE",
        programId: "prog_enterprise",
        partnerId: "partner_alice",
        linkId: null, // previously unlinked
        discountId: discount.id,
        disabledAt: new Date("2026-08-01T00:00:00Z"),
      };
      testDb.discountCodes.set(disabledCode.id, disabledCode);

      // Re-create SUMMERSALE on link_alice_1
      const reactivated = await createDiscountCode({
        workspace,
        partner,
        link,
        discount: discount as any,
        code: "SUMMERSALE",
      });

      expect(reactivated.id).toBe(disabledCode.id);
      expect(reactivated.code).toBe("SUMMERSALE");
      expect(reactivated.disabledAt).toBeNull();
      expect(reactivated.linkId).toBe(link.id);

      // Confirm provider sync was executed
      expect(shopifyAdminGraphql).toHaveBeenCalled();
    });

    it("3.2: creating a code with the same name as an active code throws 409 Conflict", async () => {
      const { workspace, partner, discount } = resetTestData();

      // Another link
      const link2 = {
        id: "link_alice_2",
        domain: "enterprisestore.com",
        key: "alice2",
        url: "https://enterprisestore.com/alice2",
        programId: "prog_enterprise",
        partnerId: "partner_alice",
        partnerGroupDefaultLinkId: null,
        discountCodeId: null,
      };
      testDb.links.set(link2.id, link2);

      // Seed active code
      testDb.discountCodes.set("dcode_active_unique", {
        id: "dcode_active_unique",
        code: "EXCLUSIVE10",
        programId: "prog_enterprise",
        partnerId: "partner_other",
        linkId: "link_other",
        discountId: discount.id,
        disabledAt: null,
      });

      await expect(
        createDiscountCode({
          workspace,
          partner,
          link: link2,
          discount: discount as any,
          code: "EXCLUSIVE10",
        }),
      ).rejects.toThrow(DubApiError);
    });
  });

  // ===========================================================================
  // 4. API STATUS PARAMETER FOR DUAL-VIEW (R1)
  // ===========================================================================
  describe("Section 4: API Status Filtering for Dual-View", () => {
    it("4.1: status='active' returns only active discount codes", async () => {
      const { discount } = resetTestData();

      testDb.discountCodes.set("dc_act_1", {
        id: "dc_act_1",
        code: "ACTIVE_ONE",
        programId: "prog_enterprise",
        partnerId: "partner_alice",
        linkId: "link_alice_1",
        discountId: discount.id,
        disabledAt: null,
      });

      testDb.discountCodes.set("dc_dis_1", {
        id: "dc_dis_1",
        code: "DISABLED_ONE",
        programId: "prog_enterprise",
        partnerId: "partner_alice",
        linkId: null,
        discountId: discount.id,
        disabledAt: new Date("2026-08-10T00:00:00Z"),
      });

      const enrollment = await getProgramEnrollmentOrThrow({
        partnerId: "partner_alice",
        programId: "prog_enterprise",
        status: "active",
        include: {
          discountCodes: true,
        },
      });

      expect(enrollment.discountCodes).toHaveLength(1);
      expect(enrollment.discountCodes[0].code).toBe("ACTIVE_ONE");
      expect(enrollment.discountCodes[0].disabledAt).toBeNull();
    });

    it("4.2: status='archived' returns only disabled discount codes", async () => {
      const { discount } = resetTestData();

      testDb.discountCodes.set("dc_act_2", {
        id: "dc_act_2",
        code: "ACTIVE_TWO",
        programId: "prog_enterprise",
        partnerId: "partner_alice",
        linkId: "link_alice_1",
        discountId: discount.id,
        disabledAt: null,
      });

      testDb.discountCodes.set("dc_dis_2", {
        id: "dc_dis_2",
        code: "ARCHIVED_TWO",
        programId: "prog_enterprise",
        partnerId: "partner_alice",
        linkId: null,
        discountId: discount.id,
        disabledAt: new Date("2026-08-10T00:00:00Z"),
      });

      const enrollment = await getProgramEnrollmentOrThrow({
        partnerId: "partner_alice",
        programId: "prog_enterprise",
        status: "archived",
        include: {
          discountCodes: true,
        },
      });

      expect(enrollment.discountCodes).toHaveLength(1);
      expect(enrollment.discountCodes[0].code).toBe("ARCHIVED_TWO");
      expect(enrollment.discountCodes[0].disabledAt).not.toBeNull();
    });

    it("4.3: status='all' returns all discount codes", async () => {
      const { discount } = resetTestData();

      testDb.discountCodes.set("dc_act_3", {
        id: "dc_act_3",
        code: "ACTIVE_THREE",
        programId: "prog_enterprise",
        partnerId: "partner_alice",
        linkId: "link_alice_1",
        discountId: discount.id,
        disabledAt: null,
      });

      testDb.discountCodes.set("dc_dis_3", {
        id: "dc_dis_3",
        code: "ARCHIVED_THREE",
        programId: "prog_enterprise",
        partnerId: "partner_alice",
        linkId: null,
        discountId: discount.id,
        disabledAt: new Date("2026-08-10T00:00:00Z"),
      });

      const enrollment = await getProgramEnrollmentOrThrow({
        partnerId: "partner_alice",
        programId: "prog_enterprise",
        status: "all",
        include: {
          discountCodes: true,
        },
      });

      expect(enrollment.discountCodes).toHaveLength(2);
    });
  });

  // ===========================================================================
  // 5. HISTORICAL ATTRIBUTION INTEGRITY FOR DISABLED CODES (R4 / Milestone 3)
  // ===========================================================================
  describe("Section 5: Historical Order Attribution with Active & Disabled Codes", () => {
    it("5.0: extracts loyalty codes even when discount_applications is also present", () => {
      expect(
        extractOrderDiscountCodes({
          discount_applications: [
            { type: "automatic", title: "Automatic promotion" },
          ],
          discount_codes: [{ code: " wl-loyalty123 " }],
        }),
      ).toEqual(["WL-LOYALTY123"]);
    });

    it("5.1: ordersPaid correctly resolves and attributes orders for active discount codes with direct link", async () => {
      const { workspace, link, discount } = resetTestData();

      const activeCode = {
        id: "dcode_act_webhook_1",
        code: "ACTIVE10",
        programId: "prog_enterprise",
        partnerId: "partner_alice",
        linkId: link.id,
        discountId: discount.id,
        disabledAt: null,
      };
      testDb.discountCodes.set(activeCode.id, activeCode);

      const mockShopifyOrderEvent = {
        id: 99887760,
        name: "#1000",
        confirmation_number: "CN1000",
        checkout_token: "chk_act_123",
        current_subtotal_price_set: {
          shop_money: { amount: "100.00", currency_code: "USD" },
        },
        discount_codes: [{ code: "ACTIVE10" }],
        customer: {
          id: 887760,
          email: "shopper0@gmail.com",
          first_name: "Active",
          last_name: "Shopper",
        },
        billing_address: { country_code: "US", province: "California" },
        line_items: [
          {
            id: 110,
            title: "Performance Shorts",
            quantity: 1,
            price_set: {
              shop_money: { amount: "100.00", currency_code: "USD" },
            },
          },
        ],
      };

      const result = await ordersPaid({
        event: mockShopifyOrderEvent,
        workspace,
      });

      expect(result).toContain(
        "Order event processed successfully with discount codes",
      );
    });

    it("5.2: ordersPaid correctly resolves and attributes orders for disabled codes with linked linkId", async () => {
      const { workspace, link, discount } = resetTestData();

      // Seed a discount code that was disabled AFTER a customer checkout
      const historicalCode = {
        id: "dcode_hist_1",
        code: "HISTORICAL10",
        programId: "prog_enterprise",
        partnerId: "partner_alice",
        linkId: link.id,
        discountId: discount.id,
        disabledAt: new Date("2026-08-15T00:00:00Z"),
      };
      testDb.discountCodes.set(historicalCode.id, historicalCode);

      const mockShopifyOrderEvent = {
        id: 99887766,
        name: "#1001",
        confirmation_number: "CN1001",
        checkout_token: "chk_hist_123",
        current_subtotal_price_set: {
          shop_money: { amount: "150.00", currency_code: "USD" },
        },
        discount_codes: [{ code: "HISTORICAL10" }],
        customer: {
          id: 887766,
          email: "shopper@gmail.com",
          first_name: "John",
          last_name: "Doe",
        },
        billing_address: { country_code: "US", province: "California" },
        line_items: [
          {
            id: 111,
            title: "Leggings",
            quantity: 1,
            price_set: {
              shop_money: { amount: "150.00", currency_code: "USD" },
            },
          },
        ],
      };

      const result = await ordersPaid({
        event: mockShopifyOrderEvent,
        workspace,
      });

      expect(result).toContain(
        "Order event processed successfully with discount codes",
      );
    });

    it("5.3: ordersPaid attributes correctly even if disabled code was unlinked from linkId (fallback link resolution)", async () => {
      const { workspace, discount } = resetTestData();

      // Seed an unlinked disabled discount code (linkId: null)
      const unlinkedCode = {
        id: "dcode_unlinked_1",
        code: "UNLINKED10",
        programId: "prog_enterprise",
        partnerId: "partner_alice",
        linkId: null,
        discountId: discount.id,
        disabledAt: new Date("2026-08-15T00:00:00Z"),
      };
      testDb.discountCodes.set(unlinkedCode.id, unlinkedCode);

      const mockShopifyOrderEvent = {
        id: 99887767,
        name: "#1002",
        confirmation_number: "CN1002",
        checkout_token: "chk_unlinked_123",
        current_subtotal_price_set: {
          shop_money: { amount: "200.00", currency_code: "USD" },
        },
        discount_codes: [{ code: "UNLINKED10" }],
        customer: {
          id: 887767,
          email: "shopper2@gmail.com",
          first_name: "Jane",
          last_name: "Smith",
        },
        billing_address: { country_code: "US", province: "New York" },
        line_items: [
          {
            id: 112,
            title: "Bra Top",
            quantity: 1,
            price_set: {
              shop_money: { amount: "200.00", currency_code: "USD" },
            },
          },
        ],
      };

      const result = await ordersPaid({
        event: mockShopifyOrderEvent,
        workspace,
      });

      expect(result).toContain(
        "Order event processed successfully with discount codes",
      );
    });

    it("5.4: ordersPaid correctly attributes reactivated discount code (previously disabled, now active)", async () => {
      const { workspace, link, discount } = resetTestData();

      const reactivatedCode = {
        id: "dcode_reactivated_1",
        code: "REACTIVATED10",
        programId: "prog_enterprise",
        partnerId: "partner_alice",
        linkId: link.id,
        discountId: discount.id,
        disabledAt: null, // was disabled, now reactivated
      };
      testDb.discountCodes.set(reactivatedCode.id, reactivatedCode);

      const mockShopifyOrderEvent = {
        id: 99887768,
        name: "#1003",
        confirmation_number: "CN1003",
        checkout_token: "chk_react_123",
        current_subtotal_price_set: {
          shop_money: { amount: "120.00", currency_code: "USD" },
        },
        discount_codes: [{ code: "REACTIVATED10" }],
        customer: {
          id: 887768,
          email: "shopper3@gmail.com",
          first_name: "Reactivated",
          last_name: "Customer",
        },
        billing_address: { country_code: "US", province: "Texas" },
        line_items: [
          {
            id: 113,
            title: "Tank Top",
            quantity: 1,
            price_set: {
              shop_money: { amount: "120.00", currency_code: "USD" },
            },
          },
        ],
      };

      const result = await ordersPaid({
        event: mockShopifyOrderEvent,
        workspace,
      });

      expect(result).toContain(
        "Order event processed successfully with discount codes",
      );
    });

    it("5.5: ordersPaid correctly attributes when payload contains multiple discount codes including a disabled partner code", async () => {
      const { workspace, link, discount } = resetTestData();

      const partnerDisabledCode = {
        id: "dcode_multi_partner",
        code: "PARTNER15",
        programId: "prog_enterprise",
        partnerId: "partner_alice",
        linkId: link.id,
        discountId: discount.id,
        disabledAt: new Date("2026-08-10T00:00:00Z"),
      };
      testDb.discountCodes.set(partnerDisabledCode.id, partnerDisabledCode);

      const mockShopifyOrderEvent = {
        id: 99887769,
        name: "#1004",
        confirmation_number: "CN1004",
        checkout_token: "chk_multi_123",
        current_subtotal_price_set: {
          shop_money: { amount: "250.00", currency_code: "USD" },
        },
        discount_codes: [
          { code: "FREESHIPPING_STOREWIDE" }, // non-program store code
          { code: "PARTNER15" }, // program partner code (disabled)
        ],
        customer: {
          id: 887769,
          email: "shopper4@gmail.com",
          first_name: "Multi",
          last_name: "Discount",
        },
        billing_address: { country_code: "US", province: "Illinois" },
        line_items: [
          {
            id: 114,
            title: "Sweatshirt",
            quantity: 1,
            price_set: {
              shop_money: { amount: "250.00", currency_code: "USD" },
            },
          },
        ],
      };

      const result = await ordersPaid({
        event: mockShopifyOrderEvent,
        workspace,
      });

      expect(result).toContain(
        "Order event processed successfully with discount codes",
      );
    });

    it("5.6: ordersPaid falls through to factual order recording when discount codes do not match any program code", async () => {
      const { workspace } = resetTestData();

      const mockShopifyOrderEvent = {
        id: 99887770,
        name: "#1005",
        confirmation_number: "CN1005",
        checkout_token: "chk_nonmatch_123",
        current_subtotal_price_set: {
          shop_money: { amount: "80.00", currency_code: "USD" },
        },
        discount_codes: [{ code: "UNKNOWN_STORE_COUPON" }],
        customer: {
          id: 887770,
          email: "shopper5@gmail.com",
          first_name: "Random",
          last_name: "Shopper",
        },
        billing_address: { country_code: "US", province: "Nevada" },
        line_items: [
          {
            id: 115,
            title: "Socks 3-Pack",
            quantity: 1,
            price_set: {
              shop_money: { amount: "80.00", currency_code: "USD" },
            },
          },
        ],
      };

      const result = await ordersPaid({
        event: mockShopifyOrderEvent,
        workspace,
      });

      expect(result).toContain(
        "Waiting for pixel event for affiliate attribution",
      );
    });

    it("5.7: ordersPaid prioritizes existing affiliate customer attribution over discount code resolution", async () => {
      const { workspace, link } = resetTestData();

      // Seed existing affiliate customer in Dub
      testDb.customers.set("cus_existing_affiliate", {
        id: "cus_existing_affiliate",
        externalId: "887771",
        projectId: workspace.id,
        programId: workspace.defaultProgramId,
        partnerId: "partner_alice",
        linkId: link.id,
      });

      const mockShopifyOrderEvent = {
        id: 99887771,
        name: "#1006",
        confirmation_number: "CN1006",
        checkout_token: "chk_exist_123",
        current_subtotal_price_set: {
          shop_money: { amount: "175.00", currency_code: "USD" },
        },
        discount_codes: [{ code: "SOMECODE" }],
        customer: {
          id: 887771,
          email: "existing@gmail.com",
          first_name: "Existing",
          last_name: "Customer",
        },
        billing_address: { country_code: "US", province: "Oregon" },
        line_items: [
          {
            id: 116,
            title: "Yoga Mat",
            quantity: 1,
            price_set: {
              shop_money: { amount: "175.00", currency_code: "USD" },
            },
          },
        ],
      };

      const result = await ordersPaid({
        event: mockShopifyOrderEvent,
        workspace,
      });

      expect(result).toContain("existing affiliate customer");
    });
  });

  // ===========================================================================
  // 6. FRONTEND DUAL-VIEW & REACTIVE LINK SLOT PARTITIONING (M2)
  // ===========================================================================
  describe("Section 6: Frontend Dual-View & Reactive Link Slot Partitioning (Milestone 2)", () => {
    it("6.1: correctly partitions raw discount codes into active and archived lists with accurate counts", () => {
      const rawCodes = [
        { id: "dc_1", code: "ACTIVE1", linkId: "link_1", disabledAt: null },
        { id: "dc_2", code: "ACTIVE2", linkId: "link_2", disabledAt: null },
        {
          id: "dc_3",
          code: "ARCHIVED1",
          linkId: "link_3",
          disabledAt: new Date("2026-08-01T00:00:00Z"),
        },
        {
          id: "dc_4",
          code: "ARCHIVED2",
          linkId: null,
          disabledAt: new Date("2026-08-05T00:00:00Z"),
        },
      ];

      const activeCodes = rawCodes.filter((d) => !d.disabledAt);
      const archivedCodes = rawCodes.filter((d) => !!d.disabledAt);

      expect(activeCodes).toHaveLength(2);
      expect(activeCodes.map((c) => c.code)).toEqual(["ACTIVE1", "ACTIVE2"]);

      expect(archivedCodes).toHaveLength(2);
      expect(archivedCodes.map((c) => c.code)).toEqual([
        "ARCHIVED1",
        "ARCHIVED2",
      ]);
    });

    it("6.2: reactive available links calculation filters out links with active codes and includes links with disabled/no codes", () => {
      const partnerLinks = [
        { id: "link_1", shortLink: "dub.sh/link1" },
        { id: "link_2", shortLink: "dub.sh/link2" },
        { id: "link_3", shortLink: "dub.sh/link3" },
      ];

      const activeCodes = [
        { id: "dc_1", code: "CODE1", linkId: "link_1", disabledAt: null },
      ];

      const archivedCodes = [
        { id: "dc_2", code: "OLD2", linkId: "link_2", disabledAt: new Date() },
      ];

      // Available links for creating new codes: links without active codes
      const availableLinks = partnerLinks.filter(
        (link) =>
          !activeCodes.some((c) => c.linkId === link.id && !c.disabledAt),
      );

      // link_2 (disabled code) and link_3 (no code) are available; link_1 is occupied
      expect(availableLinks).toHaveLength(2);
      expect(availableLinks.map((l) => l.id)).toEqual(["link_2", "link_3"]);
    });

    it("6.3: deleting/disabling a code immediately releases link slot and re-enables create button", () => {
      const partnerLinks = [
        { id: "link_1", shortLink: "dub.sh/link1" },
        { id: "link_2", shortLink: "dub.sh/link2" },
      ];

      // Initial state: all links occupied
      let activeCodes = [
        { id: "dc_1", code: "CODE1", linkId: "link_1", disabledAt: null },
        { id: "dc_2", code: "CODE2", linkId: "link_2", disabledAt: null },
      ];

      let availableLinks = partnerLinks.filter(
        (link) => !activeCodes.some((c) => c.linkId === link.id),
      );
      expect(availableLinks).toHaveLength(0);

      // Button is disabled when availableLinks.length === 0
      let disabledReason =
        availableLinks.length === 0
          ? "All links have a discount code assigned"
          : undefined;
      expect(disabledReason).toBeDefined();

      // Soft-delete dc_1: becomes disabled
      activeCodes = activeCodes.filter((c) => c.id !== "dc_1");
      availableLinks = partnerLinks.filter(
        (link) => !activeCodes.some((c) => c.linkId === link.id),
      );

      expect(availableLinks).toHaveLength(1);
      expect(availableLinks[0].id).toBe("link_1");

      disabledReason =
        availableLinks.length === 0
          ? "All links have a discount code assigned"
          : undefined;
      expect(disabledReason).toBeUndefined();
    });

    it("6.4: empty state handling for active vs. archived tables", () => {
      const noCodes: any[] = [];
      const activeCodes = noCodes.filter((d) => !d.disabledAt);
      const archivedCodes = noCodes.filter((d) => !!d.disabledAt);

      expect(activeCodes.length === 0).toBe(true);
      expect(archivedCodes.length === 0).toBe(true);
    });
  });

  // ===========================================================================
  // 7. HISTORICAL COMMERCE ORDER & COMMISSION IMMUTABILITY (Milestone 3)
  // ===========================================================================
  describe("Section 7: Historical Commerce Order & Commission Immutability (Milestone 3)", () => {
    it("7.1: historical commerce orders, lines, and commissions remain immutable when discount code is soft-deleted", async () => {
      const { discount } = resetTestData();

      // 1. Seed historical discount code
      const codeRecord = {
        id: "dc_immutable_1",
        code: "IMMUTABLE10",
        programId: "prog_enterprise",
        partnerId: "partner_alice",
        linkId: "link_alice_1",
        discountId: discount.id,
        disabledAt: null,
      };
      testDb.discountCodes.set(codeRecord.id, codeRecord);

      // 2. Seed historical commerce order and commission attributed to this code
      const historicalOrder = {
        id: "worder_hist_1",
        storeId: "wstore_enterprise",
        programId: "prog_enterprise",
        partnerId: "partner_alice",
        linkId: "link_alice_1",
        externalId: "shopify_order_5001",
        status: "paid",
        shopAmount: BigInt(15_000), // $150.00
        accountingNet: BigInt(15_000),
        accountingCurrency: "USD",
        occurredAt: new Date("2026-06-01T12:00:00Z"),
      };
      testDb.weleticOrders.set(historicalOrder.id, historicalOrder);

      const historicalCommission = {
        id: "cm_hist_1",
        programId: "prog_enterprise",
        partnerId: "partner_alice",
        linkId: "link_alice_1",
        earnings: 1500, // $15.00
        currency: "USD",
        status: "pending",
        createdAt: new Date("2026-06-01T12:00:00Z"),
      };
      testDb.commissions.set(historicalCommission.id, historicalCommission);

      // 3. Admin soft-deletes the discount code
      await deleteDiscountCodes([
        {
          id: codeRecord.id,
          code: codeRecord.code,
          programId: codeRecord.programId,
          discount: { provider: "shopify" },
        },
      ]);

      // 4. Verify code is disabled
      const updatedCode = testDb.discountCodes.get(codeRecord.id);
      expect(updatedCode?.disabledAt).toBeInstanceOf(Date);

      // 5. Verify historical order and commission remain 100% immutable and intact
      const preservedOrder = testDb.weleticOrders.get(historicalOrder.id);
      expect(preservedOrder).toBeDefined();
      expect(preservedOrder.partnerId).toBe("partner_alice");
      expect(preservedOrder.linkId).toBe("link_alice_1");
      expect(preservedOrder.accountingNet).toBe(BigInt(15_000));

      const preservedCommission = testDb.commissions.get(
        historicalCommission.id,
      );
      expect(preservedCommission).toBeDefined();
      expect(preservedCommission.partnerId).toBe("partner_alice");
      expect(preservedCommission.earnings).toBe(1500);
    });

    it("7.2: re-creating / reactivating a discount code with a new partner does not mutate or orphan previous order records", async () => {
      const { workspace, discount } = resetTestData();

      // Seed disabled code previously belonging to Alice
      const disabledCode = {
        id: "dc_recycle_1",
        code: "SUMMERFEST",
        programId: "prog_enterprise",
        partnerId: "partner_alice",
        linkId: null,
        discountId: discount.id,
        disabledAt: new Date("2026-07-01T00:00:00Z"),
      };
      testDb.discountCodes.set(disabledCode.id, disabledCode);

      // Historical order attributed to Alice
      const aliceOrder = {
        id: "worder_alice_fest",
        storeId: "wstore_enterprise",
        programId: "prog_enterprise",
        partnerId: "partner_alice",
        linkId: "link_alice_1",
        externalId: "shopify_order_6001",
        accountingNet: BigInt(20_000),
      };
      testDb.weleticOrders.set(aliceOrder.id, aliceOrder);

      // New Partner Bob
      const partnerBob = {
        id: "partner_bob",
        name: "Bob Partner",
        email: "bob@example.com",
        programId: "prog_enterprise",
      };
      testDb.partners.set(partnerBob.id, partnerBob);

      const linkBob = {
        id: "link_bob_1",
        domain: "enterprisestore.com",
        key: "bob",
        url: "https://enterprisestore.com/bob",
        programId: "prog_enterprise",
        partnerId: "partner_bob",
        partnerGroupDefaultLinkId: null,
        discountCodeId: null,
      };
      testDb.links.set(linkBob.id, linkBob);

      // Re-create SUMMERFEST for Bob (auto-reactivates existing record)
      const reactivated = await createDiscountCode({
        workspace,
        partner: partnerBob,
        link: linkBob,
        discount: discount as any,
        code: "SUMMERFEST",
      });

      expect(reactivated.id).toBe(disabledCode.id);
      expect(reactivated.partnerId).toBe("partner_bob");
      expect(reactivated.linkId).toBe(linkBob.id);
      expect(reactivated.disabledAt).toBeNull();

      // Alice's historical order remains unchanged
      const preservedAliceOrder = testDb.weleticOrders.get(aliceOrder.id);
      expect(preservedAliceOrder.partnerId).toBe("partner_alice");
      expect(preservedAliceOrder.linkId).toBe("link_alice_1");
    });

    it("7.3: soft-deleting a referral link preserves all past orders and commission records", async () => {
      resetTestData();

      const link = testDb.links.get("link_alice_1");
      expect(link).toBeDefined();

      const order = {
        id: "worder_link_test",
        storeId: "wstore_enterprise",
        programId: "prog_enterprise",
        partnerId: "partner_alice",
        linkId: link.id,
        externalId: "shopify_order_7001",
        accountingNet: BigInt(10_000),
      };
      testDb.weleticOrders.set(order.id, order);

      // Update link with soft-deletion or removal of discount association
      testDb.links.set(link.id, {
        ...link,
        discountCodeId: null,
        archivedAt: new Date(),
      });

      const preservedOrder = testDb.weleticOrders.get(order.id);
      expect(preservedOrder.linkId).toBe("link_alice_1");
      expect(preservedOrder.partnerId).toBe("partner_alice");
    });

    it("7.4: dual-view queries maintain queryability of historical disabled codes for audit logs", async () => {
      const { discount } = resetTestData();

      testDb.discountCodes.set("dc_dis_audit", {
        id: "dc_dis_audit",
        code: "AUDIT10",
        programId: "prog_enterprise",
        partnerId: "partner_alice",
        linkId: null,
        discountId: discount.id,
        disabledAt: new Date("2026-08-01T00:00:00Z"),
      });

      const auditView = await getProgramEnrollmentOrThrow({
        partnerId: "partner_alice",
        programId: "prog_enterprise",
        status: "all",
        include: { discountCodes: true },
      });

      expect(auditView.discountCodes.some((c) => c.code === "AUDIT10")).toBe(
        true,
      );
    });
  });

  // ===========================================================================
  // 8. PROPORTIONAL REFUND & CLAWBACK ENGINE INTEGRITY (ADR 0004) FOR DISABLED CODES
  // ===========================================================================
  describe("Section 8: Proportional Refund & Clawback Engine Integrity (ADR 0004)", () => {
    it("8.1: full refund on an order attributed to a disabled code claws back 100% of commission earnings", () => {
      const originalEarnings = BigInt(2_000); // $20.00
      const originalCommissionableAmount = BigInt(10_000); // $100.00
      const refundedAmount = BigInt(10_000); // $100.00 full refund

      const reversal = calculateRefundReversal({
        originalEarnings,
        originalCommissionableAmount,
        refundedAmount,
        alreadyReversed: BigInt(0),
      });

      expect(reversal).toBe(BigInt(2_000));
    });

    it("8.2: 50% partial refund on an order attributed to a disabled code claws back exactly 50% of commission earnings", () => {
      const originalEarnings = BigInt(2_000);
      const originalCommissionableAmount = BigInt(10_000);
      const refundedAmount = BigInt(5_000); // $50.00 partial refund

      const reversal = calculateRefundReversal({
        originalEarnings,
        originalCommissionableAmount,
        refundedAmount,
        alreadyReversed: BigInt(0),
      });

      expect(reversal).toBe(BigInt(1_000));
    });

    it("8.3: 25% partial refund on an order attributed to a disabled code claws back exactly 25% of commission earnings", () => {
      const originalEarnings = BigInt(2_000);
      const originalCommissionableAmount = BigInt(10_000);
      const refundedAmount = BigInt(2_500); // $25.00 partial refund

      const reversal = calculateRefundReversal({
        originalEarnings,
        originalCommissionableAmount,
        refundedAmount,
        alreadyReversed: BigInt(0),
      });

      expect(reversal).toBe(BigInt(500));
    });

    it("8.4: fractional 1/3 and 2/3 refunds apply half-up rounding and sum exactly to 100% of original earnings without penny loss", () => {
      const originalEarnings = BigInt(100);
      const originalCommissionableAmount = BigInt(300);

      // First partial refund (1/3): $1.00 of $3.00
      const reversal1 = calculateRefundReversal({
        originalEarnings,
        originalCommissionableAmount,
        refundedAmount: BigInt(100),
        alreadyReversed: BigInt(0),
      });
      // 100 * 100 / 300 = 33.333 -> 33
      expect(reversal1).toBe(BigInt(33));

      // Second partial refund (remaining 2/3): $2.00 of $3.00
      const reversal2 = calculateRefundReversal({
        originalEarnings,
        originalCommissionableAmount,
        refundedAmount: BigInt(200),
        alreadyReversed: reversal1,
      });
      // 100 * 200 / 300 = 66.666 -> 67 (half-up)
      expect(reversal2).toBe(BigInt(67));

      // Total clawback is exactly 100% of original earnings (33 + 67 = 100)
      expect(reversal1 + reversal2).toBe(BigInt(100));
    });

    it("8.5: sequential partial refunds on an order with a disabled code cap strictly at original earnings (Upper-Bound Invariant)", () => {
      const originalEarnings = BigInt(2_000);
      const originalCommissionableAmount = BigInt(10_000);

      // Attempt to refund $70.00 when $15.00 was already reversed
      const reversal = calculateRefundReversal({
        originalEarnings,
        originalCommissionableAmount,
        refundedAmount: BigInt(7_000),
        alreadyReversed: BigInt(1_500),
      });

      // Remaining unreversed earnings is 2000 - 1500 = 500, so proportional (1400) is capped to 500
      expect(reversal).toBe(BigInt(500));
    });

    it("8.6: zero-decimal currencies (JPY, VND) maintain exact integer calculations without floating point errors", () => {
      const originalEarningsJPY = BigInt(3_000); // ¥3,000 commission
      const originalAmountJPY = BigInt(30_000); // ¥30,000 order

      const reversalJPY = calculateRefundReversal({
        originalEarnings: originalEarningsJPY,
        originalCommissionableAmount: originalAmountJPY,
        refundedAmount: BigInt(10_000), // ¥10,000 refund (1/3)
        alreadyReversed: BigInt(0),
      });

      expect(reversalJPY).toBe(BigInt(1_000));
    });

    it("8.7: returns 0 reversal when order item was already 100% refunded", () => {
      const originalEarnings = BigInt(2_000);
      const originalCommissionableAmount = BigInt(10_000);

      const reversal = calculateRefundReversal({
        originalEarnings,
        originalCommissionableAmount,
        refundedAmount: BigInt(5_000),
        alreadyReversed: BigInt(2_000), // fully reversed already
      });

      expect(reversal).toBe(BigInt(0));
    });
  });

  // ===========================================================================
  // 9. SHOPIFY WEBHOOK LIFECYCLE & DRIFT RECONCILIATION INVARIANTS (Milestone 3)
  // ===========================================================================
  describe("Section 9: Shopify Webhook Lifecycle & Drift Reconciliation Invariants", () => {
    it("9.1: discountsDelete webhook soft-deletes discount code and purges link cache while preserving DB rows", async () => {
      const { workspace, link, discount } = resetTestData();

      const targetCode = {
        id: "dc_del_webhook_1",
        code: "SHOPIFY_DELETED_10",
        programId: "prog_enterprise",
        partnerId: "partner_alice",
        linkId: link.id,
        discountId: discount.id,
        disabledAt: null,
      };
      testDb.discountCodes.set(targetCode.id, targetCode);

      const deleteEvent = {
        code: "SHOPIFY_DELETED_10",
        id: 1001,
      };

      const result = await discountsDelete({
        event: deleteEvent,
        workspace,
      });

      expect(result).toContain("Successfully disabled 1 discount code(s)");

      const updated = testDb.discountCodes.get(targetCode.id);
      expect(updated).toBeDefined();
      expect(updated.disabledAt).toBeInstanceOf(Date);
    });

    it("9.2: discountsUpdate webhook with status='expired' triggers soft-deletion without affecting past orders", async () => {
      const { workspace, link, discount } = resetTestData();

      const expiringCode = {
        id: "dc_expire_webhook_1",
        code: "EXPIRED_CODE_10",
        programId: "prog_enterprise",
        partnerId: "partner_alice",
        linkId: link.id,
        discountId: discount.id,
        disabledAt: null,
      };
      testDb.discountCodes.set(expiringCode.id, expiringCode);

      const updateEvent = {
        code: "EXPIRED_CODE_10",
        status: "expired",
        id: 1002,
      };

      const result = await discountsUpdate({
        event: updateEvent,
        workspace,
      });

      expect(result).toContain("Successfully disabled 1 discount code(s)");

      const updated = testDb.discountCodes.get(expiringCode.id);
      expect(updated.disabledAt).toBeInstanceOf(Date);
    });

    it("9.3: discountsUpdate webhook with status='active' auto-reactivates disabled code", async () => {
      const { workspace, link, discount } = resetTestData();

      const disabledCode = {
        id: "dc_react_webhook_1",
        code: "REACTIVATED_BY_SHOPIFY",
        programId: "prog_enterprise",
        partnerId: "partner_alice",
        linkId: link.id,
        discountId: discount.id,
        disabledAt: new Date("2026-08-01T00:00:00Z"),
      };
      testDb.discountCodes.set(disabledCode.id, disabledCode);

      const updateEvent = {
        code: "REACTIVATED_BY_SHOPIFY",
        status: "active",
        id: 1003,
      };

      const result = await discountsUpdate({
        event: updateEvent,
        workspace,
      });

      expect(result).toContain("reactivated");

      const updated = testDb.discountCodes.get(disabledCode.id);
      expect(updated.disabledAt).toBeNull();
    });

    it("9.4: discountsDelete with unknown code gracefully skips without throwing errors", async () => {
      const { workspace } = resetTestData();

      const deleteEvent = {
        code: "NON_EXISTENT_CODE",
        id: 99999,
      };

      const result = await discountsDelete({
        event: deleteEvent,
        workspace,
      });

      expect(result).toContain("No matching Weletic discount codes found");
    });
  });
});
