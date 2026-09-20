import { Prisma } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";
import { withReviewMutation } from "../../lib/weletic/reviews/transaction";
const mocks = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock("../../lib/weletic/loyalty/merchant-write-fence", () => ({
  withActiveStoreLoyaltyMutation: mocks.mutate,
}));
vi.mock("../../lib/weletic/loyalty/ledger", () => ({
  OptimisticConcurrencyError: class extends Error {},
}));
const error = (code: string, mysqlCode?: string) =>
  new Prisma.PrismaClientKnownRequestError("synthetic database failure", {
    code,
    clientVersion: "test",
    ...(mysqlCode ? { meta: { code: mysqlCode } } : {}),
  });
beforeEach(() => vi.resetAllMocks());
it.each([
  ["P2034", undefined],
  ["P2010", "1213"],
])(
  "retries a confirmed rolled-back %s/%s transaction with its original generation",
  async (code, mysqlCode) => {
    const failure = error(code!, mysqlCode);
    mocks.mutate
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce("committed");
    const operation = vi.fn();
    expect(await withReviewMutation("store", operation, "generation")).toBe(
      "committed",
    );
    expect(mocks.mutate).toHaveBeenCalledTimes(2);
    for (const call of mocks.mutate.mock.calls)
      expect(call[0]).toEqual({
        storeId: "store",
        action: "native_reviews",
        expectedInstallationGeneration: "generation",
        loyaltyMaintenancePermit: undefined,
        operation,
      });
  },
);
it("stops after the bounded five attempts and returns the original failure", async () => {
  const failure = error("P2010", "1213");
  mocks.mutate.mockRejectedValue(failure);
  await expect(withReviewMutation("store", vi.fn(), "generation")).rejects.toBe(
    failure,
  );
  expect(mocks.mutate).toHaveBeenCalledTimes(5);
});
it.each([
  error("P2010", "1205"),
  error("P2010", "1062"),
  error("P2010"),
  error("P2002"),
  error("P2028"),
  new Error("ambiguous network failure"),
  { code: "P2010", meta: { code: "1213" } },
])("does not retry unrelated or ambiguous errors (%j)", async (failure) => {
  mocks.mutate.mockRejectedValue(failure);
  await expect(withReviewMutation("store", vi.fn(), "generation")).rejects.toBe(
    failure,
  );
  expect(mocks.mutate).toHaveBeenCalledTimes(1);
});
