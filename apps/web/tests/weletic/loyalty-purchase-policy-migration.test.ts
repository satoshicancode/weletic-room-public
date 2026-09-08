import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  new URL(
    "../../../../infra/shopify-development/migrations/20260908_loyalty_purchase_policy.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("loyalty purchase policy migration", () => {
  it("is additive, nullable, and limited to the three reviewed policy owners", () => {
    expect(sql.match(/ALTER TABLE/g)).toHaveLength(3);
    for (const table of [
      "WeleticLoyaltyEarningRule",
      "WeleticRewardDefinition",
      "WeleticLoyaltyReferralRule",
    ]) {
      expect(sql).toContain(
        `ALTER TABLE \`${table}\`\n  ADD COLUMN \`purchasePolicy\` JSON NULL;`,
      );
    }
    const statements = sql.replace(/^--.*$/gm, "");
    expect(statements).not.toMatch(/DROP|DELETE|UPDATE|NOT NULL|DEFAULT/i);
  });
});
