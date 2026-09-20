import { readFlowGrantQuantities } from "@/lib/weletic/loyalty/flow-action-grant-storage";
import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

const row = (
  limit = "9223372036854775808",
  budget = "18446744073709551615",
  used = "0",
) => ({
  maxAbsolutePointsPerAction: new Prisma.Decimal(limit),
  absolutePointsBudget: new Prisma.Decimal(budget),
  absolutePointsUsed: new Prisma.Decimal(used),
});

describe("exact persisted Flow grant quantities", () => {
  it("decodes the full approved range without Number conversion", () => {
    expect(readFlowGrantQuantities(row())).toEqual({
      maxAbsolutePointsPerAction: BigInt("9223372036854775808"),
      absolutePointsBudget: BigInt("18446744073709551615"),
      absolutePointsUsed: BigInt(0),
    });
  });
  it.each([
    ["0", "10", "0"],
    ["11", "10", "0"],
    ["10", "10", "11"],
    ["10", "10", "-1"],
    ["10", "10", "0.5"],
    ["1.5", "10", "0"],
    ["10", "10.5", "0"],
    ["9223372036854775809", "18446744073709551615", "0"],
    ["1", "18446744073709551616", "0"],
    ["NaN", "10", "0"],
    ["1", "Infinity", "0"],
  ])("rejects invalid stored quantities %s/%s/%s", (limit, budget, used) => {
    expect(() => readFlowGrantQuantities(row(limit, budget, used))).toThrow(
      "Invalid stored Flow grant quantity",
    );
  });
});
