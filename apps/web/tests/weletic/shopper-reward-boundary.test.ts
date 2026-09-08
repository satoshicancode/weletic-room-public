import { cancelRewardRedemption } from "@/lib/weletic/loyalty/rewards";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  identity: vi.fn(),
  transaction: vi.fn(),
  ledger: vi.fn(),
  enqueue: vi.fn(),
  provision: vi.fn(),
  credentials: vi.fn(),
  deactivate: vi.fn(),
  lock: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticRewardRedemption: { findFirst: mocks.identity },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/weletic/loyalty/ledger", () => ({
  appendPointsLedgerEntry: mocks.ledger,
}));
vi.mock("@/lib/weletic/loyalty/outbox", () => ({
  enqueueOutboxJob: mocks.enqueue,
}));
vi.mock("@/lib/weletic/loyalty/saga", () => ({
  provisionDiscountSaga: mocks.provision,
}));
vi.mock("@/lib/weletic/loyalty/shopper-privacy", () => ({
  hasShopifyCustomerRedactionTombstone: vi.fn(),
}));
vi.mock("@/lib/weletic/shopify/customer-settlement-lock", () => ({
  withShopifyCustomerSettlementLocks: mocks.lock,
}));
vi.mock("@/lib/weletic/loyalty/shopify-discounts", () => ({
  resolveShopifyOfflineCredentials: mocks.credentials,
  deactivateDiscount: mocks.deactivate,
  lookupDiscountByCode: vi.fn(),
}));

describe("accountless coupon containment in the production cancellation entry point", () => {
  beforeEach(() => vi.clearAllMocks());
  it("rejects a direct shopper coupon before a points transaction, provider request, or account lock", async () => {
    mocks.identity.mockResolvedValue({ account: null });
    await expect(
      cancelRewardRedemption({ storeId: "store-1", redemptionId: "direct-1" }),
    ).rejects.toThrow("points operations are forbidden");
    expect(mocks.identity).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "direct-1", storeId: "store-1" },
      }),
    );
    for (const operation of [
      mocks.transaction,
      mocks.ledger,
      mocks.enqueue,
      mocks.credentials,
      mocks.deactivate,
      mocks.lock,
    ]) {
      expect(operation).not.toHaveBeenCalled();
    }
  });
});
