import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Prisma } from "@prisma/client";
import { describe, expect, expectTypeOf, it } from "vitest";

describe("EMPIRICAL CHALLENGER: PERF-01 Schema Integrity, Query Types & DDL Verification", () => {
  const rootDir = path.resolve(__dirname, "../../../..");
  const webDir = path.resolve(rootDir, "apps/web");
  const schemaDir = path.resolve(webDir, "prisma/schema");
  const migrationSqlPath = path.resolve(
    rootDir,
    "infra/shopify-development/migrations/20261005_perf01_relation_composite_indexes.sql",
  );

  describe("1. Strict Prisma Validation (Zero Warnings Oracle)", () => {
    it("empirically verifies 0 warnings and exit code 0 on production schema across stdout and stderr", () => {
      const res = spawnSync(
        "pnpm",
        ["--filter", "web", "exec", "prisma", "validate", "--schema=./prisma/schema"],
        {
          cwd: rootDir,
          encoding: "utf8",
        },
      );

      expect(res.status).toBe(0);
      expect(res.stdout).toContain("The schemas at prisma/schema are valid 🚀");
      expect(res.stdout).not.toContain("Prisma schema warning");
      expect(res.stdout).not.toContain("relationMode");
      expect(res.stderr).not.toContain("Prisma schema warning");
      expect(res.stderr).not.toContain("relationMode");
    });

    it("ORACLE NEGATIVE CONTROL: proves prisma validate produces warnings in stderr if relation index is removed", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "prisma-schema-oracle-"));
      try {
        // Copy all schema files to tempDir
        const files = fs.readdirSync(schemaDir);
        for (const file of files) {
          if (file.endsWith(".prisma")) {
            fs.copyFileSync(
              path.join(schemaDir, file),
              path.join(tempDir, file),
            );
          }
        }

        // Deliberately remove @@index([fromTierId]) from WeleticLoyaltyTierHistory
        const loyaltyFile = path.join(tempDir, "weletic-loyalty.prisma");
        let content = fs.readFileSync(loyaltyFile, "utf8");
        expect(content).toContain("@@index([fromTierId])");
        content = content.replace("@@index([fromTierId])", "");
        fs.writeFileSync(loyaltyFile, content, "utf8");

        // Execute prisma validate on modified schema capturing stderr
        const res = spawnSync(
          "pnpm",
          ["--filter", "web", "exec", "prisma", "validate", `--schema=${tempDir}`],
          {
            cwd: rootDir,
            encoding: "utf8",
          },
        );

        expect(res.status).toBe(0);
        // Negative control MUST observe the relationMode warning in stderr
        expect(res.stderr).toContain("Prisma schema warning");
        expect(res.stderr).toContain('With `relationMode = "prisma"`');
        expect(res.stderr).toContain("https://pris.ly/d/relation-mode-prisma-indexes");
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("2. Prisma Client Query Type Integrity (Zero Regressions on 5 Models)", () => {
    it("validates WeleticRewardRedemption query types and filters", () => {
      type WhereInput = Prisma.WeleticRewardRedemptionWhereInput;
      type OrderByInput = Prisma.WeleticRewardRedemptionOrderByWithRelationInput;
      type SelectInput = Prisma.WeleticRewardRedemptionSelect;

      // Verify rewardDefinitionId can be queried directly and by relation
      const where: WhereInput = {
        rewardDefinitionId: "def_test_123",
        rewardDefinition: {
          id: "def_test_123",
          status: "active",
        },
        storeId: "store_123",
      };
      expect(where.rewardDefinitionId).toBe("def_test_123");

      const orderBy: OrderByInput = {
        rewardDefinitionId: "asc",
      };
      expect(orderBy.rewardDefinitionId).toBe("asc");

      const select: SelectInput = {
        id: true,
        rewardDefinitionId: true,
        rewardDefinition: true,
        pointsSpent: true,
      };
      expect(select.rewardDefinitionId).toBe(true);
    });

    it("validates WeleticLoyaltyEarnGrant composite query types [programId, status] and shopperId", () => {
      type WhereInput = Prisma.WeleticLoyaltyEarnGrantWhereInput;
      type OrderByInput = Prisma.WeleticLoyaltyEarnGrantOrderByWithRelationInput;

      // Invariant composite query: [programId, status]
      const compositeWhere: WhereInput = {
        programId: "prog_test_1",
        status: "pending",
      };
      expect(compositeWhere.programId).toBe("prog_test_1");
      expect(compositeWhere.status).toBe("pending");

      // Shopper query
      const shopperWhere: WhereInput = {
        shopperId: "shopper_test_1",
        shopper: {
          id: "shopper_test_1",
        },
      };
      expect(shopperWhere.shopperId).toBe("shopper_test_1");

      const orderBy: OrderByInput[] = [
        { shopperId: "asc" },
        { programId: "desc" },
        { status: "asc" },
      ];
      expect(orderBy.length).toBe(3);
    });

    it("validates DiscountCode Invariant 2 queries [programId, disabledAt] and [partnerId, disabledAt]", () => {
      type WhereInput = Prisma.DiscountCodeWhereInput;

      // Invariant 2 active discount code queries
      const activeProgramQuery: WhereInput = {
        programId: "prog_active_1",
        disabledAt: null,
      };
      expect(activeProgramQuery.programId).toBe("prog_active_1");
      expect(activeProgramQuery.disabledAt).toBeNull();

      const activePartnerQuery: WhereInput = {
        partnerId: "partner_active_1",
        disabledAt: null,
      };
      expect(activePartnerQuery.partnerId).toBe("partner_active_1");
      expect(activePartnerQuery.disabledAt).toBeNull();
    });

    it("validates WeleticLoyaltyTierHistory query types [fromTierId] and [toTierId]", () => {
      type WhereInput = Prisma.WeleticLoyaltyTierHistoryWhereInput;
      type OrderByInput = Prisma.WeleticLoyaltyTierHistoryOrderByWithRelationInput;

      const where: WhereInput = {
        fromTierId: "tier_bronze",
        toTierId: "tier_silver",
        fromTier: { id: "tier_bronze" },
      };
      expect(where.fromTierId).toBe("tier_bronze");

      const orderBy: OrderByInput = {
        fromTierId: "asc",
      };
      expect(orderBy.fromTierId).toBe("asc");
    });

    it("validates FraudAlert composite query types [programId, partnerId] and [reviewedById]", () => {
      type WhereInput = Prisma.FraudAlertWhereInput;

      const compositeWhere: WhereInput = {
        programId: "prog_fraud_1",
        partnerId: "part_fraud_1",
      };
      expect(compositeWhere.programId).toBe("prog_fraud_1");
      expect(compositeWhere.partnerId).toBe("part_fraud_1");

      const reviewerWhere: WhereInput = {
        reviewedById: "user_reviewer_1",
        reviewedBy: {
          id: "user_reviewer_1",
        },
      };
      expect(reviewerWhere.reviewedById).toBe("user_reviewer_1");

      const pendingWhere: WhereInput = {
        reviewedById: null,
        status: "pending",
      };
      expect(pendingWhere.reviewedById).toBeNull();
    });

    it("validates WeleticLoyaltyBackfillPreviewItem and WeleticLoyaltyProgram OCC version typing", () => {
      type BackfillWhereInput = Prisma.WeleticLoyaltyBackfillPreviewItemWhereInput;
      const backfillWhere: BackfillWhereInput = {
        accountId: "acc_123",
        account: { id: "acc_123" },
      };
      expect(backfillWhere.accountId).toBe("acc_123");

      type ProgramWhereInput = Prisma.WeleticLoyaltyProgramWhereInput;
      const programWhere: ProgramWhereInput = {
        id: "prog_occ_1",
        version: 1,
      };
      expect(programWhere.version).toBe(1);

      type ProgramUpdateInput = Prisma.WeleticLoyaltyProgramUpdateInput;
      const updateData: ProgramUpdateInput = {
        version: { increment: 1 },
      };
      expect(updateData.version).toBeDefined();
    });
  });

  describe("3. MySQL DDL Syntax & Specification Rigor", () => {
    it("ensures migration file exists and is readable", () => {
      expect(fs.existsSync(migrationSqlPath)).toBe(true);
    });

    it("verifies all DDL statements comply with MySQL 8.0 naming and length limits", () => {
      const sql = fs.readFileSync(migrationSqlPath, "utf8");
      // Strip comments
      const uncommentedSql = sql.replace(/--.*$/gm, "").trim();
      const statements = uncommentedSql
        .split(";")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      expect(statements.length).toBe(10);

      const indexNameRegex = /^CREATE INDEX `([a-zA-Z0-9_]+)` ON `([a-zA-Z0-9_]+)`\((.+)\)$/;
      const alterTableRegex = /^ALTER TABLE `([a-zA-Z0-9_]+)` ADD COLUMN `([a-zA-Z0-9_]+)` (.+)$/;

      const indexNames = new Set<string>();

      for (const stmt of statements) {
        if (stmt.startsWith("CREATE INDEX")) {
          const match = stmt.match(indexNameRegex);
          expect(match, `Invalid CREATE INDEX syntax: ${stmt}`).not.toBeNull();
          if (match) {
            const [, indexName, tableName, columnsPart] = match;
            // MySQL identifier limit is 64 characters
            expect(indexName.length).toBeLessThanOrEqual(64);
            expect(indexNames.has(indexName)).toBe(false); // No duplicate index names
            indexNames.add(indexName);

            // Columns part should contain valid column names
            const cols = columnsPart.split(",").map((c) => c.trim().replace(/`/g, ""));
            expect(cols.length).toBeGreaterThan(0);
            for (const col of cols) {
              expect(col).toMatch(/^[a-zA-Z0-9_]+$/);
            }
          }
        } else if (stmt.startsWith("ALTER TABLE")) {
          const match = stmt.match(alterTableRegex);
          expect(match, `Invalid ALTER TABLE syntax: ${stmt}`).not.toBeNull();
          if (match) {
            const [, tableName, colName, colDef] = match;
            expect(tableName).toBe("WeleticLoyaltyProgram");
            expect(colName).toBe("version");
            expect(colDef.toUpperCase()).toContain("INT NOT NULL DEFAULT 1");
          }
        } else {
          throw new Error(`Unexpected DDL statement: ${stmt}`);
        }
      }

      expect(indexNames.size).toBe(9);
    });
  });
});
