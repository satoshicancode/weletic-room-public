import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  readEarningRulesInTransaction,
  retireEarningRulesInTransaction,
  saveEarningRulesInTransaction,
} from "../../lib/weletic/loyalty/earning-rule-service";

const mocks = vi.hoisted(() => ({
  find: vi.fn(),
  write: vi.fn(),
  retire: vi.fn(),
}));
vi.mock("../../lib/weletic/loyalty/earning-rule-writer", () => ({
  writeEarningRuleInTransaction: mocks.write,
  retireEarningRuleInTransaction: mocks.retire,
  EarningRuleWriteError: class extends Error {
    constructor({ message }: { message: string }) {
      super(message);
    }
  },
}));
const tx = {
  weleticLoyaltyProgram: { findUnique: mocks.find },
} as unknown as Prisma.TransactionClient;
const row = {
  id: "program-a",
  status: "draft",
  killSwitchActive: false,
  updatedAt: new Date("2026-09-07"),
  earnPolicyVersion: 1,
  earningRules: [
    {
      id: "rule-a",
      fixedPoints: BigInt("9007199254740993"),
      eligibleTierIds: ["tier-a"],
      startAt: null,
    },
  ],
};
const rule = {
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
  purchaseType: "one_time",
  subscriptionCadence: "first_payment",
  subscriptionPaymentLimit: null,
  maxEventsPerCustomer: 1,
  limitInterval: "lifetime",
  conditions: null,
  isActive: false,
};
const context = {
  tx,
  storeId: "store-a",
  installationGeneration: "generation-a",
};
const writeInput = {
  expectedInstallationGeneration: "generation-a",
  expectedRevision: null,
  ruleId: null,
  rule,
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.find.mockResolvedValue(row);
});

describe("earning-rule transactional orchestration (mocked persistence)", () => {
  it("ignores JSON object key order without discarding condition changes", async () => {
    const withConditions = (conditions: Record<string, unknown>) => ({
      ...row,
      earningRules: [{ ...row.earningRules[0], conditions }],
    });
    mocks.find.mockResolvedValue(
      withConditions({ provider: "native", photoBonusPoints: 10 }),
    );
    const first = await readEarningRulesInTransaction(tx, "store-a");
    mocks.find.mockResolvedValue(
      withConditions({ photoBonusPoints: 10, provider: "native" }),
    );
    expect((await readEarningRulesInTransaction(tx, "store-a")).revision).toBe(
      first.revision,
    );
    mocks.find.mockResolvedValue(
      withConditions({ photoBonusPoints: 11, provider: "native" }),
    );
    expect(
      (await readEarningRulesInTransaction(tx, "store-a")).revision,
    ).not.toBe(first.revision);
  });
  it("reads store-scoped state without initializing a program", async () => {
    mocks.find.mockResolvedValue(null);
    expect(await readEarningRulesInTransaction(tx, "store-a")).toEqual({
      programId: null,
      revision: null,
      rules: [],
    });
    expect(mocks.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { storeId: "store-a" } }),
    );
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it.each([
    { earnPolicyVersion: 2 },
    { status: "disabled" },
    { killSwitchActive: true },
    { earningRules: [{ ...row.earningRules[0], eligibleTierIds: ["tier-b"] }] },
    {
      earningRules: [
        { ...row.earningRules[0], startAt: new Date("2026-09-08") },
      ],
    },
    {
      earningRules: [
        {
          ...row.earningRules[0],
          purchasePolicy: {
            purchaseType: "both",
            subscriptionCadence: "every_payment",
            subscriptionPaymentLimit: null,
          },
        },
      ],
    },
    { earningRules: [] },
  ])("invalidates state when policy or hidden fields change", async (patch) => {
    const first = await readEarningRulesInTransaction(tx, "store-a");
    mocks.find.mockResolvedValue({ ...row, ...patch });
    const second = await readEarningRulesInTransaction(tx, "store-a");
    expect(second.revision).not.toBe(first.revision);
  });
  it("rejects a stale generation before reading or writing", async () => {
    await expect(
      saveEarningRulesInTransaction({
        ...context,
        input: { ...writeInput, expectedInstallationGeneration: "old" },
      }),
    ).rejects.toThrow("Installation changed");
    expect(mocks.find).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("rejects a stale revision before any writer call", async () => {
    await expect(
      saveEarningRulesInTransaction({ ...context, input: writeInput }),
    ).rejects.toThrow("Earning rules changed");
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("uses the same transaction and exact values, then rereads saved state", async () => {
    const initial = await readEarningRulesInTransaction(tx, "store-a");
    mocks.write.mockImplementation(async () => {
      mocks.find.mockResolvedValue({ ...row, earnPolicyVersion: 2 });
      return { id: "rule-a" };
    });
    const saved = await saveEarningRulesInTransaction({
      ...context,
      input: {
        ...writeInput,
        expectedRevision: initial.revision,
        ruleId: "rule-a",
      },
    });
    expect(mocks.write).toHaveBeenCalledExactlyOnceWith({
      tx,
      storeId: "store-a",
      ruleId: "rule-a",
      ruleData: expect.objectContaining({
        fixedPoints: BigInt("9007199254740993"),
      }),
    });
    expect(saved.revision).not.toBe(initial.revision);
  });
  it("accepts null revision only for an absent program", async () => {
    mocks.find.mockResolvedValue(null);
    mocks.write.mockImplementation(async () => {
      mocks.find.mockResolvedValue(row);
      return { id: "rule-a" };
    });
    expect(
      (await saveEarningRulesInTransaction({ ...context, input: writeInput }))
        .programId,
    ).toBe("program-a");
  });
  it("retires through the same transaction and refuses stale retirement", async () => {
    const initial = await readEarningRulesInTransaction(tx, "store-a");
    const input = {
      expectedInstallationGeneration: "generation-a",
      expectedRevision: initial.revision,
      ruleId: "rule-a",
    };
    mocks.retire.mockImplementation(async () => {
      mocks.find.mockResolvedValue({ ...row, earningRules: [] });
    });
    expect(
      (await retireEarningRulesInTransaction({ ...context, input })).rules,
    ).toEqual([]);
    expect(mocks.retire).toHaveBeenCalledExactlyOnceWith({
      tx,
      storeId: "store-a",
      ruleId: "rule-a",
    });
    await expect(
      retireEarningRulesInTransaction({ ...context, input }),
    ).rejects.toThrow("Earning rules changed");
    expect(mocks.retire).toHaveBeenCalledTimes(1);
  });
  it("does not retry a failed writer or return an acknowledgement", async () => {
    const initial = await readEarningRulesInTransaction(tx, "store-a");
    mocks.write.mockRejectedValue(new Error("transaction failure"));
    await expect(
      saveEarningRulesInTransaction({
        ...context,
        input: { ...writeInput, expectedRevision: initial.revision },
      }),
    ).rejects.toThrow("transaction failure");
    expect(mocks.write).toHaveBeenCalledTimes(1);
  });
});
