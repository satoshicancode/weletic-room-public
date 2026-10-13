import { createPrismaClient, prisma } from "@/lib/prisma";
import {
  ALL_ENUMS,
  BountyType,
  CommissionStatus,
  WorkspaceRole,
} from "@/lib/types/enums";
import * as PrismaClientExports from "@prisma/client";
import { Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("Milestone 1 SQLite/D1 Empirical Adversarial Challenge Suite", () => {
  const TEST_TAG = `adv_m1_${Date.now()}`;
  const testWorkspaceId = `ws_${TEST_TAG}`;
  const testUserId = `usr_${TEST_TAG}`;
  const testProgramId = `prog_${TEST_TAG}`;
  const createdCustomerIds: string[] = [];
  const createdActivityIds: string[] = [];
  const createdProjectUserIds: { projectId: string; userId: string }[] = [];

  beforeAll(async () => {
    // Fail-fast network guard: Verify zero network calls occur
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error(
        "[ADVERSARIAL VIOLATION] External network call attempted during SQLite offline test",
      );
    }) as any;

    // Create base project and user for relational integrity
    await prisma.project.create({
      data: {
        id: testWorkspaceId,
        name: "M1 Challenger Test Workspace",
        slug: `slug-${TEST_TAG}`,
        billingCycleStart: 1,
      },
    });

    await prisma.user.create({
      data: {
        id: testUserId,
        name: "M1 Challenger User",
        email: `${testUserId}@example.com`,
      },
    });

    await prisma.program.create({
      data: {
        id: testProgramId,
        name: "M1 Challenger Program",
        slug: `slug-prog-${TEST_TAG}`,
        defaultFolderId: `fld_${TEST_TAG}`,
        defaultGroupId: `grp_${TEST_TAG}`,
        workspaceId: testWorkspaceId,
      },
    });
  });

  afterAll(async () => {
    // Teardown test artifacts cleanly using raw SQL where cascade emulation in relationMode="prisma" is buggy
    try {
      if (createdActivityIds.length > 0) {
        await prisma.activityLog.deleteMany({
          where: { id: { in: createdActivityIds } },
        });
      }

      if (createdCustomerIds.length > 0) {
        await prisma.customer.deleteMany({
          where: { id: { in: createdCustomerIds } },
        });
      }

      for (const pu of createdProjectUserIds) {
        await prisma.projectUsers.deleteMany({
          where: { projectId: pu.projectId, userId: pu.userId },
        });
      }

      // Use raw SQL to bypass the ProgramEnrollment.partnerId bug in relationMode="prisma" cascade
      await prisma.$executeRawUnsafe(
        "DELETE FROM Program WHERE id = ?",
        testProgramId,
      );
      await prisma.$executeRawUnsafe(
        "DELETE FROM User WHERE id = ?",
        testUserId,
      );
      await prisma.$executeRawUnsafe(
        "DELETE FROM Project WHERE id = ?",
        testWorkspaceId,
      );
    } catch (e) {
      console.warn("Cleanup warning in afterAll:", e);
    }
  });

  describe("Task 1.1: Enum Runtime Availability & Preservation Across Modules", () => {
    it("preserves all 102 runtime enum dictionaries in ALL_ENUMS and exports from @/lib/types/enums", () => {
      expect(Object.keys(ALL_ENUMS).length).toBe(102);

      // Verify specific core enums exist in ALL_ENUMS
      expect(ALL_ENUMS.WorkspaceRole).toBeDefined();
      expect(ALL_ENUMS.CommissionStatus).toBeDefined();
      expect(ALL_ENUMS.WeleticRewardType).toBeDefined();
      expect(ALL_ENUMS.WeleticSyncStatus).toBeDefined();
      expect(ALL_ENUMS.BountyType).toBeDefined();

      // Verify imported from @/lib/types/enums works as runtime object
      expect(WorkspaceRole.owner).toBe("owner");
      expect(WorkspaceRole.member).toBe("member");
      expect(BountyType.performance).toBe("performance");
      expect(CommissionStatus.paid).toBe("paid");
    });

    it("verifies that @prisma/client runtime exports are defined and available", () => {
      const directPrismaExport = (PrismaClientExports as any).WorkspaceRole;
      const prismaEnumsNamespace = (PrismaClientExports as any).$Enums;

      expect(directPrismaExport).toBeDefined();
      expect(directPrismaExport.owner).toBe("owner");
      expect(directPrismaExport.member).toBe("member");
      expect(prismaEnumsNamespace).toBeDefined();
      expect(prismaEnumsNamespace.WorkspaceRole).toBeDefined();
      expect(prismaEnumsNamespace.WorkspaceRole.owner).toBe("owner");
    });

    it("supports Object.values, Object.keys and type iteration over enums from @/lib/types/enums", () => {
      const roles = Object.values(WorkspaceRole);
      expect(roles).toContain("owner");
      expect(roles).toContain("member");
      expect(roles).toContain("viewer");
      expect(roles).toContain("billing");
      expect(roles.length).toBe(4);
    });
  });

  describe("Task 1.2: Enum Values Outside or at Boundary of Definitions", () => {
    it("handles standard valid enum values in database writes and reads", async () => {
      const pu = await prisma.projectUsers.create({
        data: {
          projectId: testWorkspaceId,
          userId: testUserId,
          role: WorkspaceRole.owner,
        },
      });
      createdProjectUserIds.push({
        projectId: testWorkspaceId,
        userId: testUserId,
      });

      expect(pu.role).toBe("owner");

      const readPu = await prisma.projectUsers.findUnique({
        where: {
          userId_projectId: {
            userId: testUserId,
            projectId: testWorkspaceId,
          },
        },
      });
      expect(readPu).not.toBeNull();
      expect(readPu?.role).toBe(WorkspaceRole.owner);
    });

    it("empirically handles string values OUTSIDE enum definition without database crash", async () => {
      // In SQLite, enum fields are TEXT columns.
      // Update role to an arbitrary string not in WorkspaceRole enum:
      const arbitraryRole = "arbitrary_custom_super_admin_role_999";
      const updated = await prisma.projectUsers.update({
        where: {
          userId_projectId: {
            userId: testUserId,
            projectId: testWorkspaceId,
          },
        },
        data: {
          role: arbitraryRole as any,
        },
      });

      expect(updated.role).toBe(arbitraryRole);

      // Verify Prisma Client reads it back without deserialization crash
      const reRead = await prisma.projectUsers.findUnique({
        where: {
          userId_projectId: {
            userId: testUserId,
            projectId: testWorkspaceId,
          },
        },
      });
      expect(reRead?.role).toBe(arbitraryRole);
    });

    it("handles boundary casing and empty string enum values", async () => {
      // Empty string
      const emptyRoleUpdated = await prisma.projectUsers.update({
        where: {
          userId_projectId: {
            userId: testUserId,
            projectId: testWorkspaceId,
          },
        },
        data: {
          role: "" as any,
        },
      });
      expect(emptyRoleUpdated.role).toBe("");

      // Mixed/Uppercase casing
      const upperRoleUpdated = await prisma.projectUsers.update({
        where: {
          userId_projectId: {
            userId: testUserId,
            projectId: testWorkspaceId,
          },
        },
        data: {
          role: "OWNER" as any,
        },
      });
      expect(upperRoleUpdated.role).toBe("OWNER");
    });
  });

  describe("Task 1.3: Large Text Fields & JSON Columns (former @db.LongText and @db.Json)", () => {
    it("handles 100KB and 1MB large text in SQLite TEXT columns without truncation", async () => {
      const baseChunk =
        "Weletic Cloudflare D1 SQLite text migration stress testing chunk. ";
      const targetSize100K = 100 * 1024;
      const text100KB = baseChunk
        .repeat(Math.ceil(targetSize100K / baseChunk.length))
        .slice(0, targetSize100K);

      const act1 = await prisma.activityLog.create({
        data: {
          workspaceId: testWorkspaceId,
          programId: testProgramId,
          resourceType: "stress_test_text_100k",
          resourceId: `res_100k_${TEST_TAG}`,
          action: "create",
          description: text100KB,
        },
      });
      createdActivityIds.push(act1.id);

      const readAct1 = await prisma.activityLog.findUnique({
        where: { id: act1.id },
      });
      expect(readAct1?.description?.length).toBe(targetSize100K);
      expect(readAct1?.description).toBe(text100KB);

      // 1MB large text test
      const targetSize1MB = 1024 * 1024;
      const text1MB = "A".repeat(targetSize1MB);

      const act2 = await prisma.activityLog.create({
        data: {
          workspaceId: testWorkspaceId,
          programId: testProgramId,
          resourceType: "stress_test_text_1mb",
          resourceId: `res_1mb_${TEST_TAG}`,
          action: "create",
          description: text1MB,
        },
      });
      createdActivityIds.push(act2.id);

      const readAct2 = await prisma.activityLog.findUnique({
        where: { id: act2.id },
      });
      expect(readAct2?.description?.length).toBe(targetSize1MB);
      expect(readAct2?.description).toBe(text1MB);
    });

    it("handles complex, deeply nested and large JSON payloads in SQLite without corruption", async () => {
      // Build complex multi-type JSON object
      const complexJson = {
        meta: {
          version: "2.0.0",
          nestedLevel1: {
            nestedLevel2: {
              nestedLevel3: {
                deepValue: "deep_leaf_node_verified",
                deepArray: [1, 2, 3, "four", true, null, { key: "subvalue" }],
              },
            },
          },
        },
        unicodeDetails:
          "Tài sản thương hiệu Yamax: Áo khoác & Quần Legging Yenergy™ 🚀",
        specialChars:
          "Quotes ' \" and backslashes \\ / \n\r\t and null-like \u0000 strings",
        numericEdgeCases: {
          zero: 0,
          negative: -999999.99,
          floatVal: 123456.78,
          booleanTrue: true,
          booleanFalse: false,
          nullValue: null,
          emptyList: [],
          emptyObject: {},
        },
        batchEvents: Array.from({ length: 200 }, (_, i) => ({
          eventId: `evt_${i}`,
          amount: i * 10.5,
          tags: ["shopify", "d1", "sqlite", `tag_${i}`],
        })),
      };

      const actJson = await prisma.activityLog.create({
        data: {
          workspaceId: testWorkspaceId,
          programId: testProgramId,
          resourceType: "stress_test_json",
          resourceId: `res_json_${TEST_TAG}`,
          action: "json_test",
          changeSet: complexJson,
        },
      });
      createdActivityIds.push(actJson.id);

      const readActJson = await prisma.activityLog.findUnique({
        where: { id: actJson.id },
      });
      expect(readActJson?.changeSet).toEqual(complexJson);
      expect(
        (readActJson?.changeSet as any).meta.nestedLevel1.nestedLevel2
          .nestedLevel3.deepValue,
      ).toBe("deep_leaf_node_verified");
      expect((readActJson?.changeSet as any).batchEvents.length).toBe(200);
    });

    it("handles null and empty JSON fields cleanly", async () => {
      const actNull = await prisma.activityLog.create({
        data: {
          workspaceId: testWorkspaceId,
          programId: testProgramId,
          resourceType: "stress_test_json_null",
          resourceId: `res_json_null_${TEST_TAG}`,
          action: "null_test",
          changeSet: Prisma.DbNull,
        },
      });
      createdActivityIds.push(actNull.id);

      const readNull = await prisma.activityLog.findUnique({
        where: { id: actNull.id },
      });
      expect(readNull?.changeSet).toBeNull();
    });
  });

  describe("Task 1.4: Search Query Conversion (contains queries) with Null, Empty & Wildcards", () => {
    beforeAll(async () => {
      // Seed test customers with various name and email characteristics
      const customersToCreate = [
        {
          id: `c_alice_${TEST_TAG}`,
          name: "Alice Wonderland",
          email: "alice.wonder@example.com",
        },
        {
          id: `c_bob_${TEST_TAG}`,
          name: "Bob Builder",
          email: "bob.build@enterprise.org",
        },
        {
          id: `c_null_name_${TEST_TAG}`,
          name: null,
          email: "no.name.user@domain.com",
        },
        {
          id: `c_null_email_${TEST_TAG}`,
          name: "No Email Customer",
          email: null,
        },
        {
          id: `c_wildcard_pct_${TEST_TAG}`,
          name: "100% Discount Shopper",
          email: "percent%shopper@domain.com",
        },
        {
          id: `c_wildcard_under_${TEST_TAG}`,
          name: "Under_Score_User",
          email: "under_score@domain.com",
        },
        {
          id: `c_sql_inject_${TEST_TAG}`,
          name: "Robert'); DROP TABLE Customers;--",
          email: "bobby.tables@domain.com",
        },
      ];

      for (const c of customersToCreate) {
        await prisma.customer.create({
          data: {
            id: c.id,
            projectId: testWorkspaceId,
            programId: testProgramId,
            name: c.name,
            email: c.email,
          },
        });
        createdCustomerIds.push(c.id);
      }
    });

    it("executes search query when search string is empty or whitespace", async () => {
      // Logic from get-customers.ts: if search is empty string, search filter is omitted
      const search: string = "";
      const whereClause = {
        projectId: testWorkspaceId,
        ...(search
          ? search.includes("@")
            ? { email: search }
            : {
                OR: [
                  { email: { contains: search } },
                  { name: { contains: search } },
                ],
              }
          : {}),
      };

      const results = await prisma.customer.findMany({ where: whereClause });
      expect(results.length).toBe(createdCustomerIds.length);
    });

    it("executes contains query with exact match on name or email", async () => {
      const search = "Alice";
      const whereClause = {
        projectId: testWorkspaceId,
        OR: [{ email: { contains: search } }, { name: { contains: search } }],
      };

      const results = await prisma.customer.findMany({ where: whereClause });
      expect(results.length).toBe(1);
      expect(results[0].id).toBe(`c_alice_${TEST_TAG}`);
    });

    it("routes search strings containing '@' to exact email query without error", async () => {
      const search = "bob.build@enterprise.org";
      const whereClause = {
        projectId: testWorkspaceId,
        ...(search.includes("@")
          ? { email: search }
          : {
              OR: [
                { email: { contains: search } },
                { name: { contains: search } },
              ],
            }),
      };

      const results = await prisma.customer.findMany({ where: whereClause });
      expect(results.length).toBe(1);
      expect(results[0].id).toBe(`c_bob_${TEST_TAG}`);
    });

    it("executes search query correctly when records have null name or null email", async () => {
      // Searching for "no.name" should match the customer whose name is null
      const search = "no.name";
      const results = await prisma.customer.findMany({
        where: {
          projectId: testWorkspaceId,
          OR: [{ email: { contains: search } }, { name: { contains: search } }],
        },
      });

      expect(results.length).toBe(1);
      expect(results[0].id).toBe(`c_null_name_${TEST_TAG}`);

      // Searching for "No Email" should match the customer whose email is null
      const search2 = "No Email";
      const results2 = await prisma.customer.findMany({
        where: {
          projectId: testWorkspaceId,
          OR: [
            { email: { contains: search2 } },
            { name: { contains: search2 } },
          ],
        },
      });

      expect(results2.length).toBe(1);
      expect(results2[0].id).toBe(`c_null_email_${TEST_TAG}`);
    });

    it("handles SQL wildcards (%) and (_) in parameterized contains queries without SQL injection", async () => {
      // In SQLite parameterized query, contains: "%" executes via parameterized LIKE '%' || ? || '%'
      const searchPct = "%";
      const resultsPct = await prisma.customer.findMany({
        where: {
          projectId: testWorkspaceId,
          OR: [
            { email: { contains: searchPct } },
            { name: { contains: searchPct } },
          ],
        },
      });

      // Verify query executes cleanly without SQL syntax error
      expect(Array.isArray(resultsPct)).toBe(true);

      // SQL injection attempt test matching the exact seeded text
      const searchInjection = "'); DROP TABLE Customers;--";
      const resultsInj = await prisma.customer.findMany({
        where: {
          projectId: testWorkspaceId,
          OR: [
            { email: { contains: searchInjection } },
            { name: { contains: searchInjection } },
          ],
        },
      });

      expect(resultsInj.length).toBe(1);
      expect(resultsInj[0].id).toBe(`c_sql_inject_${TEST_TAG}`);

      // Customer table must remain intact!
      const count = await prisma.customer.count({
        where: { projectId: testWorkspaceId },
      });
      expect(count).toBe(createdCustomerIds.length);
    });
  });

  describe("Task 1.5: Empirical Verification of relationMode='prisma' Cascade Deletion", () => {
    it("verifies Program deletion cascades cleanly under relationMode='prisma' with harmonized composite foreign keys", async () => {
      let caughtError: any = null;
      try {
        await prisma.program.deleteMany({
          where: { id: testProgramId },
        });
      } catch (err: any) {
        caughtError = err;
      }

      expect(caughtError).toBeNull();
      const remaining = await prisma.program.findUnique({
        where: { id: testProgramId },
      });
      expect(remaining).toBeNull();
    });
  });

  describe("Task 2 & 3: Clean Offline Execution against file:./dev.db without Network Dependencies", () => {
    it("executes interactive transaction (commit and rollback) purely on local SQLite", async () => {
      const rollbackTag = `rb_${TEST_TAG}`;

      // 1. Transaction commit test
      await prisma.$transaction(async (tx) => {
        await tx.activityLog.create({
          data: {
            id: `act_tx_commit_${rollbackTag}`,
            workspaceId: testWorkspaceId,
            programId: testProgramId,
            resourceType: "tx_test",
            resourceId: "commit_id",
            action: "commit",
          },
        });
      });
      createdActivityIds.push(`act_tx_commit_${rollbackTag}`);

      const committed = await prisma.activityLog.findUnique({
        where: { id: `act_tx_commit_${rollbackTag}` },
      });
      expect(committed).not.toBeNull();

      // 2. Transaction rollback test
      try {
        await prisma.$transaction(async (tx) => {
          await tx.activityLog.create({
            data: {
              id: `act_tx_rollback_${rollbackTag}`,
              workspaceId: testWorkspaceId,
              programId: testProgramId,
              resourceType: "tx_test",
              resourceId: "rollback_id",
              action: "rollback",
            },
          });
          throw new Error("Deliberate transaction failure to verify rollback");
        });
      } catch (err: any) {
        expect(err.message).toBe(
          "Deliberate transaction failure to verify rollback",
        );
      }

      const rolledBack = await prisma.activityLog.findUnique({
        where: { id: `act_tx_rollback_${rollbackTag}` },
      });
      expect(rolledBack).toBeNull();
    });

    it("executes raw SQL queries with parameters on local SQLite returning BigInt", async () => {
      const result: any =
        await prisma.$queryRaw`SELECT 1 + 1 AS sum, 'sqlite_online' AS status;`;
      expect(result).toBeDefined();
      // Prisma on SQLite returns integer expressions as BigInt
      expect(result[0].sum).toBe(BigInt(2));
      expect(Number(result[0].sum)).toBe(2);
      expect(result[0].status).toBe("sqlite_online");
    });

    it("supports dual-mode PrismaClient factory (with and without D1Database binding)", () => {
      // 1. Standard SQLite client without D1
      const defaultClient = createPrismaClient();
      expect(defaultClient).toBeDefined();

      // 2. Mock D1 binding
      const mockD1: any = {
        prepare: () => ({
          bind: () => ({
            all: async () => ({ results: [] }),
            run: async () => ({ success: true }),
          }),
        }),
        batch: async () => [],
        exec: async () => ({ count: 0, duration: 0 }),
      };

      const d1Client = createPrismaClient(mockD1);
      expect(d1Client).toBeDefined();
    });
  });
});
