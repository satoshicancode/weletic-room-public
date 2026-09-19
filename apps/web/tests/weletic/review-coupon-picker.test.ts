import { listShopifyMerchantReviewCouponsInTransaction as list } from "@/lib/weletic/shopify/merchant-review-coupons";
import type { Prisma } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), find: vi.fn() }));
vi.mock("@/lib/weletic/shopify/staff-authorization", () => ({
  authorizeShopifyMerchantInTransaction: mocks.auth,
}));
const tx = {
  weleticRewardDefinition: { findMany: mocks.find },
} as unknown as Prisma.TransactionClient;
const actor = { storeId: "store", appId: "app", installationGeneration: "g1" };
const run = (input: unknown = {}) => list({ tx, envelope: {}, input });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue(actor);
  mocks.find.mockResolvedValue([{ id: "reward", name: "Coupon" }]);
});
it("uses reviews.configure and a bounded store-owned minimal projection", async () => {
  expect(await run()).toEqual({
    items: [{ id: "reward", name: "Coupon" }],
    nextCursor: null,
  });
  expect(mocks.auth).toHaveBeenCalledWith({
    tx,
    envelope: {},
    permission: "reviews.configure",
  });
  expect(mocks.find).toHaveBeenCalledWith({
    where: {
      storeId: "store",
      status: "active",
      salesChannel: "online_store",
      exchangeType: "fixed",
      rewardType: { in: ["amount_off", "percentage_off", "free_shipping"] },
      maxDiscountValue: null,
    },
    select: { id: true, name: true },
    orderBy: { id: "asc" },
    take: 51,
  });
});
it("paginates at exactly 50 without disclosing the lookahead item", async () => {
  mocks.find.mockResolvedValue(
    Array.from({ length: 51 }, (_, n) => ({
      id: `reward-${String(n).padStart(2, "0")}`,
      name: "Coupon",
    })),
  );
  const page = await run({ query: " gift " });
  expect(page.items).toHaveLength(50);
  expect(page.nextCursor).not.toBeNull();
  mocks.find.mockResolvedValue([]);
  await run({ query: "gift", cursor: page.nextCursor });
  expect(mocks.find).toHaveBeenLastCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        id: { gt: "reward-49" },
        name: { contains: "gift" },
      }),
    }),
  );
});
it.each(["store", "app", "generation", "query"])(
  "rejects a cursor reused with changed %s",
  async (changed) => {
    mocks.find.mockResolvedValue(
      Array.from({ length: 51 }, (_, n) => ({
        id: `reward-${n}`,
        name: "Coupon",
      })),
    );
    const page = await run();
    mocks.find.mockClear();
    mocks.auth.mockResolvedValue({
      ...actor,
      ...(changed === "store"
        ? { storeId: "foreign" }
        : changed === "app"
          ? { appId: "other" }
          : changed === "generation"
            ? { installationGeneration: "g2" }
            : {}),
    });
    await expect(
      run({
        cursor: page.nextCursor,
        ...(changed === "query" ? { query: "other" } : {}),
      }),
    ).rejects.toThrow("Invalid coupon cursor");
    expect(mocks.find).not.toHaveBeenCalled();
  },
);
it.each([
  { storeId: "foreign" },
  { query: "x".repeat(101) },
  { cursor: "%%%" },
])("rejects invalid inputs before authorization", async (input) => {
  await expect(run(input)).rejects.toThrow();
  expect(mocks.auth).not.toHaveBeenCalled();
});
it("denies catalog reads without review configuration permission", async () => {
  mocks.auth.mockRejectedValue(new Error("access_denied"));
  await expect(run()).rejects.toThrow("access_denied");
  expect(mocks.find).not.toHaveBeenCalled();
});
