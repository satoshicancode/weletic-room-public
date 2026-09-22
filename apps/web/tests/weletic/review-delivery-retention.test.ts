import { clearExpiredReviewDeliveryEvidence } from "@/lib/weletic/reviews/delivery-retention";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  find: vi.fn(),
  lock: vi.fn(),
  transaction: vi.fn(),
  tx: {
    $queryRaw: vi.fn(),
    weleticReviewRequest: { findFirst: vi.fn(), updateMany: vi.fn() },
    weleticReviewReminder: { updateMany: vi.fn() },
    weleticLoyaltyOutboxJob: { updateMany: vi.fn() },
  },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticReviewRequest: { findMany: mocks.find },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/weletic/shopify/customer-settlement-lock", () => ({
  withShopifyCustomerSettlementLocks: mocks.lock,
}));
const now = new Date("2026-09-20T00:00:00Z");
const candidate = {
  id: "invitation",
  storeId: "store",
  installationGeneration: "retired-generation",
  store: { projectId: "workspace" },
  shopper: { shopifyCustomerId: "123" },
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.find.mockResolvedValue([candidate]);
  mocks.transaction.mockImplementation((fn) => fn(mocks.tx));
  mocks.lock.mockImplementation(({ fn }) => fn());
  mocks.tx.weleticReviewRequest.findFirst.mockResolvedValue({
    status: "failed",
    deliveryAttempts: 2,
  });
  mocks.tx.weleticReviewRequest.updateMany.mockResolvedValue({ count: 1 });
});

describe("bounded review delivery erasure", () => {
  it("uses customer/store ownership locks and preserves attempt evidence while erasing expired data", async () => {
    expect(
      await clearExpiredReviewDeliveryEvidence({ batchSize: 3, now }),
    ).toEqual({ scanned: 1, cleared: 1, deferred: 0 });
    expect(mocks.find).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 3,
        orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
      }),
    );
    expect(mocks.lock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace",
        storeId: "store",
        shopifyCustomerId: "123",
      }),
    );
    const { where, data } =
      mocks.tx.weleticReviewRequest.updateMany.mock.calls[0][0];
    expect(where).toMatchObject({
      id: "invitation",
      storeId: "store",
      installationGeneration: "retired-generation",
      expiresAt: { lte: now },
    });
    expect(where.AND).toContainEqual({
      OR: [
        { deliveryLeaseExpiresAt: null },
        { deliveryLeaseExpiresAt: { lte: now } },
      ],
    });
    expect(data).toMatchObject({
      status: "expired",
      lastError: "email_delivery_expired_unreconciled",
      encryptedDeliverySnapshot: null,
      encryptedDeliveryToken: null,
      tokenHash: null,
      deliveryToken: null,
    });
    expect(data).not.toHaveProperty("deliveryAttempts");
    expect(mocks.tx.weleticReviewReminder.updateMany).toHaveBeenNthCalledWith(
      1,
      {
        where: {
          storeId: "store",
          requestId: { in: ["invitation"] },
          request: { storeId: "store", id: { in: ["invitation"] } },
          attempts: 0,
          status: { in: ["queued", "sending", "failed"] },
        },
        data: {
          status: "cancelled",
          settledAt: expect.any(Date),
          outcomeReason: "expired",
          leaseToken: null,
          leaseExpiresAt: null,
        },
      },
    );
    expect(mocks.tx.weleticLoyaltyOutboxJob.updateMany).toHaveBeenCalledWith({
      where: {
        storeId: "store",
        jobType: "REVIEW_REQUEST_EMAIL",
        idempotencyKey: "review_request_email:invitation",
        status: { in: ["pending", "processing", "failed"] },
      },
      data: { status: "cancelled", lockedAt: null, lockedBy: null },
    });
  });
  it.each(["sent", "submitted", "cancelled", "expired"])(
    "preserves %s historical status",
    async (status) => {
      mocks.tx.weleticReviewRequest.findFirst.mockResolvedValue({
        status,
        deliveryAttempts: 1,
      });
      await clearExpiredReviewDeliveryEvidence({ now });
      const { data } =
        mocks.tx.weleticReviewRequest.updateMany.mock.calls[0][0];
      expect(data).not.toHaveProperty("status");
      expect(data).not.toHaveProperty("lastError");
    },
  );
  it("does not erase a row that changed eligibility before locked reread", async () => {
    mocks.tx.weleticReviewRequest.findFirst.mockResolvedValue(null);
    expect(await clearExpiredReviewDeliveryEvidence({ now })).toEqual({
      scanned: 1,
      cleared: 0,
      deferred: 0,
    });
    expect(mocks.tx.weleticReviewRequest.updateMany).not.toHaveBeenCalled();
    expect(mocks.tx.weleticLoyaltyOutboxJob.updateMany).not.toHaveBeenCalled();
  });
  it("can erase after customer identity removal without inventing a lock identity", async () => {
    mocks.find.mockResolvedValue([
      { ...candidate, shopper: { shopifyCustomerId: null } },
    ]);
    await clearExpiredReviewDeliveryEvidence({ now });
    expect(mocks.lock).not.toHaveBeenCalled();
    expect(mocks.tx.$queryRaw).toHaveBeenCalledOnce();
  });
  it("defers a busy customer without blocking a later candidate", async () => {
    mocks.find.mockResolvedValue([candidate, { ...candidate, id: "next" }]);
    mocks.lock.mockImplementationOnce(({ onLocked }) => onLocked());
    expect(await clearExpiredReviewDeliveryEvidence({ now })).toEqual({
      scanned: 2,
      cleared: 1,
      deferred: 1,
    });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(
      mocks.tx.weleticReviewRequest.updateMany.mock.calls[0][0].where.id,
    ).toBe("next");
  });
  it.each([0, -1, 101, 1.5, Number.NaN])(
    "rejects invalid bounds %s",
    async (batchSize) => {
      await expect(
        clearExpiredReviewDeliveryEvidence({ batchSize, now }),
      ).rejects.toThrow("Invalid review retention batch");
      expect(mocks.find).not.toHaveBeenCalled();
    },
  );
});
