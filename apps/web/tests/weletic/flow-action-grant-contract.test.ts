import {
  consumeFlowPointsBudget,
  CreateFlowPointsGrantSchema,
  FLOW_ABSOLUTE_DELTA_MAX,
  FLOW_UNSIGNED_MAX,
} from "@/lib/weletic/loyalty/flow-action-grant-contract";
import { describe, expect, it } from "vitest";

const grant = {
  allowCredit: true,
  allowDebit: true,
  maxAbsolutePointsPerAction: "100",
  absolutePointsBudget: "1000",
  expiresAt: "2026-10-01T00:00:00Z",
  expectedRevision: 0,
  expectedInstallationGeneration: "generation-1",
};
const locked = {
  pointsDelta: BigInt(10),
  allowCredit: true,
  allowDebit: true,
  maxAbsolutePointsPerAction: BigInt(100),
  absolutePointsBudget: BigInt(1000),
  absolutePointsUsed: BigInt(0),
};
describe("bounded Flow grant contracts", () => {
  it("requires explicit authority and no implicit defaults", () => {
    expect(CreateFlowPointsGrantSchema.parse(grant)).toEqual(grant);
    expect(CreateFlowPointsGrantSchema.safeParse({}).success).toBe(false);
  });
  it.each([
    { allowCredit: false, allowDebit: false },
    { absolutePointsBudget: "99" },
    { absolutePointsBudget: "18446744073709551616" },
    { maxAbsolutePointsPerAction: "9223372036854775809" },
    { absolutePointsBudget: 1000 },
    { expectedRevision: 1 },
    { ownerId: "forged" },
    { expiresAt: "never" },
  ])("rejects invalid policy %j", (patch) => {
    expect(
      CreateFlowPointsGrantSchema.safeParse({ ...grant, ...patch }).success,
    ).toBe(false);
  });
  it("counts debit and credit against the same lifetime absolute budget", () => {
    const used = consumeFlowPointsBudget(locked);
    expect(
      consumeFlowPointsBudget({
        ...locked,
        pointsDelta: BigInt(-10),
        absolutePointsUsed: used,
      }),
    ).toBe(BigInt(20));
  });
  it("supports the minimum signed delta without absolute-value overflow", () => {
    expect(
      consumeFlowPointsBudget({
        ...locked,
        pointsDelta: -FLOW_ABSOLUTE_DELTA_MAX,
        maxAbsolutePointsPerAction: FLOW_ABSOLUTE_DELTA_MAX,
        absolutePointsBudget: FLOW_UNSIGNED_MAX,
      }),
    ).toBe(FLOW_ABSOLUTE_DELTA_MAX);
  });
  it.each([
    { pointsDelta: BigInt(0) },
    { pointsDelta: FLOW_ABSOLUTE_DELTA_MAX },
    { allowCredit: false },
    { pointsDelta: BigInt(-1), allowDebit: false },
    { absolutePointsUsed: BigInt(995) },
    { absolutePointsUsed: BigInt(-1) },
    { absolutePointsBudget: FLOW_UNSIGNED_MAX + BigInt(1) },
    { maxAbsolutePointsPerAction: BigInt(9) },
  ])("rejects exhausted/corrupt/unauthorized arithmetic %#", (patch) => {
    expect(() => consumeFlowPointsBudget({ ...locked, ...patch })).toThrow(
      "grant limit exceeded",
    );
  });
});
