import { manageShopifyEarningRulesInTransaction as manage } from "@/lib/weletic/shopify/earning-rules";
import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  fence: vi.fn(),
  store: vi.fn(),
  capabilities: vi.fn(),
  read: vi.fn(),
  save: vi.fn(),
  retire: vi.fn(),
}));
vi.mock("@/lib/weletic/shopify/staff-authorization", async (original) => ({
  ...(await original<
    typeof import("@/lib/weletic/shopify/staff-authorization")
  >()),
  authorizeShopifyMerchantInTransaction: mocks.authorize,
}));
vi.mock("@/lib/weletic/shopify/store-compliance-state", () => ({
  assertShopifyStoreAcceptsOperationalWrites: mocks.fence,
}));
vi.mock("@/lib/weletic/shopify/settings-capabilities", () => ({
  readSettingsCapabilities: mocks.capabilities,
}));
vi.mock("@/lib/weletic/loyalty/earning-rule-service", () => ({
  readEarningRulesInTransaction: mocks.read,
  saveEarningRulesInTransaction: mocks.save,
  retireEarningRulesInTransaction: mocks.retire,
}));
const tx = {
  weleticShopifyStore: { findUnique: mocks.store },
} as unknown as Prisma.TransactionClient;
const actor = {
  storeId: "store-a",
  projectId: "workspace-a",
  installationGeneration: "g1",
  owner: false,
};
const envelope = { fixture: "signature verified by future HTTP route" };
const fields = {
  name: "Signup",
  description: null,
  triggerCode: "account_created",
  priority: 0,
  multiplier: "1",
  fixedPoints: "9007199254740993",
  maxPointsPerEvent: null,
  minOrderSubtotal: null,
  excludeDiscountedItems: false,
  excludeTaxesAndShipping: true,
  maxEventsPerCustomer: 1,
  limitInterval: "lifetime",
  conditions: null,
  isActive: false,
};
const row = {
  ...fields,
  id: "rule-a",
  programId: "program-a",
  ruleType: "fixed_points",
  multiplier: new Prisma.Decimal("1"),
  fixedPoints: BigInt(fields.fixedPoints),
  startAt: null,
  endAt: null,
  eligibleTierIds: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
};
const revision = "a".repeat(64);
const state = { programId: "program-a", revision, rules: [row] };
const request = {
  operation: "save",
  input: {
    expectedInstallationGeneration: "g1",
    expectedRevision: revision,
    ruleId: "rule-a",
    rule: fields,
  },
};
const call = (request: unknown) => manage({ tx, envelope, request });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.authorize.mockResolvedValue(actor);
  mocks.store.mockResolvedValue({ projectId: "workspace-a" });
  mocks.capabilities.mockResolvedValue({ loyalty: true });
  mocks.read.mockResolvedValue(state);
  mocks.save.mockResolvedValue(state);
  mocks.retire.mockResolvedValue({ ...state, rules: [] });
});
describe("Shopify earning rules gateway (mocked authority/persistence)", () => {
  it("uses read authority and returns exact minimal fields without a write fence", async () => {
    const result = await call({ operation: "read" });
    expect(mocks.authorize).toHaveBeenCalledWith({
      tx,
      envelope,
      permission: "loyalty.read",
    });
    expect(result.rules[0].fields?.fixedPoints).toBe(fields.fixedPoints);
    expect(result.rules[0]).not.toHaveProperty("programId");
    expect(result.rules[0]).not.toHaveProperty("createdAt");
    expect(mocks.fence).not.toHaveBeenCalled();
  });
  it("fences before saving and uses trusted actor identity on the same transaction", async () => {
    await call(request);
    expect(mocks.authorize).toHaveBeenCalledWith({
      tx,
      envelope,
      permission: "loyalty.configure",
    });
    expect(mocks.fence).toHaveBeenCalledWith({
      tx,
      storeId: "store-a",
      action: "loyalty_earning_rule_write",
      expectedInstallationGeneration: "g1",
    });
    expect(mocks.fence.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.save.mock.invocationCallOrder[0],
    );
    expect(mocks.save).toHaveBeenCalledWith({
      tx,
      storeId: "store-a",
      installationGeneration: "g1",
      input: request.input,
    });
  });
  it("retires with configure authority through the fenced transaction", async () => {
    const input = {
      expectedInstallationGeneration: "g1",
      expectedRevision: revision,
      ruleId: "rule-a",
    };
    expect((await call({ operation: "retire", input })).rules).toEqual([]);
    expect(mocks.retire).toHaveBeenCalledWith({
      tx,
      storeId: "store-a",
      installationGeneration: "g1",
      input,
    });
    expect(mocks.fence).toHaveBeenCalledTimes(1);
  });
  it("rejects stale generation before the fence", async () => {
    await expect(
      call({
        ...request,
        input: { ...request.input, expectedInstallationGeneration: "old" },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(mocks.fence).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("stops on denied authority", async () => {
    mocks.authorize.mockRejectedValue(new Error("denied"));
    await expect(call(request)).rejects.toThrow("denied");
    expect(mocks.store).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("rejects changed workspace binding after the fence", async () => {
    mocks.store.mockResolvedValue({ projectId: "workspace-b" });
    await expect(call(request)).rejects.toThrow();
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("does not retry or write when the fence fails", async () => {
    mocks.fence.mockRejectedValue(new Error("uninstalled"));
    await expect(call(request)).rejects.toThrow("uninstalled");
    expect(mocks.fence).toHaveBeenCalledTimes(1);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("keeps unsupported legacy rules visible without leaking their raw conditions", async () => {
    mocks.read.mockResolvedValue({
      ...state,
      rules: [{ ...row, conditions: { unknownPrivateField: "not-public" } }],
    });
    const result = await call({ operation: "read" });
    expect(result.rules[0].fields).toBeNull();
    expect(result.rules[0].editUnavailableReason).toBe(
      "legacy_configuration_requires_review",
    );
    expect(JSON.stringify(result)).not.toContain("not-public");
  });
  it("reports constraints without offering to overwrite them", async () => {
    mocks.read.mockResolvedValue({
      ...state,
      rules: [
        {
          ...row,
          startAt: new Date("2026-10-01"),
          eligibleTierIds: ["tier-a"],
        },
      ],
    });
    expect((await call({ operation: "read" })).rules[0].constraints).toEqual({
      startAt: "2026-10-01T00:00:00.000Z",
      endAt: null,
      hasTierEligibility: true,
    });
  });
});
