import { prisma } from "@/lib/prisma";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Mock withCron to execute handler directly without QStash token verification
vi.mock("@/lib/cron/with-cron", () => ({
  withCron: (handler: any) => async (req: Request, ctx?: any) => {
    const rawBody = await req.text();
    return handler({
      req,
      rawBody,
      params: (await ctx?.params) || {},
      searchParams: {},
    });
  },
}));

// Mock withPartnerProfile
let currentPartnerId = "partner_p1";
vi.mock("@/lib/auth/partner", () => ({
  withPartnerProfile: (handler: any) => {
    return async (
      req: Request,
      ctx: { params?: Promise<Record<string, string>> } = {},
    ) => {
      const params = (await ctx?.params) || {};
      const url = new URL(req.url, "http://localhost");
      const searchParams = Object.fromEntries(url.searchParams.entries());
      return handler({
        req,
        params,
        searchParams,
        partner: { id: currentPartnerId, name: "Empirical Challenger Partner" },
        session: {},
        partnerUser: { userId: "user_u1", role: "member" },
      });
    };
  },
}));

// In-Memory Database for Empirical Verification
interface TestDiscountCode {
  id: string;
  code: string;
  programId: string;
  partnerId: string;
  linkId: string | null;
  discountId: string;
  disabledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface TestLink {
  id: string;
  partnerGroupDefaultLinkId: string | null;
  programEnrollmentId: string;
  projectId: string;
}

interface TestEnrollment {
  id: string;
  partnerId: string;
  programId: string;
  discountId?: string;
  status: string;
}

const db = {
  discountCodes: new Map<string, TestDiscountCode>(),
  links: new Map<string, TestLink>(),
  enrollments: new Map<string, TestEnrollment>(),
  products: new Map<string, any>(),
  markets: new Map<string, any>(),
  rules: new Map<string, any>(),
  discounts: new Map<string, any>(),
  projects: new Map<string, any>(),
  partners: new Map<string, any>(),
  programs: new Map<string, any>(),
};

function resetDb() {
  db.discountCodes.clear();
  db.links.clear();
  db.enrollments.clear();
  db.products.clear();
  db.markets.clear();
  db.rules.clear();
  db.discounts.clear();
  db.projects.clear();
  db.partners.clear();
  db.programs.clear();
}

const mockProviderCreate = vi.fn().mockImplementation(async ({ code }) => ({
  code: code || "GENERATED_CODE",
  id: "ext_disc_123",
}));
const mockProviderDisable = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/discounts/discount-provider", () => ({
  getDiscountProvider: vi.fn(() => ({
    createDiscountCode: mockProviderCreate,
    disableDiscountCode: mockProviderDisable,
    assertDiscountIntegration: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("@/lib/cron", () => ({
  CRON_BATCH_SIZE: 100,
  qstash: {
    publishJSON: vi.fn(),
  },
}));

vi.mock("@/lib/cron/enqueue-batch-jobs", () => ({
  enqueueBatchJobs: vi.fn().mockResolvedValue(undefined),
}));

// Real Prisma mock that actually queries and mutates the in-memory db
vi.mock("@/lib/prisma", () => ({
  prisma: {
    discountCode: {
      findFirst: vi.fn(async ({ where }: any) => {
        for (const dc of db.discountCodes.values()) {
          if (where.linkId !== undefined && dc.linkId !== where.linkId)
            continue;
          if (where.programId !== undefined && dc.programId !== where.programId)
            continue;
          if (where.code !== undefined && dc.code !== where.code) continue;
          if (where.disabledAt === null && dc.disabledAt !== null) continue;
          if (where.disabledAt && where.disabledAt.not !== undefined) {
            if (where.disabledAt.not === null && dc.disabledAt === null)
              continue;
          }
          return { ...dc };
        }
        return null;
      }),
      findMany: vi.fn(async ({ where }: any) => {
        const results: any[] = [];
        for (const dc of db.discountCodes.values()) {
          if (where.linkId !== undefined && dc.linkId !== where.linkId)
            continue;
          if (where.disabledAt === null && dc.disabledAt !== null) continue;
          results.push({ ...dc });
        }
        return results;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const dc of db.discountCodes.values()) {
          let match = true;
          if (where.linkId !== undefined && dc.linkId !== where.linkId)
            match = false;
          if (where.disabledAt !== undefined) {
            if (where.disabledAt === null && dc.disabledAt !== null)
              match = false;
            if (
              where.disabledAt.not !== undefined &&
              where.disabledAt.not === null &&
              dc.disabledAt === null
            )
              match = false;
          }
          if (
            where.id !== undefined &&
            where.id.not !== undefined &&
            dc.id === where.id.not
          )
            match = false;

          if (match) {
            if (data.linkId !== undefined) dc.linkId = data.linkId;
            if (data.disabledAt !== undefined) dc.disabledAt = data.disabledAt;
            dc.updatedAt = new Date();
            count++;
          }
        }
        return { count };
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const dc = db.discountCodes.get(where.id);
        if (!dc) throw new Error("Discount code not found");
        if (data.disabledAt !== undefined) dc.disabledAt = data.disabledAt;
        if (data.linkId !== undefined) dc.linkId = data.linkId;
        if (data.partnerId !== undefined) dc.partnerId = data.partnerId;
        if (data.discountId !== undefined) dc.discountId = data.discountId;
        dc.updatedAt = new Date();
        return { ...dc };
      }),
      create: vi.fn(async ({ data }: any) => {
        const id =
          data.id ||
          `dcode_${Date.now()}_${Math.random().toString(36).substring(7)}`;
        const record: TestDiscountCode = {
          id,
          code: data.code,
          programId: data.programId,
          partnerId: data.partnerId,
          linkId: data.linkId ?? null,
          discountId: data.discountId,
          disabledAt: data.disabledAt ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        db.discountCodes.set(id, record);
        return { ...record };
      }),
    },
    link: {
      findUnique: vi.fn(async ({ where, select }: any) => {
        const link = db.links.get(where.id);
        if (!link) return null;

        const res: any = { id: link.id };

        if (select?.partnerGroupDefaultLinkId) {
          res.partnerGroupDefaultLinkId = link.partnerGroupDefaultLinkId;
        }

        if (select?.project) {
          const project = db.projects.get(link.projectId);
          res.project = project ? { ...project } : null;
        }

        if (select?.programEnrollment) {
          const enr = db.enrollments.get(link.programEnrollmentId);
          if (enr) {
            const partner = db.partners.get(enr.partnerId);
            const program = db.programs.get(enr.programId);
            const discount = enr.discountId
              ? db.discounts.get(enr.discountId)
              : null;
            res.programEnrollment = {
              partner: partner
                ? { ...partner }
                : { id: enr.partnerId, name: "Partner" },
              program: program ? { ...program } : { id: enr.programId },
              discount: discount ? { ...discount } : null,
            };
          } else {
            res.programEnrollment = null;
          }
        }

        if (select?.discountCode) {
          // Check relation filter where: { disabledAt: null }
          let foundCode: TestDiscountCode | null = null;
          for (const dc of db.discountCodes.values()) {
            if (dc.linkId === link.id) {
              if (
                select.discountCode.where?.disabledAt === null &&
                dc.disabledAt !== null
              ) {
                continue;
              }
              foundCode = dc;
              break;
            }
          }
          res.discountCode = foundCode ? { ...foundCode } : null;
        }

        return res;
      }),
    },
    programEnrollment: {
      findUnique: vi.fn(async ({ where, include }: any) => {
        let enrollment: TestEnrollment | undefined;
        if (where.partnerId_programId) {
          const { partnerId, programId } = where.partnerId_programId;
          enrollment = Array.from(db.enrollments.values()).find(
            (e) => e.partnerId === partnerId && e.programId === programId,
          );
        } else if (where.id) {
          enrollment = db.enrollments.get(where.id);
        }
        if (!enrollment) return null;

        const res: any = { ...enrollment };
        if (include?.program) {
          res.program = db.programs.get(enrollment.programId) || {
            id: enrollment.programId,
            accountingCurrency: "USD",
          };
        }
        if (include?.partnerGroup) {
          res.partnerGroup = {
            discount: enrollment.discountId
              ? db.discounts.get(enrollment.discountId)
              : null,
            saleReward: null,
          };
        }
        if (include?.links) {
          const matchingLinks: any[] = [];
          for (const l of db.links.values()) {
            if (l.programEnrollmentId === enrollment.id) {
              const linkObj: any = {
                id: l.id,
                partnerGroupDefaultLinkId: l.partnerGroupDefaultLinkId,
              };
              if (include.links.include?.discountCode) {
                const dcFilter = include.links.include.discountCode.where;
                let foundDc: TestDiscountCode | null = null;
                for (const dc of db.discountCodes.values()) {
                  if (dc.linkId === l.id) {
                    if (
                      dcFilter?.disabledAt === null &&
                      dc.disabledAt !== null
                    ) {
                      continue;
                    }
                    if (
                      dcFilter?.disabledAt?.not !== undefined &&
                      dc.disabledAt === null
                    ) {
                      continue;
                    }
                    foundDc = dc;
                    break;
                  }
                }
                linkObj.discountCode = foundDc ? { ...foundDc } : null;
              }
              matchingLinks.push(linkObj);
            }
          }
          res.links = matchingLinks;
        }
        return res;
      }),
      findMany: vi.fn(async ({ where, select }: any) => {
        const results: any[] = [];
        for (const enr of db.enrollments.values()) {
          if (where.programId && enr.programId !== where.programId) continue;
          if (where.discountId && enr.discountId !== where.discountId) continue;

          const item: any = {
            id: enr.id,
            partnerId: enr.partnerId,
            discountId: enr.discountId,
          };
          if (select?.links) {
            const matchingLinks: any[] = [];
            for (const l of db.links.values()) {
              if (l.programEnrollmentId !== enr.id) continue;
              if (
                select.links.where?.partnerGroupDefaultLinkId?.not !==
                  undefined &&
                l.partnerGroupDefaultLinkId === null
              ) {
                continue;
              }

              // Evaluate OR condition for discountCode
              const orConditions = select.links.where?.OR;
              if (orConditions) {
                // Find discount codes linked to this link
                let linkedDc: TestDiscountCode | null = null;
                for (const dc of db.discountCodes.values()) {
                  if (dc.linkId === l.id) {
                    linkedDc = dc;
                    break;
                  }
                }

                let matchesOr = false;
                for (const cond of orConditions) {
                  if (cond.discountCode === null && linkedDc === null) {
                    matchesOr = true;
                    break;
                  }
                  if (
                    cond.discountCode?.disabledAt?.not !== undefined &&
                    linkedDc &&
                    linkedDc.disabledAt !== null
                  ) {
                    matchesOr = true;
                    break;
                  }
                }
                if (!matchesOr) continue;
              }

              matchingLinks.push({ id: l.id });
            }
            item.links = matchingLinks;
          }
          results.push(item);
        }
        return results;
      }),
      findFirst: vi.fn(async () => null),
    },
    discount: {
      findUnique: vi.fn(async ({ where }: any) => {
        const disc = db.discounts.get(where.id);
        if (!disc) return null;
        return {
          ...disc,
          program: {
            id: disc.programId,
            workspace: {
              id: "ws_emp_1",
              shopifyStoreId: "store.myshopify.com",
            },
          },
        };
      }),
    },
    weleticShopifyProduct: {
      findMany: vi.fn(async ({ where }: any) => {
        return Array.from(db.products.values());
      }),
      findFirst: vi.fn(async ({ where }: any) => {
        return Array.from(db.products.values())[0] || null;
      }),
      count: vi.fn(async () => db.products.size),
    },
    weleticShopifyMarket: {
      findMany: vi.fn(async () => Array.from(db.markets.values())),
    },
    weleticCommissionRule: {
      findMany: vi.fn(async () => Array.from(db.rules.values())),
    },
  },
}));

// Import target routes and real createDiscountCode
import { POST as queueBatchesCron } from "../../app/(ee)/api/cron/discount-codes/create/queue-batches/route";
import { POST as createDiscountCodeCron } from "../../app/(ee)/api/cron/discount-codes/create/route";
import { GET as getPartnerProductById } from "../../app/(ee)/api/partner-profile/programs/[programId]/products/[productId]/route";
import { GET as getPartnerProducts } from "../../app/(ee)/api/partner-profile/programs/[programId]/products/route";

describe("Empirical Challenger: SYNC-03 Soft-Delete Coherence & State Transitions", () => {
  beforeEach(() => {
    resetDb();
    vi.clearAllMocks();
    currentPartnerId = "partner_p1";

    // Setup base workspace, program, discount, partner
    db.projects.set("ws_emp_1", {
      id: "ws_emp_1",
      shopifyStoreId: "empirical-store.myshopify.com",
      stripeConnectId: null,
    });
    db.programs.set("prog_emp_1", {
      id: "prog_emp_1",
      accountingCurrency: "USD",
    });
    db.discounts.set("disc_emp_1", {
      id: "disc_emp_1",
      provider: "shopify",
      programId: "prog_emp_1",
      type: "percentage",
      amount: 15,
      autoProvisionEnabledAt: new Date("2026-01-01"),
    });
    db.partners.set("partner_p1", {
      id: "partner_p1",
      name: "Empirical Tester",
    });
    db.enrollments.set("enr_emp_1", {
      id: "enr_emp_1",
      partnerId: "partner_p1",
      programId: "prog_emp_1",
      discountId: "disc_emp_1",
      status: "active",
    });

    db.products.set("prod_1", {
      id: "prod_1",
      externalId: "gid://shopify/Product/123456",
      title: "Yamax Empirical Leggings",
      handle: "yamax-empirical-leggings",
      descriptionHtml: "<p>Empirical test product</p>",
      featuredImageUrl: "https://example.com/p1.png",
      vendor: "Yamax",
      productType: "Leggings",
      collectionExternalIds: [],
      variants: [
        {
          id: "var_1",
          title: "Default",
          sku: "YMX-EMP-1",
          imageUrl: null,
          shopPrice: BigInt(5000),
          shopCompareAtPrice: null,
          shopCurrency: "USD",
          marketPrices: [],
        },
      ],
      translations: [],
    });
  });

  // =========================================================================
  // Mission 1.1: Verify soft-delete behavior:
  // Create link with soft-deleted code (disabledAt: new Date()) -> verify cron
  // creates replacement code and unlinks disabled code.
  // =========================================================================
  describe("Mission 1.1: Cron Re-provisioning & Link Slot Unlinking State Transition", () => {
    it("Empirically verifies: Link with soft-deleted code causes cron to unlink old code and create active replacement code", async () => {
      const linkId = "link_emp_soft_deleted";
      db.links.set(linkId, {
        id: linkId,
        partnerGroupDefaultLinkId: linkId,
        programEnrollmentId: "enr_emp_1",
        projectId: "ws_emp_1",
      });

      const oldCodeId = "dcode_old_disabled";
      const oldDisabledAt = new Date("2026-08-01T10:00:00Z");
      db.discountCodes.set(oldCodeId, {
        id: oldCodeId,
        code: "OLD_DISABLED_CODE",
        programId: "prog_emp_1",
        partnerId: "partner_p1",
        linkId: linkId, // Initially occupying the link slot
        discountId: "disc_emp_1",
        disabledAt: oldDisabledAt,
        createdAt: new Date("2026-07-01"),
        updatedAt: new Date("2026-08-01"),
      });

      // Verify Pre-condition: link has old disabled code
      expect(db.discountCodes.get(oldCodeId)?.linkId).toBe(linkId);
      expect(db.discountCodes.get(oldCodeId)?.disabledAt).toEqual(
        oldDisabledAt,
      );

      // Invoke the Cron endpoint
      const response = await createDiscountCodeCron(
        new NextRequest("http://localhost/api/cron/discount-codes/create", {
          method: "POST",
          body: JSON.stringify({ linkId }),
        }),
        { params: Promise.resolve({}) },
      );

      // Verify Cron response
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toBe(`Discount code created for link ${linkId}.`);

      // Empirically verify state transitions in DB:
      // 1. The old soft-deleted code MUST be unlinked (linkId set to null)
      const oldCodeAfter = db.discountCodes.get(oldCodeId);
      expect(oldCodeAfter).toBeDefined();
      expect(oldCodeAfter?.linkId).toBeNull();
      expect(oldCodeAfter?.disabledAt).toEqual(oldDisabledAt); // Still disabled

      // 2. A replacement code MUST exist, linked to linkId, with disabledAt: null
      const replacementCodes = Array.from(db.discountCodes.values()).filter(
        (dc) => dc.linkId === linkId,
      );
      expect(replacementCodes).toHaveLength(1);
      const replacement = replacementCodes[0];
      expect(replacement.id).not.toBe(oldCodeId);
      expect(replacement.disabledAt).toBeNull();
      expect(replacement.linkId).toBe(linkId);
      expect(replacement.partnerId).toBe("partner_p1");
    });

    it("Empirically verifies: Active discount code on link is NOT unlinked and cron skips creation", async () => {
      const linkId = "link_emp_active";
      db.links.set(linkId, {
        id: linkId,
        partnerGroupDefaultLinkId: linkId,
        programEnrollmentId: "enr_emp_1",
        projectId: "ws_emp_1",
      });

      const activeCodeId = "dcode_active_curr";
      db.discountCodes.set(activeCodeId, {
        id: activeCodeId,
        code: "ACTIVE_VALID_CODE",
        programId: "prog_emp_1",
        partnerId: "partner_p1",
        linkId: linkId,
        discountId: "disc_emp_1",
        disabledAt: null, // ACTIVE!
        createdAt: new Date("2026-09-01"),
        updatedAt: new Date("2026-09-01"),
      });

      const response = await createDiscountCodeCron(
        new NextRequest("http://localhost/api/cron/discount-codes/create", {
          method: "POST",
          body: JSON.stringify({ linkId }),
        }),
        { params: Promise.resolve({}) },
      );

      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain(
        "already has an active discount code. Skipping...",
      );

      // Empirically verify no mutation:
      expect(db.discountCodes.get(activeCodeId)?.linkId).toBe(linkId);
      expect(db.discountCodes.size).toBe(1);
    });

    it("Empirically verifies: Multiple historically disabled codes on the same link are ALL unlinked", async () => {
      const linkId = "link_multi_disabled";
      db.links.set(linkId, {
        id: linkId,
        partnerGroupDefaultLinkId: linkId,
        programEnrollmentId: "enr_emp_1",
        projectId: "ws_emp_1",
      });

      const dc1 = "dcode_hist_1";
      const dc2 = "dcode_hist_2";
      db.discountCodes.set(dc1, {
        id: dc1,
        code: "HIST_1",
        programId: "prog_emp_1",
        partnerId: "partner_p1",
        linkId: linkId,
        discountId: "disc_emp_1",
        disabledAt: new Date("2026-05-01"),
        createdAt: new Date("2026-04-01"),
        updatedAt: new Date("2026-05-01"),
      });
      db.discountCodes.set(dc2, {
        id: dc2,
        code: "HIST_2",
        programId: "prog_emp_1",
        partnerId: "partner_p1",
        linkId: linkId,
        discountId: "disc_emp_1",
        disabledAt: new Date("2026-06-01"),
        createdAt: new Date("2026-05-01"),
        updatedAt: new Date("2026-06-01"),
      });

      await createDiscountCodeCron(
        new NextRequest("http://localhost/api/cron/discount-codes/create", {
          method: "POST",
          body: JSON.stringify({ linkId }),
        }),
        { params: Promise.resolve({}) },
      );

      // Both historical disabled codes must be unlinked
      expect(db.discountCodes.get(dc1)?.linkId).toBeNull();
      expect(db.discountCodes.get(dc2)?.linkId).toBeNull();

      // Only the new active code holds linkId
      const activeHolders = Array.from(db.discountCodes.values()).filter(
        (dc) => dc.linkId === linkId,
      );
      expect(activeHolders).toHaveLength(1);
      expect(activeHolders[0].disabledAt).toBeNull();
    });
  });

  // =========================================================================
  // Mission 1.2: Verify partner products API returns null for partnerDiscountCode
  // if all discount codes are disabled.
  // =========================================================================
  describe("Mission 1.2: Partner Products Catalog API Soft-Delete Shielding", () => {
    it("Empirically verifies: GET /api/partner-profile/programs/[programId]/products returns couponCode: null when ALL discount codes are disabled", async () => {
      // Create 2 links for the partner, both having disabled discount codes
      const link1 = "link_p1_disabled_1";
      const link2 = "link_p1_disabled_2";
      db.links.set(link1, {
        id: link1,
        partnerGroupDefaultLinkId: link1,
        programEnrollmentId: "enr_emp_1",
        projectId: "ws_emp_1",
      });
      db.links.set(link2, {
        id: link2,
        partnerGroupDefaultLinkId: link2,
        programEnrollmentId: "enr_emp_1",
        projectId: "ws_emp_1",
      });

      db.discountCodes.set("dc_dis_1", {
        id: "dc_dis_1",
        code: "SUMMER_DISABLED_1",
        programId: "prog_emp_1",
        partnerId: "partner_p1",
        linkId: link1,
        discountId: "disc_emp_1",
        disabledAt: new Date("2026-06-01"),
        createdAt: new Date("2026-05-01"),
        updatedAt: new Date("2026-06-01"),
      });
      db.discountCodes.set("dc_dis_2", {
        id: "dc_dis_2",
        code: "AUTUMN_DISABLED_2",
        programId: "prog_emp_1",
        partnerId: "partner_p1",
        linkId: link2,
        discountId: "disc_emp_1",
        disabledAt: new Date("2026-07-01"),
        createdAt: new Date("2026-06-01"),
        updatedAt: new Date("2026-07-01"),
      });

      const response = await getPartnerProducts(
        new NextRequest(
          "http://localhost/api/partner-profile/programs/prog_emp_1/products",
        ),
        { params: Promise.resolve({ programId: "prog_emp_1" }) },
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.products).toHaveLength(1);
      // Crucial: couponCode must be null because all codes are disabled!
      expect(data.products[0].customerDiscount.couponCode).toBeNull();
    });

    it("Empirically verifies: GET /api/partner-profile/programs/[programId]/products/[productId] returns couponCode: null when ALL codes disabled", async () => {
      const link1 = "link_p1_disabled_single";
      db.links.set(link1, {
        id: link1,
        partnerGroupDefaultLinkId: link1,
        programEnrollmentId: "enr_emp_1",
        projectId: "ws_emp_1",
      });
      db.discountCodes.set("dc_single_dis", {
        id: "dc_single_dis",
        code: "ONLY_DISABLED_CODE",
        programId: "prog_emp_1",
        partnerId: "partner_p1",
        linkId: link1,
        discountId: "disc_emp_1",
        disabledAt: new Date("2026-08-01"),
        createdAt: new Date("2026-07-01"),
        updatedAt: new Date("2026-08-01"),
      });

      const response = await getPartnerProductById(
        new NextRequest(
          "http://localhost/api/partner-profile/programs/prog_emp_1/products/prod_1",
        ),
        {
          params: Promise.resolve({
            programId: "prog_emp_1",
            productId: "prod_1",
          }),
        },
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.product.customerDiscount.couponCode).toBeNull();
    });

    it("Empirically verifies: Partner Products API returns active code when 1 of multiple links is active", async () => {
      const linkDisabled = "link_part_dis";
      const linkActive = "link_part_act";

      db.links.set(linkDisabled, {
        id: linkDisabled,
        partnerGroupDefaultLinkId: linkDisabled,
        programEnrollmentId: "enr_emp_1",
        projectId: "ws_emp_1",
      });
      db.links.set(linkActive, {
        id: linkActive,
        partnerGroupDefaultLinkId: linkActive,
        programEnrollmentId: "enr_emp_1",
        projectId: "ws_emp_1",
      });

      db.discountCodes.set("dc_dis", {
        id: "dc_dis",
        code: "STALE_DISABLED_CODE",
        programId: "prog_emp_1",
        partnerId: "partner_p1",
        linkId: linkDisabled,
        discountId: "disc_emp_1",
        disabledAt: new Date("2026-05-01"),
        createdAt: new Date("2026-04-01"),
        updatedAt: new Date("2026-05-01"),
      });
      db.discountCodes.set("dc_act", {
        id: "dc_act",
        code: "FRESH_ACTIVE_CODE",
        programId: "prog_emp_1",
        partnerId: "partner_p1",
        linkId: linkActive,
        discountId: "disc_emp_1",
        disabledAt: null, // Active
        createdAt: new Date("2026-08-01"),
        updatedAt: new Date("2026-08-01"),
      });

      const response = await getPartnerProducts(
        new NextRequest(
          "http://localhost/api/partner-profile/programs/prog_emp_1/products",
        ),
        { params: Promise.resolve({ programId: "prog_emp_1" }) },
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.products[0].customerDiscount.couponCode).toBe(
        "FRESH_ACTIVE_CODE",
      );
    });
  });

  // =========================================================================
  // Mission 1.3: Queue Batches route query filter verification
  // =========================================================================
  describe("Mission 1.3: Queue-Batches Soft-Delete Filter Stress Test", () => {
    it("Empirically verifies: queue-batches accurately selects links with disabled codes or null codes, and skips links with active codes", async () => {
      // Enrollment 1: Link A (null code), Link B (soft-deleted code), Link C (active code)
      const enrId = "enr_emp_batch";
      db.enrollments.set(enrId, {
        id: enrId,
        partnerId: "partner_batch",
        programId: "prog_emp_1",
        discountId: "disc_emp_1",
        status: "active",
      });

      const linkNull = "link_with_no_code";
      const linkDisabled = "link_with_disabled_code";
      const linkActive = "link_with_active_code";
      const linkNonDefault = "link_non_default_disabled";

      db.links.set(linkNull, {
        id: linkNull,
        partnerGroupDefaultLinkId: linkNull,
        programEnrollmentId: enrId,
        projectId: "ws_emp_1",
      });
      db.links.set(linkDisabled, {
        id: linkDisabled,
        partnerGroupDefaultLinkId: linkDisabled,
        programEnrollmentId: enrId,
        projectId: "ws_emp_1",
      });
      db.links.set(linkActive, {
        id: linkActive,
        partnerGroupDefaultLinkId: linkActive,
        programEnrollmentId: enrId,
        projectId: "ws_emp_1",
      });
      db.links.set(linkNonDefault, {
        id: linkNonDefault,
        partnerGroupDefaultLinkId: null, // Non-default!
        programEnrollmentId: enrId,
        projectId: "ws_emp_1",
      });

      db.discountCodes.set("dc_batch_dis", {
        id: "dc_batch_dis",
        code: "BATCH_DIS",
        programId: "prog_emp_1",
        partnerId: "partner_batch",
        linkId: linkDisabled,
        discountId: "disc_emp_1",
        disabledAt: new Date("2026-07-01"),
        createdAt: new Date("2026-06-01"),
        updatedAt: new Date("2026-07-01"),
      });
      db.discountCodes.set("dc_batch_act", {
        id: "dc_batch_act",
        code: "BATCH_ACT",
        programId: "prog_emp_1",
        partnerId: "partner_batch",
        linkId: linkActive,
        discountId: "disc_emp_1",
        disabledAt: null,
        createdAt: new Date("2026-06-01"),
        updatedAt: new Date("2026-07-01"),
      });
      db.discountCodes.set("dc_non_def_dis", {
        id: "dc_non_def_dis",
        code: "NON_DEF_DIS",
        programId: "prog_emp_1",
        partnerId: "partner_batch",
        linkId: linkNonDefault,
        discountId: "disc_emp_1",
        disabledAt: new Date("2026-07-01"),
        createdAt: new Date("2026-06-01"),
        updatedAt: new Date("2026-07-01"),
      });

      const response = await queueBatchesCron(
        new NextRequest(
          "http://localhost/api/cron/discount-codes/create/queue-batches",
          {
            method: "POST",
            body: JSON.stringify({ discountId: "disc_emp_1" }),
          },
        ),
        { params: Promise.resolve({}) },
      );

      expect(response.status).toBe(200);

      // Verify enrollments selected
      const enrs = await (vi.mocked(prisma.programEnrollment.findMany) as any)
        .mock.results[0].value;
      const matchingEnrollment = enrs.find((e: any) => e.id === enrId);
      expect(matchingEnrollment).toBeDefined();

      const selectedLinkIds = matchingEnrollment.links.map((l: any) => l.id);
      // Must include linkNull and linkDisabled
      expect(selectedLinkIds).toContain(linkNull);
      expect(selectedLinkIds).toContain(linkDisabled);
      // Must NOT include linkActive (has active code)
      expect(selectedLinkIds).not.toContain(linkActive);
      // Must NOT include linkNonDefault (partnerGroupDefaultLinkId is null)
      expect(selectedLinkIds).not.toContain(linkNonDefault);
    });
  });

  // =========================================================================
  // Mission 1.4: getProgramEnrollmentOrThrow Invariant 2 Multi-Status Testing
  // =========================================================================
  describe("Mission 1.4: getProgramEnrollmentOrThrow Multi-Status Query Construction", () => {
    it("Empirically verifies: getProgramEnrollmentOrThrow applies correct where clauses across active, archived, and all statuses", async () => {
      const { getProgramEnrollmentOrThrow } = await import(
        "@/lib/api/programs/get-program-enrollment-or-throw"
      );

      // 1. status = 'active'
      await getProgramEnrollmentOrThrow({
        partnerId: "partner_p1",
        programId: "prog_emp_1",
        status: "active",
        include: {
          links: true,
          discountCodes: true,
        },
      });

      const activeCall = vi
        .mocked(prisma.programEnrollment.findUnique)
        .mock.calls.at(-1)?.[0];
      expect(activeCall?.include?.discountCodes).toEqual({
        where: { disabledAt: null },
      });
      expect(
        (activeCall?.include?.links as any)?.include?.discountCode,
      ).toEqual({
        where: { disabledAt: null },
      });

      // 2. status = 'archived'
      await getProgramEnrollmentOrThrow({
        partnerId: "partner_p1",
        programId: "prog_emp_1",
        status: "archived",
        include: {
          links: true,
          discountCodes: true,
        },
      });

      const archivedCall = vi
        .mocked(prisma.programEnrollment.findUnique)
        .mock.calls.at(-1)?.[0];
      expect(archivedCall?.include?.discountCodes).toEqual({
        where: { disabledAt: { not: null } },
      });
      expect(
        (archivedCall?.include?.links as any)?.include?.discountCode,
      ).toEqual({
        where: { disabledAt: { not: null } },
      });

      // 3. status = 'all'
      await getProgramEnrollmentOrThrow({
        partnerId: "partner_p1",
        programId: "prog_emp_1",
        status: "all",
        include: {
          links: true,
          discountCodes: true,
        },
      });

      const allCall = vi
        .mocked(prisma.programEnrollment.findUnique)
        .mock.calls.at(-1)?.[0];
      expect(allCall?.include?.discountCodes).toEqual({
        where: {},
      });
      expect((allCall?.include?.links as any)?.include?.discountCode).toEqual({
        where: {},
      });
    });
  });
});
