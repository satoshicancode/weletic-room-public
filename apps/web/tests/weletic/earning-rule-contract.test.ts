import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  earningRuleFieldsSchema,
  earningRuleRetireSchema,
  earningRuleWriteSchema,
  type EarningRuleFields,
} from "../../lib/weletic/loyalty/earning-rule-contract";
import { parseEarningRuleData } from "../../lib/weletic/loyalty/earning-rule-input";

const purchase: EarningRuleFields = {
  name: "Purchase points",
  description: null,
  triggerCode: "order_paid",
  priority: 0,
  multiplier: "1.0001",
  fixedPoints: null,
  maxPointsPerEvent: null,
  minOrderSubtotal: "0",
  excludeDiscountedItems: false,
  excludeTaxesAndShipping: true,
  maxEventsPerCustomer: null,
  limitInterval: null,
  conditions: null,
  isActive: false,
};
const activity: EarningRuleFields = {
  ...purchase,
  triggerCode: "account_created",
  multiplier: "1",
  fixedPoints: "9223372036854775807",
  minOrderSubtotal: null,
  maxEventsPerCustomer: 1,
  limitInterval: "lifetime",
};

describe("strict earning-rule wire contract", () => {
  it("bounds descriptions to the existing database column", () => {
    expect(
      earningRuleFieldsSchema.safeParse({
        ...purchase,
        description: "a".repeat(191),
      }).success,
    ).toBe(true);
    expect(
      earningRuleFieldsSchema.safeParse({
        ...purchase,
        description: "a".repeat(192),
      }).success,
    ).toBe(false);
  });
  it("bounds the combined review award unless an explicit cap makes it safe", () => {
    const rule = {
      ...activity,
      triggerCode: "product_review",
      conditions: {
        provider: "native",
        minContentLength: 20,
        photoBonusPoints: 1,
        videoBonusPoints: 1,
      },
    };
    expect(earningRuleFieldsSchema.safeParse(rule).success).toBe(false);
    expect(
      earningRuleFieldsSchema.safeParse({ ...rule, maxPointsPerEvent: "100" })
        .success,
    ).toBe(true);
  });
  it("maps exact values without number coercion or manufactured fields", () => {
    const data = parseEarningRuleData(activity);
    expect(data.fixedPoints).toBe(BigInt("9223372036854775807"));
    expect(data.conditions).toBe(Prisma.DbNull);
    expect(data.ruleType).toBe("fixed_points");
    expect(data).not.toHaveProperty("storeId");
    expect(parseEarningRuleData(purchase).multiplier.toString()).toBe("1.0001");
    expect(() =>
      parseEarningRuleData({ ...activity, fixedPoints: 10 }),
    ).toThrow();
  });
  it("preserves exact decimal and signed-64-bit strings", () => {
    expect(earningRuleFieldsSchema.parse(purchase).multiplier).toBe("1.0001");
    expect(earningRuleFieldsSchema.parse(activity).fixedPoints).toBe(
      "9223372036854775807",
    );
  });
  it.each([
    { multiplier: 1 },
    { multiplier: "1e2" },
    { multiplier: "1000000" },
    { multiplier: "0.00001" },
    { multiplier: "0.0000" },
    { multiplier: "01" },
    { minOrderSubtotal: "100000000" },
    { minOrderSubtotal: "0.001" },
    { priority: 2147483648 },
    { priority: -2147483649 },
    { isActive: "true" },
    { excludeTaxesAndShipping: false },
    { fixedPoints: "1" },
    { conditions: {} },
    { programId: "another-program" },
    { deletedAt: "2026-01-01" },
    { name: "  " },
    { name: "name\u0000" },
  ])("rejects invalid purchase fields %j", (patch) => {
    expect(
      earningRuleFieldsSchema.safeParse({ ...purchase, ...patch }).success,
    ).toBe(false);
  });
  it.each([
    { fixedPoints: "9223372036854775808" },
    { fixedPoints: 10 },
    { fixedPoints: "0" },
    { fixedPoints: null },
    { fixedPoints: "01" },
    { multiplier: "2" },
    { minOrderSubtotal: "10" },
    { maxEventsPerCustomer: null },
    { maxEventsPerCustomer: 101 },
    { limitInterval: "monthly" },
    { conditions: { targetUrl: "https://example.com" } },
  ])("rejects invalid activity fields %j", (patch) => {
    expect(
      earningRuleFieldsSchema.safeParse({ ...activity, ...patch }).success,
    ).toBe(false);
  });
  it("enforces birthday calendar-year semantics", () => {
    expect(
      earningRuleFieldsSchema.safeParse({
        ...activity,
        triggerCode: "birthday",
      }).success,
    ).toBe(false);
    expect(
      earningRuleFieldsSchema.safeParse({
        ...activity,
        triggerCode: "birthday",
        limitInterval: "calendar_year",
      }).success,
    ).toBe(true);
  });
  it("requires an explicit review provider and bounded bonuses", () => {
    const rule = {
      ...activity,
      triggerCode: "product_review",
      conditions: {
        provider: "native",
        minContentLength: 20,
        photoBonusPoints: 0,
        videoBonusPoints: 0,
      },
    };
    expect(earningRuleFieldsSchema.safeParse(rule).success).toBe(true);
    expect(
      earningRuleFieldsSchema.safeParse({
        ...rule,
        conditions: { ...rule.conditions, provider: undefined },
      }).success,
    ).toBe(false);
    expect(
      earningRuleFieldsSchema.safeParse({
        ...rule,
        conditions: { ...rule.conditions, photoBonusPoints: 1000001 },
      }).success,
    ).toBe(false);
  });
  it("uses provider URL policy and does not silently truncate new input", () => {
    const rule = {
      ...activity,
      triggerCode: "instagram_follow",
      conditions: { targetUrl: "https://www.instagram.com/shop" },
    };
    expect(earningRuleFieldsSchema.safeParse(rule).success).toBe(true);
    expect(
      earningRuleFieldsSchema.safeParse({
        ...rule,
        conditions: { targetUrl: "https://example.com" },
      }).success,
    ).toBe(false);
    expect(
      earningRuleFieldsSchema.safeParse({
        ...rule,
        conditions: { ...rule.conditions, shareMessage: "a".repeat(281) },
      }).success,
    ).toBe(false);
  });
  it("requires stale-write tokens and refuses injected authority", () => {
    const input = {
      expectedInstallationGeneration: "generation",
      expectedRevision: null,
      ruleId: null,
      rule: purchase,
    };
    expect(earningRuleWriteSchema.safeParse(input).success).toBe(true);
    expect(
      earningRuleWriteSchema.safeParse({ ...input, storeId: "other" }).success,
    ).toBe(false);
    expect(
      earningRuleWriteSchema.safeParse({
        ...input,
        expectedInstallationGeneration: undefined,
      }).success,
    ).toBe(false);
    expect(
      earningRuleRetireSchema.safeParse({
        expectedInstallationGeneration: "generation",
        expectedRevision: null,
        ruleId: "rule",
      }).success,
    ).toBe(false);
  });
});
