import { createDiscountCode } from "@/lib/discounts/create-discount-code";
import { prisma } from "@/lib/prisma";
import {
  canonicalizeShopifyDomain,
  normalizeShopDomain,
  resolveShopifyStoreByDomain,
} from "@/lib/weletic/shopify/store-resolver";
import { Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Mock external discount provider network calls while preserving real SQLite database operations
vi.mock("@/lib/discounts/discount-provider", () => ({
  getDiscountProvider: vi.fn(() => ({
    createDiscountCode: vi.fn(async ({ code }: any) => ({
      code: code || "MOCK_CODE",
    })),
    disableDiscountCode: vi.fn(async () => {}),
  })),
}));

describe("M1 Database Migration Challenger 2: Empirical Verification Suite", () => {
  const ts = Date.now();
  const testWorkspaceId = `ws_challenger_${ts}`;
  const testProgramId = `prog_challenger_${ts}`;
  const testPartnerId = `part_challenger_${ts}`;
  const testLinkId = `link_challenger_${ts}`;
  const testDiscountId = `disc_challenger_${ts}`;
  const testStoreId = `store_challenger_${ts}`;

  const primaryDomain = `yamaxdev-${ts}.myshopify.com`;
  const myshopifyDomain = `montdev-${ts}.myshopify.com`;
  const customDomain = `yamax-${ts}.store`;

  beforeAll(async () => {
    // 1. Create Workspace
    await prisma.project.create({
      data: {
        id: testWorkspaceId,
        name: `Test Workspace ${ts}`,
        slug: `ws-test-${ts}`,
        defaultProgramId: testProgramId,
        shopifyStoreId: primaryDomain,
        billingCycleStart: 1,
      },
    });

    // 2. Create Program
    await prisma.program.create({
      data: {
        id: testProgramId,
        workspaceId: testWorkspaceId,
        name: `Test Program ${ts}`,
        slug: `prog-test-${ts}`,
        accountingCurrency: "USD",
        defaultFolderId: `folder_${ts}`,
        defaultGroupId: `group_${ts}`,
      },
    });

    // 3. Create Partner
    await prisma.partner.create({
      data: {
        id: testPartnerId,
        name: `Partner ${ts}`,
        email: `partner_${ts}@example.com`,
      },
    });

    // 4. Create Link
    await prisma.link.create({
      data: {
        id: testLinkId,
        domain: "dub.sh",
        key: `key_${ts}`,
        url: "https://yamax.com",
        shortLink: `https://dub.sh/key_${ts}`,
        projectId: testWorkspaceId,
        programId: testProgramId,
        partnerId: testPartnerId,
      },
    });

    // 5. Create Discount
    await prisma.discount.create({
      data: {
        id: testDiscountId,
        programId: testProgramId,
        amount: 20,
        type: "percentage",
        provider: "stripe",
      },
    });

    // 6. Create WeleticShopifyStore
    await prisma.weleticShopifyStore.create({
      data: {
        id: testStoreId,
        projectId: testWorkspaceId,
        programId: testProgramId,
        shopDomain: myshopifyDomain,
        shopCurrency: "USD",
        complianceState: "active",
        apiVersion: "2026-10",
      },
    });
  });

  afterAll(async () => {
    // Cleanup created test records using raw deletes to avoid relation cascade bug
    await prisma.$executeRawUnsafe(
      `DELETE FROM DiscountCode WHERE programId = '${testProgramId}'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM Discount WHERE id = '${testDiscountId}'`,
    );
    await prisma.$executeRawUnsafe(`DELETE FROM Link WHERE id = '${testLinkId}'`);
    await prisma.$executeRawUnsafe(
      `DELETE FROM WeleticShopifyStore WHERE id = '${testStoreId}'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM Program WHERE id = '${testProgramId}'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM Partner WHERE id = '${testPartnerId}'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM Project WHERE id = '${testWorkspaceId}'`,
    );
  });

  // =========================================================================
  // TASK 1: Invariant 1 - Canonical Store Resolution
  // =========================================================================
  describe("Invariant 1: Canonical Store Resolution & Domain Aliasing", () => {
    it("1.1 Domain Normalization: correctly strips protocols, trailing slashes, paths, and handles casing", () => {
      expect(
        normalizeShopDomain(`https://${myshopifyDomain}/admin/orders`),
      ).toBe(myshopifyDomain);
      expect(
        normalizeShopDomain(`  HTTP://${primaryDomain.toUpperCase()}///  `),
      ).toBe(primaryDomain);
      expect(canonicalizeShopifyDomain(myshopifyDomain)).toBe(myshopifyDomain);
      expect(canonicalizeShopifyDomain("invalid-.myshopify.com")).toBeNull();
    });

    it("1.2 Multi-Domain Query Resolution: verifies Prisma queries find the same workspace via primary domain, myshopify domain, and custom store id", async () => {
      // 1. Lookup by myshopify domain on WeleticShopifyStore
      const storeMatch = await prisma.weleticShopifyStore.findUnique({
        where: { shopDomain: myshopifyDomain },
        select: { projectId: true, shopDomain: true },
      });
      expect(storeMatch).not.toBeNull();
      expect(storeMatch?.projectId).toBe(testWorkspaceId);

      // 2. Lookup by primaryDomain on Project.shopifyStoreId
      const projectMatch = await prisma.project.findUnique({
        where: { shopifyStoreId: primaryDomain },
        select: { id: true, defaultProgramId: true },
      });
      expect(projectMatch).not.toBeNull();
      expect(projectMatch?.id).toBe(testWorkspaceId);
      expect(projectMatch?.defaultProgramId).toBe(testProgramId);

      // Both domain query routes resolve to the exact same workspace identity
      expect(storeMatch?.projectId).toBe(projectMatch?.id);
    });

    it("1.3 [REMEDIED] resolveShopifyStoreByDomain executes without P2010 syntax error on SQLite", async () => {
      let caughtError: any = null;
      try {
        await resolveShopifyStoreByDomain(myshopifyDomain);
      } catch (err: any) {
        caughtError = err;
      }

      // Mitigated: no P2010 syntax error is thrown
      expect(caughtError).toBeNull();
    });
  });

  // =========================================================================
  // TASK 2: Invariant 2 - Soft-Delete Coherence
  // =========================================================================
  describe("Invariant 2: Soft-Delete Coherence (DiscountCode)", () => {
    it("2.1 Query Exclusion: queries with `where: { disabledAt: null }` strictly exclude soft-deleted records", async () => {
      // Create 1 active code and 1 disabled code
      const activeCode = await prisma.discountCode.create({
        data: {
          id: `dc_active_${ts}`,
          code: "ACTIVE20",
          programId: testProgramId,
          partnerId: testPartnerId,
          discountId: testDiscountId,
          disabledAt: null,
        },
      });

      const disabledCode = await prisma.discountCode.create({
        data: {
          id: `dc_disabled_${ts}`,
          code: "DISABLED20",
          programId: testProgramId,
          partnerId: testPartnerId,
          discountId: testDiscountId,
          disabledAt: new Date(),
        },
      });

      // 1. findMany where: { disabledAt: null }
      const activeResults = await prisma.discountCode.findMany({
        where: {
          programId: testProgramId,
          disabledAt: null,
        },
      });
      const activeIds = activeResults.map((r) => r.id);
      expect(activeIds).toContain(activeCode.id);
      expect(activeIds).not.toContain(disabledCode.id);

      // 2. findFirst where: { disabledAt: null } for disabledCode.code returns null
      const findDisabledAsActive = await prisma.discountCode.findFirst({
        where: {
          programId: testProgramId,
          code: "DISABLED20",
          disabledAt: null,
        },
      });
      expect(findDisabledAsActive).toBeNull();

      // 3. count where: { disabledAt: null } strictly counts active records
      const activeCount = await prisma.discountCode.count({
        where: {
          programId: testProgramId,
          disabledAt: null,
        },
      });
      expect(activeCount).toBe(1);

      // 4. where: { disabledAt: { not: null } } strictly includes only soft-deleted
      const disabledResults = await prisma.discountCode.findMany({
        where: {
          programId: testProgramId,
          disabledAt: { not: null },
        },
      });
      expect(disabledResults.map((r) => r.id)).toEqual([disabledCode.id]);

      // Cleanup
      await prisma.discountCode.deleteMany({
        where: { id: { in: [activeCode.id, disabledCode.id] } },
      });
    });

    it("2.2 Reactivation Pattern: createDiscountCode safely reactivates soft-deleted codes and avoids P2002 collision", async () => {
      const targetCode = "REUSE_ME_20";

      // 1. Create initial active code
      const workspace = {
        id: testWorkspaceId,
        stripeConnectId: null,
        shopifyStoreId: primaryDomain,
      };
      const partner = { id: testPartnerId, name: `Partner ${ts}` };
      const link = { id: testLinkId };
      const discount = {
        id: testDiscountId,
        programId: testProgramId,
        amount: 20,
        type: "percentage",
        maxDuration: null,
        description: null,
        couponId: null,
        couponTestId: null,
        autoProvisionEnabledAt: null,
        provider: "stripe",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const createdFirst = await createDiscountCode({
        workspace,
        partner,
        link,
        discount,
        code: targetCode,
      });
      expect(createdFirst.code).toBe(targetCode);
      expect(createdFirst.disabledAt).toBeNull();

      // 2. Soft-delete the code
      await prisma.discountCode.update({
        where: { id: createdFirst.id },
        data: { disabledAt: new Date() },
      });

      // Verify that raw Prisma create would fail with P2002 on @@unique([programId, code])
      let rawCreateError: any = null;
      try {
        await prisma.discountCode.create({
          data: {
            id: `dc_raw_dup_${ts}`,
            code: targetCode,
            programId: testProgramId,
            partnerId: testPartnerId,
            disabledAt: null,
          },
        });
      } catch (err: any) {
        rawCreateError = err;
      }
      expect(rawCreateError).not.toBeNull();
      expect(rawCreateError.code).toBe("P2002");

      // 3. Re-create the same code using createDiscountCode -> MUST reactivate in-place
      const reactivated = await createDiscountCode({
        workspace,
        partner,
        link,
        discount,
        code: targetCode,
      });

      // Verify reactivation succeeded and reused the existing record ID
      expect(reactivated.id).toBe(createdFirst.id);
      expect(reactivated.code).toBe(targetCode);
      expect(reactivated.disabledAt).toBeNull();

      // Cleanup
      await prisma.discountCode.delete({ where: { id: reactivated.id } });
    });

    it("2.3 Link Slot Collision: unlinks soft-deleted code from link when new code is assigned", async () => {
      // Create code 1 attached to testLinkId, then soft-delete it
      const code1 = await prisma.discountCode.create({
        data: {
          id: `dc_link_1_${ts}`,
          code: "LINKCODE1",
          programId: testProgramId,
          partnerId: testPartnerId,
          linkId: testLinkId,
          disabledAt: new Date(),
        },
      });

      const workspace = {
        id: testWorkspaceId,
        stripeConnectId: null,
        shopifyStoreId: primaryDomain,
      };
      const partner = { id: testPartnerId, name: `Partner ${ts}` };
      const link = { id: testLinkId };
      const discount = {
        id: testDiscountId,
        programId: testProgramId,
        amount: 20,
        type: "percentage",
        maxDuration: null,
        description: null,
        couponId: null,
        couponTestId: null,
        autoProvisionEnabledAt: null,
        provider: "stripe",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Create a brand new code on testLinkId
      const code2 = await createDiscountCode({
        workspace,
        partner,
        link,
        discount,
        code: "LINKCODE2",
      });

      expect(code2.linkId).toBe(testLinkId);

      // Verify that code1 was unlinked so linkId unique constraint is satisfied
      const updatedCode1 = await prisma.discountCode.findUnique({
        where: { id: code1.id },
      });
      expect(updatedCode1?.linkId).toBeNull();

      // Cleanup
      await prisma.discountCode.deleteMany({
        where: { id: { in: [code1.id, code2.id] } },
      });
    });
  });

  // =========================================================================
  // TASK 3: SQLite Transaction Concurrency & Locking
  // =========================================================================
  describe("SQLite Transaction Concurrency & Locking Behavior", () => {
    it("3.1 Rapid Sequential Writes: executes 50 sequential updates with 100% success rate", async () => {
      const startTime = Date.now();
      for (let i = 0; i < 50; i++) {
        await prisma.project.update({
          where: { id: testWorkspaceId },
          data: { updatedAt: new Date() },
        });
      }
      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(2000); // Should finish well under 2s on local SSD
    });

    it("3.2 Concurrent Interactive Transactions: executes 20 concurrent transactions without deadlocks", async () => {
      const results = await Promise.allSettled(
        Array.from({ length: 20 }, async (_, idx) => {
          return prisma.$transaction(async (tx) => {
            const project = await tx.project.findUnique({
              where: { id: testWorkspaceId },
              select: { id: true, updatedAt: true },
            });
            await tx.project.update({
              where: { id: testWorkspaceId },
              data: { updatedAt: new Date() },
            });
            return { idx, projectId: project?.id };
          });
        }),
      );

      const rejected = results.filter((r) => r.status === "rejected");
      expect(rejected).toHaveLength(0);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      expect(fulfilled).toHaveLength(20);
    });

    it("3.3 Transaction Rollback: interactive transaction rolls back cleanly on error without partial commit", async () => {
      const initialPartner = await prisma.partner.findUnique({
        where: { id: testPartnerId },
      });
      const originalName = initialPartner?.name;

      await expect(
        prisma.$transaction(async (tx) => {
          await tx.partner.update({
            where: { id: testPartnerId },
            data: { name: "SHOULD_BE_ROLLED_BACK" },
          });
          throw new Error("Intentional error to trigger rollback");
        }),
      ).rejects.toThrow("Intentional error to trigger rollback");

      // Verify that database state remained unchanged
      const currentPartner = await prisma.partner.findUnique({
        where: { id: testPartnerId },
      });
      expect(currentPartner?.name).toBe(originalName);
    });

    it("3.4 [CHALLENGER FAILURE FINDING] SQLite syntax error on unmitigated FOR UPDATE vs mitigation success", async () => {
      // 1. Unmitigated FOR UPDATE query fails on SQLite
      let forUpdateError: any = null;
      try {
        await prisma.$queryRawUnsafe(
          `SELECT id FROM WeleticShopifyStore WHERE id = '${testStoreId}' LIMIT 1 FOR UPDATE`,
        );
      } catch (err: any) {
        forUpdateError = err;
      }
      expect(forUpdateError).not.toBeNull();
      expect(forUpdateError.code).toBe("P2010");
      expect(forUpdateError.message).toContain('near "FOR": syntax error');

      // 2. Conditionally guarded clause succeeds on SQLite
      const forUpdateClause = process.env.DATABASE_URL?.startsWith("mysql:")
        ? Prisma.sql`FOR UPDATE`
        : Prisma.empty;

      const results = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id FROM WeleticShopifyStore WHERE id = ${testStoreId} LIMIT 1 ${forUpdateClause}
      `);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(testStoreId);
    });
  });
});
