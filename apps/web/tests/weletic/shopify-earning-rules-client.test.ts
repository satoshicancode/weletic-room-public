import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMerchantEarningRulesClient } from "../../../../packages/shopify-app/app/merchant-earning-rules-client";
const fields = {
  name: "Purchase",
  description: null,
  triggerCode: "order_paid" as const,
  priority: 0,
  multiplier: "1.2500",
  fixedPoints: null,
  maxPointsPerEvent: "9007199254740993",
  minOrderSubtotal: "10.00",
  excludeDiscountedItems: false,
  excludeTaxesAndShipping: true as const,
  purchaseType: "both" as const,
  subscriptionCadence: "every_payment" as const,
  subscriptionPaymentLimit: null,
  maxEventsPerCustomer: null,
  limitInterval: null,
  conditions: null,
  isActive: false,
};
const input = {
  expectedInstallationGeneration: "g1",
  expectedRevision: "a".repeat(64),
  ruleId: "rule-a",
  rule: fields,
};
const savedRule = {
  id: "rule-a",
  name: "Purchase",
  triggerCode: "order_paid",
  isActive: false,
  fields: { ...fields, multiplier: "1.25", minOrderSubtotal: "10" },
  editUnavailableReason: null,
  constraints: { startAt: null, endAt: null, hasTierEligibility: false },
};
const view = {
  storeId: "store-a",
  installationGeneration: "g1",
  programId: "program-a",
  revision: "b".repeat(64),
  affectedRuleId: "rule-a",
  rules: [savedRule],
  capabilities: { configure: true },
};
const token = vi.fn<() => Promise<string>>();
const fetcher = vi.fn<typeof fetch>();
const client = () => createMerchantEarningRulesClient(token, fetcher);
beforeEach(() => {
  vi.resetAllMocks();
  token.mockResolvedValue("synthetic");
  fetcher.mockImplementation(async () => Response.json(view));
});
afterEach(() => vi.useRealTimers());
describe("earning-rule browser acknowledgement", () => {
  it("gets fresh tokens and preserves exact inputs without cookies", async () => {
    token.mockResolvedValueOnce("first").mockResolvedValueOnce("second");
    const api = client();
    await api.read();
    expect(await api.save(input)).toEqual(view);
    expect(token).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]).toEqual([
      "/api/merchant/earning-rules",
      expect.objectContaining({
        credentials: "omit",
        cache: "no-store",
        headers: expect.objectContaining({ Authorization: "Bearer second" }),
      }),
    ]);
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({
      operation: "save",
      input,
    });
  });
  it("acknowledges creation only using the returned affected ID", async () => {
    expect(await client().save({ ...input, ruleId: null })).toEqual(view);
    fetcher.mockResolvedValue(
      Response.json({ ...view, affectedRuleId: "absent" }),
    );
    await expect(client().save({ ...input, ruleId: null })).rejects.toThrow(
      "unavailable",
    );
  });
  it.each([
    { ...view, affectedRuleId: null },
    { ...view, installationGeneration: "old" },
    { ...view, rules: [] },
    { ...view, affectedRuleId: "other" },
    {
      ...view,
      rules: [
        {
          ...savedRule,
          fields: {
            ...savedRule.fields,
            maxPointsPerEvent: "9007199254740992",
          },
        },
      ],
    },
  ])("rejects inconsistent save responses without retry", async (data) => {
    fetcher.mockResolvedValue(Response.json(data));
    await expect(client().save(input)).rejects.toThrow("unavailable");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("requires the retired rule to be absent and the affected ID to match", async () => {
    const { rule, ...retire } = input;
    await expect(client().retire(retire)).rejects.toThrow("unavailable");
    fetcher.mockResolvedValue(Response.json({ ...view, rules: [] }));
    expect((await client().retire(retire)).rules).toEqual([]);
    fetcher.mockResolvedValue(
      Response.json({ ...view, rules: [], affectedRuleId: "other" }),
    );
    await expect(client().retire(retire)).rejects.toThrow("unavailable");
  });
  it("validates before requesting a token", async () => {
    await expect(
      client().save({ ...input, rule: { ...fields, multiplier: "1e5" } }),
    ).rejects.toThrow("invalid");
    expect(token).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([401, 403, 409, 503])("does not retry HTTP %s", async (status) => {
    fetcher.mockResolvedValue(Response.json({}, { status }));
    await expect(client().save(input)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("bounds a stalled response body without retrying", async () => {
    vi.useFakeTimers();
    fetcher.mockResolvedValue({
      ok: true,
      json: () => new Promise(() => {}),
    } as Response);
    const pending = expect(client().save(input)).rejects.toThrow("unavailable");
    await vi.advanceTimersByTimeAsync(30001);
    await pending;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
});
