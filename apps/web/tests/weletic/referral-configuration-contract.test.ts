import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMerchantReferralConfigurationClient } from "../../../../packages/shopify-app/app/merchant-referral-configuration-client";
import { verifyReferralConfigurationAcknowledgement } from "../../lib/weletic/loyalty/referral-configuration-acknowledgement";
import {
  referralConfigurationFieldsSchema,
  referralConfigurationRequestSchema,
} from "../../lib/weletic/loyalty/referral-configuration-contract";
import { DEFAULT_REFERRAL_RULE_CONFIG } from "../../lib/weletic/loyalty/referral-rule-config";
import { createWorkspaceReferralConfigurationClient } from "../../lib/weletic/loyalty/workspace-referral-configuration-client";

const fields = {
  ...DEFAULT_REFERRAL_RULE_CONFIG,
  advocatePointsReward: "9007199254740993",
  isActive: false,
};
const input = {
  expectedInstallationGeneration: "g1",
  expectedRevision: "a".repeat(64),
  ruleId: "rule-a",
  fields,
};
const view = {
  storeId: "store-a",
  programId: "program-a",
  installationGeneration: "g1",
  shopCurrency: "JPY",
  thresholdDecimalPlaces: 0,
  revision: "b".repeat(64),
  capabilities: { configure: true },
  ruleId: "rule-a",
  fields,
  active: false,
  legacyConfiguration: false,
  couponOptions: [],
  acknowledgedOperation: "save",
};
describe("strict referral configuration", () => {
  it("preserves signed-64-bit point strings", () =>
    expect(
      referralConfigurationFieldsSchema.parse(fields).advocatePointsReward,
    ).toBe("9007199254740993"));
  it.each(["0", "1", "9223372036854775807"])("accepts points %s", (value) =>
    expect(
      referralConfigurationFieldsSchema.safeParse({
        ...fields,
        advocatePointsReward: value,
      }).success,
    ).toBe(true),
  );
  it.each([
    "-1",
    "01",
    "1.1",
    "1e4",
    "9223372036854775808",
    9007199254740992,
    null,
  ])("rejects unsafe points %s", (value) =>
    expect(
      referralConfigurationFieldsSchema.safeParse({
        ...fields,
        advocatePointsReward: value,
      }).success,
    ).toBe(false),
  );
  it.each(["0", "1.01", "99999999.99", null])(
    "preserves representable major-unit threshold %s",
    (value) =>
      expect(
        referralConfigurationFieldsSchema.safeParse({
          ...fields,
          minQualifyingOrderSubtotal: value,
        }).success,
      ).toBe(true),
  );
  it.each(["0.001", "100000000", "-1", "NaN", "1e2", 0.1])(
    "rejects lossy threshold %s",
    (value) =>
      expect(
        referralConfigurationFieldsSchema.safeParse({
          ...fields,
          minQualifyingOrderSubtotal: value,
        }).success,
      ).toBe(false),
  );
  it.each([0, -1, 1000001, "1", 1.5])("rejects invalid maximum %s", (value) =>
    expect(
      referralConfigurationFieldsSchema.safeParse({
        ...fields,
        maxReferralsPerAdvocate: value,
      }).success,
    ).toBe(false),
  );
  it.each([
    { isActive: "false" },
    { fraudCheckSameIp: 0 },
    { privateKey: "unexpected" },
    { advocateRewardDefinitionId: "hidden" },
    { advocateRewardKind: "coupon" },
    { advocateRewardKind: "coupon", advocateRewardDefinitionId: "reward" },
  ])("rejects hidden/inconsistent terms %#", (patch) =>
    expect(
      referralConfigurationFieldsSchema.safeParse({ ...fields, ...patch })
        .success,
    ).toBe(false),
  );
  it("requires explicit coupon and zero unused points", () =>
    expect(
      referralConfigurationFieldsSchema.safeParse({
        ...fields,
        advocateRewardKind: "coupon",
        advocateRewardDefinitionId: "reward",
        advocatePointsReward: "0",
      }).success,
    ).toBe(true));
  it("pause accepts only optimistic authority fields", () => {
    expect(
      referralConfigurationRequestSchema.safeParse({
        operation: "pause",
        input: {
          expectedRevision: input.expectedRevision,
          expectedInstallationGeneration: "g1",
        },
      }).success,
    ).toBe(true);
    expect(
      referralConfigurationRequestSchema.safeParse({
        operation: "pause",
        input: { ...input, isActive: true },
      }).success,
    ).toBe(false);
  });
  it.each([
    { acknowledgedOperation: "read" },
    { active: true },
    { ruleId: "wrong" },
    { installationGeneration: "g2" },
    { fields: { ...fields, advocatePointsReward: "9007199254740992" } },
    { fields: null },
  ])("rejects a mismatched acknowledgement %#", (patch) =>
    expect(() =>
      verifyReferralConfigurationAcknowledgement(
        { operation: "save", input },
        { ...view, ...patch },
      ),
    ).toThrow(),
  );
  it("accepts canonical trailing-zero money without numeric conversion", () =>
    expect(
      verifyReferralConfigurationAcknowledgement(
        {
          operation: "save",
          input: {
            ...input,
            fields: { ...fields, minQualifyingOrderSubtotal: "30.00" },
          },
        },
        view,
      ),
    ).toEqual(view));
});
const fetcher = vi.fn<typeof fetch>();
const token = vi.fn<() => Promise<string>>();
beforeEach(() => {
  vi.resetAllMocks();
  token.mockResolvedValue("synthetic");
  fetcher.mockResolvedValue(Response.json(view));
});
afterEach(() => vi.useRealTimers());
describe.each(["shopify", "workspace"] as const)(
  "%s referral transport",
  (kind) => {
    const client = () =>
      kind === "shopify"
        ? createMerchantReferralConfigurationClient(token, fetcher)
        : createWorkspaceReferralConfigurationClient("workspace/a&b", fetcher);
    it("saves exact payload once", async () => {
      expect(await client().save(input)).toEqual(view);
      expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
        operation: "save",
        input,
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it("reads with the correct authority boundary", async () => {
      fetcher.mockResolvedValue(
        Response.json({ ...view, acknowledgedOperation: "read" }),
      );
      await client().read();
      expect(fetcher.mock.calls[0][1]).toMatchObject({
        cache: "no-store",
        credentials: kind === "shopify" ? "omit" : "same-origin",
        method: kind === "shopify" ? "POST" : "GET",
      });
      if (kind === "shopify") expect(token).toHaveBeenCalledOnce();
      else
        expect(fetcher.mock.calls[0][0]).toBe(
          "/api/weletic/referral-configuration?workspaceId=workspace%2Fa%26b",
        );
    });
    it("pauses without requiring editable legacy terms or currency", async () => {
      fetcher.mockResolvedValue(
        Response.json({
          ...view,
          fields: null,
          legacyConfiguration: true,
          shopCurrency: null,
          thresholdDecimalPlaces: null,
          acknowledgedOperation: "pause",
        }),
      );
      await client().pause({
        expectedInstallationGeneration: "g1",
        expectedRevision: input.expectedRevision,
      });
      expect(fetcher).toHaveBeenCalledOnce();
    });
    it.each([401, 403, 409, 503])("does not retry HTTP %s", async (status) => {
      fetcher.mockResolvedValue(new Response("", { status }));
      await expect(client().save(input)).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledOnce();
    });
    it("times out a single uncertain write", async () => {
      vi.useFakeTimers();
      fetcher.mockImplementation(() => new Promise(() => {}));
      const result = expect(client().save(input)).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(kind === "shopify" ? 30001 : 8001);
      await result;
      expect(fetcher).toHaveBeenCalledOnce();
    });
  },
);
