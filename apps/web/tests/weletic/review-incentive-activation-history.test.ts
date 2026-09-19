import { reviewPolicyAtOrderTime } from "@/lib/weletic/reviews/incentive-activation-history";
import { reviewIncentivePolicyDigest } from "@/lib/weletic/reviews/incentive-policy";
import type { Prisma } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";
vi.mock("@/lib/weletic/reviews/transaction", () => ({
  withReviewMutation: vi.fn(),
}));
const history = vi.fn();
const policy = vi.fn();
const tx = {
  weleticReviewIncentiveActivation: { findFirst: history },
  weleticReviewIncentivePolicy: { findUnique: policy },
} as unknown as Prisma.TransactionClient;
const snapshot = { version: 1, award: { kind: "none" } };
const digest = reviewIncentivePolicyDigest(snapshot);
const now = new Date("2026-09-20T00:00:00Z");
beforeEach(() => {
  vi.resetAllMocks();
  policy.mockImplementation(async ({ where }) => ({
    id: where.storeId_id.id,
    storeId: "store",
    snapshot,
    contentDigest: digest,
  }));
});
it("preserves pre-history installations without writing defaults", async () => {
  history.mockResolvedValue(null);
  expect(await reviewPolicyAtOrderTime(tx, "store", now, "old")).toBe("old");
});
it("resolves delayed events by order time, not current policy", async () => {
  history
    .mockResolvedValueOnce({ storeId: "store", policyId: "new" })
    .mockResolvedValueOnce({
      storeId: "store",
      policyId: "old",
      contentDigest: digest,
    });
  expect(await reviewPolicyAtOrderTime(tx, "store", now, "new")).toBe("old");
  expect(history).toHaveBeenNthCalledWith(2, {
    where: { storeId: "store", effectiveAt: { lte: now } },
    orderBy: [{ effectiveAt: "desc" }, { policyRevision: "desc" }],
  });
});
it.each([null, "previous"])(
  "preserves the pre-cutover promise %s",
  async (previousPolicyId) => {
    history
      .mockResolvedValueOnce({ storeId: "store", policyId: "new" })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ storeId: "store", previousPolicyId });
    expect(await reviewPolicyAtOrderTime(tx, "store", now, "new")).toBe(
      previousPolicyId,
    );
  },
);
it.each([
  { storeId: "foreign", policyId: "new" },
  { storeId: "store", policyId: "different" },
])("rejects inconsistent active history", async (row) => {
  history.mockResolvedValueOnce(row);
  await expect(
    reviewPolicyAtOrderTime(tx, "store", now, "new"),
  ).rejects.toThrow("requires reconciliation");
});
it("rejects a damaged activation digest", async () => {
  history
    .mockResolvedValueOnce({ storeId: "store", policyId: "new" })
    .mockResolvedValueOnce({
      storeId: "store",
      policyId: "old",
      contentDigest: "0".repeat(64),
    });
  await expect(
    reviewPolicyAtOrderTime(tx, "store", now, "new"),
  ).rejects.toThrow("requires reconciliation");
});
