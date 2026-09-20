import { describe, expect, it } from "vitest";
import { FlowGrantListResponseSchema } from "../../lib/weletic/loyalty/flow-grants-merchant-contract";
const grant = {
  id: `wflowgrant_${"a".repeat(20)}`,
  revision: 1,
  allowCredit: true,
  allowDebit: false,
  maxAbsolutePointsPerAction: "9223372036854775808",
  absolutePointsBudget: "18446744073709551615",
  absolutePointsUsed: "0",
  remainingAbsolutePoints: "18446744073709551615",
  createdAt: "2026-09-20T00:00:00.000Z",
  expiresAt: "2030-01-01T00:00:00.000Z",
  revokedAt: null,
  status: "active",
};
const response = (change = {}) => ({
  grants: [{ ...grant, ...change }],
  nextCursor: null,
  installationGeneration: "g1",
  observedAt: "2026-09-20T00:00:00.000Z",
});
describe("Flow merchant response truthfulness", () => {
  it("preserves exact unsigned quantities", () => {
    expect(
      FlowGrantListResponseSchema.parse(response()).grants[0]
        .absolutePointsBudget,
    ).toBe(grant.absolutePointsBudget);
  });
  it.each([
    { remainingAbsolutePoints: "1" },
    { absolutePointsBudget: "not-number" },
    { absolutePointsUsed: "1.5" },
    { allowCredit: false },
    { revokedAt: "2026-09-20T00:00:00.000Z" },
    { expiresAt: "2026-09-20T00:00:00.000Z" },
    { status: "exhausted" },
    { status: "expired" },
    { status: "revoked" },
    { approvedByShopifyUserId: "123" },
  ])(
    "rejects malformed or contradictory view %j without throwing",
    (change) => {
      expect(
        FlowGrantListResponseSchema.safeParse(response(change)).success,
      ).toBe(false);
    },
  );
  it.each([
    { status: "revoked", revokedAt: "2026-09-20T00:00:00.000Z" },
    { status: "expired", expiresAt: "2026-09-20T00:00:00.000Z" },
    {
      status: "exhausted",
      absolutePointsUsed: grant.absolutePointsBudget,
      remainingAbsolutePoints: "0",
    },
  ])("accepts consistent lifecycle %j", (change) => {
    expect(
      FlowGrantListResponseSchema.safeParse(response(change)).success,
    ).toBe(true);
  });
  it("rejects duplicate rows and foreign cursors", () => {
    expect(
      FlowGrantListResponseSchema.safeParse({
        ...response(),
        grants: [grant, grant],
      }).success,
    ).toBe(false);
    expect(
      FlowGrantListResponseSchema.safeParse({
        ...response(),
        nextCursor: `wflowgrant_${"z".repeat(20)}`,
      }).success,
    ).toBe(false);
  });
});
