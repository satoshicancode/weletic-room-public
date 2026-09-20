import { recoverReviewPoints } from "@/lib/weletic/reviews/points-recovery";
import {
  ReviewPointsRecoveryPayloadSchema,
  ReviewPointsRecoveryPendingError,
  ReviewPointsRecoveryReconciliationError,
  reviewPointsRecoveryKey,
} from "@/lib/weletic/reviews/points-recovery-contract";
import { ShopifyStoreOperationalWritesBlockedError } from "@/lib/weletic/shopify/store-compliance-state";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mutation: vi.fn(),
  fulfill: vi.fn(),
  find: vi.fn(),
  committed: false,
}));
vi.mock("@/lib/weletic/reviews/transaction", () => ({
  withReviewMutation: mocks.mutation,
}));
vi.mock("@/lib/weletic/reviews/incentive-points", () => ({
  fulfillReviewPointsClaimInTransaction: mocks.fulfill,
}));
const payload = {
  claimId: "claim",
  shopperId: "shopper",
  installationGeneration: "generation",
};
const tx = { weleticReviewIncentiveClaim: { findFirst: mocks.find } };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.committed = false;
  mocks.find.mockResolvedValue({ id: "claim" });
  mocks.fulfill.mockResolvedValue({
    status: "fulfilled",
    ledgerEntryId: "ledger",
    points: "100",
  });
  mocks.mutation.mockImplementation(async (_store, fn) => {
    const result = await fn(tx, "generation");
    mocks.committed = true;
    return result;
  });
});

describe("delayed review points recovery boundary", () => {
  it.each(["pending_approval", "suspended", "frozen", "currency_unverified"])(
    "defers a temporarily blocked %s store rather than completing the promise",
    async (complianceState) => {
      mocks.mutation.mockRejectedValue(
        new ShopifyStoreOperationalWritesBlockedError({
          action: "recovery",
          storeId: "store",
          complianceState,
        }),
      );
      await expect(
        recoverReviewPoints({ storeId: "store", payload }),
      ).rejects.toBeInstanceOf(ReviewPointsRecoveryPendingError);
      expect(mocks.fulfill).not.toHaveBeenCalled();
    },
  );
  it.each(["stale_installation_generation", "redacted", "unavailable"])(
    "contains %s for explicit reconciliation instead of completing or rebinding",
    async (complianceState) => {
      mocks.mutation.mockRejectedValue(
        new ShopifyStoreOperationalWritesBlockedError({
          action: "recovery",
          storeId: "store",
          complianceState,
        }),
      );
      await expect(
        recoverReviewPoints({ storeId: "store", payload }),
      ).rejects.toBeInstanceOf(ReviewPointsRecoveryReconciliationError);
      expect(mocks.fulfill).not.toHaveBeenCalled();
    },
  );
  it.each(["fulfilled", "already_fulfilled"])(
    "reuses the original writer for %s without accepting financial terms",
    async (status) => {
      mocks.fulfill.mockResolvedValue({ status, ledgerEntryId: "ledger" });
      expect(await recoverReviewPoints({ storeId: "store", payload })).toEqual({
        status,
        ledgerEntryId: "ledger",
      });
      expect(mocks.mutation).toHaveBeenCalledWith(
        "store",
        expect.any(Function),
        "generation",
        undefined,
      );
      expect(mocks.find).toHaveBeenCalledWith({
        where: { id: "claim", storeId: "store", shopperId: "shopper" },
        select: { id: true },
      });
      expect(mocks.fulfill).toHaveBeenCalledExactlyOnceWith({
        tx,
        storeId: "store",
        claimId: "claim",
        generation: "generation",
      });
    },
  );
  it("commits the writer's waiting reason before requesting queue deferral", async () => {
    mocks.fulfill.mockResolvedValue({ status: "pending" });
    await expect(
      recoverReviewPoints({ storeId: "store", payload }),
    ).rejects.toBeInstanceOf(ReviewPointsRecoveryPendingError);
    expect(mocks.committed).toBe(true);
  });
  it("rejects missing or cross-store/shopper claims before the writer", async () => {
    mocks.find.mockResolvedValue(null);
    await expect(
      recoverReviewPoints({ storeId: "store", payload }),
    ).rejects.toThrow("Owned review incentive claim is unavailable");
    expect(mocks.fulfill).not.toHaveBeenCalled();
  });
  it("does not adopt a replacement installation", async () => {
    mocks.mutation.mockImplementation((_store, fn) => fn(tx, "replacement"));
    await expect(
      recoverReviewPoints({ storeId: "store", payload }),
    ).rejects.toThrow("installation changed");
    expect(mocks.find).not.toHaveBeenCalled();
    expect(mocks.fulfill).not.toHaveBeenCalled();
  });
  it("preserves writer failures instead of turning invalidity into eligibility waiting", async () => {
    const error = new Error("immutable evidence conflict");
    mocks.fulfill.mockRejectedValue(error);
    await expect(
      recoverReviewPoints({ storeId: "store", payload }),
    ).rejects.toBe(error);
    expect(mocks.committed).toBe(false);
  });
  it.each([
    { ...payload, installationGeneration: null },
    { ...payload, installationGeneration: "" },
    { ...payload, installationGeneration: "x".repeat(65) },
    { claimId: "claim", shopperId: "shopper" },
    { ...payload, claimId: "" },
    { ...payload, shopperId: "" },
    { ...payload, points: "9999" },
    { ...payload, enroll: true },
    { ...payload, policyId: "replacement" },
  ])("rejects malformed or authority-expanding payload %#", async (input) => {
    expect(ReviewPointsRecoveryPayloadSchema.safeParse(input).success).toBe(
      false,
    );
    await expect(
      recoverReviewPoints({ storeId: "store", payload: input }),
    ).rejects.toThrow();
    expect(mocks.mutation).not.toHaveBeenCalled();
  });
  it("keeps one recovery identity per immutable claim", () => {
    expect(reviewPointsRecoveryKey("claim")).toBe(
      "review_points_recovery:claim",
    );
  });
});
