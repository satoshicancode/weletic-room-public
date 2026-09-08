import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { planShopperRewardExpansion } from "../../../../infra/shopify-development/shopper-reward-migration-plan.mjs";

const phases = [
  "shopper_reward_ownership",
  "review_incentive_claims",
  "shopper_coupon_outbox",
  "reward_coupon_use",
  "review_invalidation",
  "review_invalidation_reward_status",
].map((name) =>
  readFileSync(
    new URL(
      `../../../../infra/shopify-development/migrations/20260907_${name}.sql`,
      import.meta.url,
    ),
    "utf8",
  ).trim(),
);
const statements = phases
  .join("\n")
  .replace(/^--.*$/gm, "")
  .split(";")
  .map((sql) => sql.trim())
  .filter(Boolean);

describe("isolated shopper incentive expansion plan", () => {
  it("keeps the fresh-table index inline and the already-expanded index separate", () => {
    const fresh = phases[3];
    const incremental = readFileSync(
      new URL(
        "../../../../infra/shopify-development/migrations/20260907_reward_coupon_use_retention_index.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(fresh).toContain(
      "INDEX `wl_coupon_use_store_id_idx`(`storeId`, `id`)",
    );
    expect(fresh).not.toContain("CREATE INDEX `wl_coupon_use_store_id_idx`");
    expect(planShopperRewardExpansion(fresh, [fresh])).toHaveLength(2);
    expect(planShopperRewardExpansion(incremental, [incremental])).toHaveLength(
      1,
    );
    expect(() =>
      planShopperRewardExpansion(fresh, [fresh, incremental]),
    ).toThrow();
  });
  it("accepts only the exact fresh inline claim index representation", () => {
    const index =
      "CREATE UNIQUE INDEX `wl_review_claim_store_id_uq` ON `WeleticReviewIncentiveClaim`(`storeId`, `id`)";
    const inline =
      "    UNIQUE INDEX `wl_review_claim_store_id_uq`(`storeId`, `id`),\n";
    const fresh = statements
      .filter((sql) => sql !== index)
      .map((sql) =>
        sql.startsWith("CREATE TABLE `WeleticReviewIncentiveClaim` (")
          ? sql.replace("    INDEX ", inline + "    INDEX ")
          : sql,
      )
      .join(";");
    expect(planShopperRewardExpansion(fresh, phases)).toEqual(statements);
    expect(() =>
      planShopperRewardExpansion(fresh + ";" + index, phases),
    ).toThrow();
    expect(() =>
      planShopperRewardExpansion(
        fresh.replace(
          inline,
          inline.replace("`storeId`, `id`", "`id`, `storeId`"),
        ),
        phases,
      ),
    ).toThrow();
  });
  it("accepts the complete reviewed expansion irrespective of Prisma operation ordering", () => {
    expect(
      planShopperRewardExpansion([...statements].reverse().join(";"), phases),
    ).toEqual(statements);
  });
  it.each(phases.map((sql, index) => [index, sql] as const))(
    "also validates the original incremental phase %s",
    (_index, sql) => {
      expect(planShopperRewardExpansion(sql, [sql]).length).toBeGreaterThan(0);
    },
  );
  it.each([
    statements.slice(1).join(";"),
    [...statements, statements[0]].join(";"),
    statements.join(";").replace("VARCHAR(32)", "VARCHAR(33)"),
    [...statements, "DROP TABLE `WeleticShopper`"].join(";"),
  ])("refuses partial, duplicate, changed or extra operations", (actual) => {
    expect(() => planShopperRewardExpansion(actual, phases)).toThrow(
      "differs from reviewed SQL",
    );
  });
  it.each([
    "DROP TABLE `WeleticShopper`",
    "ALTER TABLE `User` ADD COLUMN `unexpected` INTEGER",
  ])(
    "refuses non-allowlisted operations even if included in reviewed input",
    (sql) => {
      expect(() => planShopperRewardExpansion(sql, [sql])).toThrow();
    },
  );
  it("treats an already matching schema as a no-op", () => {
    expect(
      planShopperRewardExpansion("-- This is an empty migration.", phases),
    ).toEqual([]);
  });
});
