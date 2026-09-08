import { Prisma, type WeleticRewardDefinition } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectRewardCatalogEntry } from "../../lib/weletic/loyalty/reward-catalog-projection";
import {
  readRewardCatalogInTransaction,
  saveRewardCatalogInTransaction,
} from "../../lib/weletic/loyalty/reward-catalog-service";

const mocks = vi.hoisted(() => ({
  store: vi.fn(),
  find: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  contain: vi.fn(),
}));
vi.mock("../../lib/weletic/loyalty/rewards", () => ({
  createRewardDefinition: mocks.create,
  updateRewardDefinition: mocks.update,
  containRewardDefinition: mocks.contain,
  RewardDefinitionConflictError: class extends Error {},
}));
const tx = {
  weleticShopifyStore: { findUnique: mocks.store },
  weleticRewardDefinition: { findMany: mocks.find },
} as unknown as Prisma.TransactionClient;
const row: WeleticRewardDefinition = {
  id: "reward-a",
  storeId: "store-a",
  name: "Discount",
  description: null,
  rewardType: "amount_off",
  salesChannel: "online_store",
  exchangeType: "fixed",
  pointsCost: BigInt("9007199254740993"),
  pointsStep: null,
  minPointsCost: null,
  maxPointsCost: null,
  discountValue: new Prisma.Decimal("1"),
  maxDiscountValue: null,
  minOrderAmount: null,
  status: "inactive",
  shopifyPriceRuleId: null,
  appliesToResource: "entire_order",
  entitledProductIds: null,
  entitledVariantIds: null,
  entitledCollectionIds: null,
  combinesWithOrderDiscounts: false,
  combinesWithProductDiscounts: false,
  combinesWithShippingDiscounts: false,
  usageLimit: 1,
  usageLimitPerCustomer: 1,
  expiresInDays: null,
  createdAt: new Date("2026-09-08"),
  updatedAt: new Date("2026-09-08"),
};
const fields = projectRewardCatalogEntry(row).fields!;
const context = {
  tx,
  storeId: row.storeId,
  installationGeneration: "generation",
};
async function input() {
  return {
    expectedRevision: (await readRewardCatalogInTransaction(tx, row.storeId))
      .revision,
    expectedInstallationGeneration: "generation",
    rewardId: row.id,
    reward: fields,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.store.mockResolvedValue({ shopCurrency: "JPY" });
  mocks.find.mockResolvedValue([row]);
  mocks.create.mockResolvedValue({ ...row, id: "new-reward" });
  mocks.update.mockResolvedValue(row);
});

describe("reward catalog projection", () => {
  it("keeps exact money and points, omitting private identity", () => {
    const projected = projectRewardCatalogEntry(row);
    expect(projected.fields?.pointsCost).toBe("9007199254740993");
    expect(projected.fields?.discountValue).toBe("1");
    expect(projected.fields?.entitledProductIds).toEqual([]);
    expect(projected).not.toHaveProperty("storeId");
    expect(projected).not.toHaveProperty("shopifyPriceRuleId");
  });
  it("canonicalizes equivalent numeric resource IDs without mutating stored JSON", () => {
    const scoped = {
      ...row,
      appliesToResource: "specific_items",
      entitledProductIds: ["123"],
    };
    expect(
      projectRewardCatalogEntry(scoped).fields?.entitledProductIds,
    ).toEqual(["gid://shopify/Product/123"]);
    expect(scoped.entitledProductIds).toEqual(["123"]);
  });
  it.each([
    { salesChannel: "pos" as const },
    { shopifyPriceRuleId: "legacy-private-id" },
    { pointsCost: BigInt(0) },
    { appliesToResource: "unknown" },
    { entitledProductIds: { invalid: true } },
    { entitledProductIds: ["123"] },
  ])("leaves unsupported legacy configuration read-only (case %#)", (patch) => {
    expect(projectRewardCatalogEntry({ ...row, ...patch })).toMatchObject({
      fields: null,
      editUnavailableReason: "legacy_configuration_requires_review",
    });
  });
});

describe("transaction-local reward catalog service (mocked persistence)", () => {
  it("blocks economic writes with missing currency and invalidates currency changes", async () => {
    const before = await readRewardCatalogInTransaction(tx, row.storeId);
    mocks.store.mockResolvedValue({ shopCurrency: "USD" });
    expect(
      (await readRewardCatalogInTransaction(tx, row.storeId)).revision,
    ).not.toBe(before.revision);
    mocks.store.mockResolvedValue({ shopCurrency: null });
    const missing = await readRewardCatalogInTransaction(tx, row.storeId);
    expect(missing.shopCurrency).toBeNull();
    await expect(
      saveRewardCatalogInTransaction({
        ...context,
        input: { ...(await input()), expectedRevision: missing.revision },
      }),
    ).rejects.toThrow();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("does not initialize anything on empty reads", async () => {
    mocks.find.mockResolvedValue([]);
    expect(await readRewardCatalogInTransaction(tx, row.storeId)).toMatchObject(
      { rewards: [], revision: expect.stringMatching(/^[a-f0-9]{64}$/) },
    );
    expect(mocks.find).toHaveBeenCalledWith({
      where: { storeId: row.storeId },
      orderBy: { id: "asc" },
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("binds even an empty catalog revision to its store", async () => {
    mocks.find.mockResolvedValue([]);
    const first = await readRewardCatalogInTransaction(tx, "store-a");
    const second = await readRewardCatalogInTransaction(tx, "store-b");
    expect(first.revision).not.toBe(second.revision);
  });
  it.each([
    { name: "Changed" },
    { shopifyPriceRuleId: "changed" },
    { pointsCost: BigInt(1) },
    { updatedAt: new Date("2026-09-09") },
  ])("fingerprints hidden and visible changes (case %#)", async (patch) => {
    const before = await readRewardCatalogInTransaction(tx, row.storeId);
    mocks.find.mockResolvedValue([{ ...row, ...patch }]);
    expect(
      (await readRewardCatalogInTransaction(tx, row.storeId)).revision,
    ).not.toBe(before.revision);
  });
  it("rejects installation changes before persistence access", async () => {
    const data = await input();
    mocks.find.mockClear();
    mocks.store.mockClear();
    await expect(
      saveRewardCatalogInTransaction({
        ...context,
        input: { ...data, expectedInstallationGeneration: "old" },
      }),
    ).rejects.toThrow();
    expect(mocks.find).not.toHaveBeenCalled();
    expect(mocks.store).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("rejects stale snapshots, cross-store IDs, and legacy edits without writing", async () => {
    const data = await input();
    await expect(
      saveRewardCatalogInTransaction({
        ...context,
        input: { ...data, expectedRevision: "f".repeat(64) },
      }),
    ).rejects.toThrow();
    await expect(
      saveRewardCatalogInTransaction({
        ...context,
        input: { ...data, rewardId: "other-store-reward" },
      }),
    ).rejects.toThrow();
    mocks.find.mockResolvedValue([{ ...row, shopifyPriceRuleId: "legacy" }]);
    await expect(
      saveRewardCatalogInTransaction({
        ...context,
        input: {
          ...data,
          expectedRevision: (
            await readRewardCatalogInTransaction(tx, row.storeId)
          ).revision,
        },
      }),
    ).rejects.toThrow();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("uses the existing writer with the caller's transaction and exact BigInts", async () => {
    const result = await saveRewardCatalogInTransaction({
      ...context,
      input: await input(),
    });
    expect(result.affectedRewardId).toBe(row.id);
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
      tx,
      storeId: row.storeId,
      id: row.id,
      data: { ...fields, pointsCost: row.pointsCost },
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("preserves inactive creation before returning and propagates failure without retry", async () => {
    const data = { ...(await input()), rewardId: null };
    const result = await saveRewardCatalogInTransaction({
      ...context,
      input: data,
    });
    expect(result.affectedRewardId).toBe("new-reward");
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith({
      tx,
      storeId: row.storeId,
      ...fields,
      pointsCost: row.pointsCost,
    });
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
      tx,
      storeId: row.storeId,
      id: "new-reward",
      data: { status: "inactive" },
    });
    mocks.create.mockClear();
    mocks.update.mockRejectedValueOnce(new Error("rollback"));
    await expect(
      saveRewardCatalogInTransaction({ ...context, input: data }),
    ).rejects.toThrow("rollback");
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
});
