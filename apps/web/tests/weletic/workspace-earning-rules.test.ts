import type { WorkspaceConfigurationAuthority } from "@/lib/weletic/loyalty/workspace-configuration";
import {
  manageWorkspaceEarningRulesInTransaction as manage,
  manageWorkspaceEarningRules,
} from "@/lib/weletic/loyalty/workspace-earning-rules";
import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  store: vi.fn(),
  fence: vi.fn(),
  read: vi.fn(),
  save: vi.fn(),
  retire: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: mocks.transaction },
}));
vi.mock("@/lib/weletic/shopify/store-compliance-state", () => ({
  assertShopifyStoreAcceptsOperationalWrites: mocks.fence,
}));
vi.mock("@/lib/weletic/loyalty/earning-rule-service", () => ({
  readEarningRulesInTransaction: mocks.read,
  saveEarningRulesInTransaction: mocks.save,
  retireEarningRulesInTransaction: mocks.retire,
}));
const tx = {
  weleticShopifyStore: { findFirst: mocks.store },
} as unknown as Prisma.TransactionClient;
const authority: WorkspaceConfigurationAuthority = {
  workspaceId: "workspace-a",
  role: "member",
  permissions: ["loyalty.read", "loyalty.write"],
};
const store = {
  id: "store-a",
  projectId: "workspace-a",
  installationGeneration: "g1",
};
const state = { programId: "program-a", revision: "a".repeat(64), rules: [] };
const retire = {
  operation: "retire",
  input: {
    expectedInstallationGeneration: "g1",
    expectedRevision: state.revision,
    ruleId: "rule-a",
  },
};
const read = { operation: "read" };
const save = {
  operation: "save",
  input: {
    ...retire.input,
    rule: {
      name: "Purchase",
      description: null,
      triggerCode: "order_paid",
      priority: 0,
      multiplier: "1.2500",
      fixedPoints: null,
      maxPointsPerEvent: null,
      minOrderSubtotal: null,
      excludeDiscountedItems: false,
      excludeTaxesAndShipping: true,
      maxEventsPerCustomer: null,
      limitInterval: null,
      conditions: null,
      isActive: false,
    },
  },
};
const call = (request: unknown, access = authority) =>
  manage({ tx, authority: access, request });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.store.mockResolvedValue(store);
  mocks.read.mockResolvedValue(state);
  mocks.save.mockResolvedValue({ ...state, affectedRuleId: "rule-a" });
  mocks.retire.mockResolvedValue({ ...state, affectedRuleId: "rule-a" });
  mocks.transaction.mockImplementation(async (callback) => callback(tx));
});
describe("workspace earning-rule adapter (mocked authority/persistence)", () => {
  it("reads the active authorized workspace without a fence or write", async () => {
    expect(await call(read)).toMatchObject({
      storeId: "store-a",
      capabilities: { configure: true },
    });
    expect(mocks.store).toHaveBeenCalledWith({
      where: {
        projectId: "workspace-a",
        complianceState: "active",
        installationGeneration: { not: null },
      },
      select: {
        id: true,
        projectId: true,
        installationGeneration: true,
        shopCurrency: true,
      },
    });
    expect(mocks.fence).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it.each([save, retire])(
    "does not promote a read-scoped owner to mutation authority",
    async (request) => {
      await expect(
        call(request, {
          ...authority,
          role: "owner",
          permissions: ["loyalty.read"],
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect(mocks.store).not.toHaveBeenCalled();
      expect(mocks.fence).not.toHaveBeenCalled();
    },
  );
  it("does not infer read authority from a write-only token", async () => {
    await expect(
      call(read, { ...authority, permissions: ["loyalty.write"] }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(mocks.store).not.toHaveBeenCalled();
  });
  it.each([save, retire])(
    "uses the same transaction and checks binding after the fence",
    async (request) => {
      await call(request);
      expect(mocks.fence).toHaveBeenCalledWith({
        tx,
        storeId: "store-a",
        action: "loyalty_earning_rule_write",
        expectedInstallationGeneration: "g1",
      });
      expect(mocks.store).toHaveBeenCalledTimes(2);
      const writer = request.operation === "save" ? mocks.save : mocks.retire;
      expect(writer).toHaveBeenCalledExactlyOnceWith({
        tx,
        storeId: "store-a",
        installationGeneration: "g1",
        input: request.input,
      });
      expect(mocks.store.mock.invocationCallOrder[1]).toBeLessThan(
        writer.mock.invocationCallOrder[0],
      );
    },
  );
  it.each([
    null,
    { ...store, id: "store-b" },
    { ...store, projectId: "workspace-b" },
    { ...store, installationGeneration: "g2" },
  ])("rejects post-fence binding changes", async (changed) => {
    mocks.store.mockResolvedValueOnce(store).mockResolvedValueOnce(changed);
    await expect(call(save)).rejects.toMatchObject({ code: "conflict" });
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("rejects stale generation before fencing", async () => {
    await expect(
      call({
        ...save,
        input: { ...save.input, expectedInstallationGeneration: "old" },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(mocks.fence).not.toHaveBeenCalled();
  });
  it("fails closed when no active installation exists", async () => {
    mocks.store.mockResolvedValue(null);
    await expect(call(read)).rejects.toMatchObject({ code: "not_found" });
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("does not retry a failed fence", async () => {
    mocks.fence.mockRejectedValue(new Error("maintenance"));
    await expect(call(save)).rejects.toThrow("maintenance");
    expect(mocks.fence).toHaveBeenCalledTimes(1);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("wraps malformed stored projections as internal errors", async () => {
    mocks.read.mockResolvedValue({ ...state, revision: "invalid" });
    await expect(call(read)).rejects.toThrow("Earning rules are unavailable");
  });
  it("opens one Serializable transaction at the workspace boundary", async () => {
    await manageWorkspaceEarningRules(authority, read);
    expect(mocks.transaction).toHaveBeenCalledExactlyOnceWith(
      expect.any(Function),
      { isolationLevel: "Serializable" },
    );
  });
});
