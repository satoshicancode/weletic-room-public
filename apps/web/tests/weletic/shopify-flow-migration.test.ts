import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Shopify Flow migration preserves the native-review outbox contract", () => {
  it("preserves historical enum ordinals and only appends the approved import types", () => {
    const schema = readFileSync(
      new URL("../../prisma/schema/weletic-loyalty.prisma", import.meta.url),
      "utf8",
    );
    const sql = readFileSync(
      new URL(
        "../../scripts/loyalty/sql/shopify-flow-stage-1.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const prismaEnum = schema.match(
      /enum WeleticLoyaltyOutboxJobType\s*\{([^}]+)\}/,
    );
    const sqlEnum = sql.match(/MODIFY COLUMN `jobType` ENUM\(([^)]+)\)/);
    expect(prismaEnum).not.toBeNull();
    expect(sqlEnum).not.toBeNull();
    if (!prismaEnum || !sqlEnum)
      throw new Error("Outbox enum definition missing");

    const prismaLabels = prismaEnum[1]
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, "").trim())
      .filter(Boolean);
    const sqlLabels = Array.from(
      sqlEnum[1].matchAll(/'([^']+)'/g),
      (match) => match[1],
    );
    // Historical migrations stay immutable. Later additive enum changes must
    // retain every old ordinal; shared deployment of the new labels is gated.
    expect(prismaLabels.slice(0, sqlLabels.length)).toEqual(sqlLabels);
    expect(prismaLabels.slice(sqlLabels.length)).toEqual([
      "HISTORICAL_IMPORT_COMMIT",
      "HISTORICAL_IMPORT_ROLLBACK",
    ]);
    const expansion = readFileSync(
      new URL(
        "../../../../infra/shopify-development/migrations/20260907_shopper_coupon_outbox.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const expandedEnum = expansion.match(/MODIFY `jobType` ENUM\(([^)]+)\)/);
    if (!expandedEnum) throw new Error("Shopper coupon enum expansion missing");
    expect(
      Array.from(expandedEnum[1].matchAll(/'([^']+)'/g), (match) => match[1]),
    ).toEqual(sqlLabels);
    expect(sqlLabels).toEqual(
      expect.arrayContaining([
        "REVIEW_REQUEST_EMAIL",
        "REVIEW_SUMMARY_SYNC",
        "REVIEW_MEDIA_CLEANUP",
        "FLOW_TRIGGER",
        "SHOPPER_REWARD_PROVISION",
      ]),
    );
  });
});
