import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("PERF-01: Prisma Relation Mode Composite Indexes & Validation Suite", () => {
  const rootDir = path.resolve(__dirname, "../../../..");
  const webDir = path.resolve(rootDir, "apps/web");

  it("1. validates prisma schema with zero relationMode warnings via CLI", () => {
    const output = execSync(
      "pnpm --filter web exec prisma validate --schema=./prisma/schema",
      {
        cwd: rootDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    expect(output).toContain("The schemas at prisma/schema are valid");
    expect(output).not.toContain("Prisma schema warnings:");
    expect(output).not.toContain("With `relationMode = \"prisma\"`");
  });

  it("2. declares all required composite indexes in prisma schema files", () => {
    const loyaltyPath = path.join(
      webDir,
      "prisma/schema/weletic-loyalty.prisma",
    );
    const discountPath = path.join(webDir, "prisma/schema/discount.prisma");
    const fraudPath = path.join(webDir, "prisma/schema/fraud.prisma");

    const loyaltySchema = fs.readFileSync(loyaltyPath, "utf8");
    const discountSchema = fs.readFileSync(discountPath, "utf8");
    const fraudSchema = fs.readFileSync(fraudPath, "utf8");

    // WeleticLoyaltyTierHistory: fromTierId index
    expect(loyaltySchema).toMatch(
      /model\s+WeleticLoyaltyTierHistory\s*\{[\s\S]*?@@index\(\[fromTierId\]\)/,
    );

    // WeleticLoyaltyEarnGrant: shopperId and [programId, status]
    expect(loyaltySchema).toMatch(
      /model\s+WeleticLoyaltyEarnGrant\s*\{[\s\S]*?@@index\(\[shopperId\]\)/,
    );
    expect(loyaltySchema).toMatch(
      /model\s+WeleticLoyaltyEarnGrant\s*\{[\s\S]*?@@index\(\[programId,\s*status\]\)/,
    );

    // WeleticRewardRedemption: rewardDefinitionId index
    expect(loyaltySchema).toMatch(
      /model\s+WeleticRewardRedemption\s*\{[\s\S]*?@@index\(\[rewardDefinitionId\]\)/,
    );

    // WeleticLoyaltyBackfillPreviewItem: accountId index
    expect(loyaltySchema).toMatch(
      /model\s+WeleticLoyaltyBackfillPreviewItem\s*\{[\s\S]*?@@index\(\[accountId\]\)/,
    );

    // DiscountCode: [programId, disabledAt] and [partnerId, disabledAt] (Invariant 2)
    expect(discountSchema).toMatch(
      /model\s+DiscountCode\s*\{[\s\S]*?@@index\(\[programId,\s*disabledAt\]\)/,
    );
    expect(discountSchema).toMatch(
      /model\s+DiscountCode\s*\{[\s\S]*?@@index\(\[partnerId,\s*disabledAt\]\)/,
    );

    // FraudAlert: [programId, partnerId] and [reviewedById]
    expect(fraudSchema).toMatch(
      /model\s+FraudAlert\s*\{[\s\S]*?@@index\(\[programId,\s*partnerId\]\)/,
    );
    expect(fraudSchema).toMatch(
      /model\s+FraudAlert\s*\{[\s\S]*?@@index\(\[reviewedById\]\)/,
    );
  });

  it("3. provides valid DDL migration SQL file with all required index definitions", () => {
    const migrationFile = path.join(
      rootDir,
      "infra/shopify-development/migrations/20261005_perf01_relation_composite_indexes.sql",
    );
    expect(fs.existsSync(migrationFile)).toBe(true);

    const sql = fs.readFileSync(migrationFile, "utf8");

    expect(sql).toContain(
      "CREATE INDEX `WeleticLoyaltyTierHistory_fromTierId_idx` ON `WeleticLoyaltyTierHistory`(`fromTierId`);",
    );
    expect(sql).toContain(
      "CREATE INDEX `WeleticLoyaltyEarnGrant_shopperId_idx` ON `WeleticLoyaltyEarnGrant`(`shopperId`);",
    );
    expect(sql).toContain(
      "CREATE INDEX `WeleticLoyaltyEarnGrant_programId_status_idx` ON `WeleticLoyaltyEarnGrant`(`programId`, `status`);",
    );
    expect(sql).toContain(
      "CREATE INDEX `WeleticRewardRedemption_rewardDefinitionId_idx` ON `WeleticRewardRedemption`(`rewardDefinitionId`);",
    );
    expect(sql).toContain(
      "CREATE INDEX `WeleticLoyaltyBackfillPreviewItem_accountId_idx` ON `WeleticLoyaltyBackfillPreviewItem`(`accountId`);",
    );
    expect(sql).toContain(
      "CREATE INDEX `DiscountCode_programId_disabledAt_idx` ON `DiscountCode`(`programId`, `disabledAt`);",
    );
    expect(sql).toContain(
      "CREATE INDEX `DiscountCode_partnerId_disabledAt_idx` ON `DiscountCode`(`partnerId`, `disabledAt`);",
    );
    expect(sql).toContain(
      "CREATE INDEX `FraudAlert_programId_partnerId_idx` ON `FraudAlert`(`programId`, `partnerId`);",
    );
    expect(sql).toContain(
      "CREATE INDEX `FraudAlert_reviewedById_idx` ON `FraudAlert`(`reviewedById`);",
    );
    expect(sql).toContain(
      "ALTER TABLE `WeleticLoyaltyProgram` ADD COLUMN `version` INT NOT NULL DEFAULT 1;",
    );
  });
});
