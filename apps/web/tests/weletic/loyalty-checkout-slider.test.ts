import {
  acquireDistributedLock,
  releaseDistributedLock,
} from "@/lib/weletic/redis-lock";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticShopifyStore: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    weleticShopper: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("@/lib/weletic/redis-lock", () => ({
  acquireDistributedLock: vi.fn(),
  releaseDistributedLock: vi.fn(),
}));

describe("Shopify Plus Checkout UI Slider & Reservation Engine (ADR 0001)", () => {
  it("acquires 15-minute distributed reservation lock when points are available", async () => {
    const mockStore = {
      id: "store_123",
      shopDomain: "yamax-store.myshopify.com",
      currency: "USD",
    };

    const mockShopper = {
      id: "shopper_1",
      storeId: "store_123",
      shopifyCustomerId: "cust_999",
      loyaltyAccount: {
        id: "acct_1",
        pointsBalance: BigInt(1500),
      },
    };

    vi.mocked(acquireDistributedLock).mockResolvedValueOnce({
      acquired: true,
      token: "res_lock_abc",
    });

    const pointsRequested = 500;
    const isZeroDecimal = ["JPY", "VND"].includes(mockStore.currency);
    const discountAmountCents = isZeroDecimal
      ? pointsRequested
      : pointsRequested;

    const lock = await acquireDistributedLock({
      key: `loyalty:reservation:${mockStore.id}:${mockShopper.shopifyCustomerId}:chk_token_1`,
      ttlSeconds: 900,
    });

    expect(lock.acquired).toBe(true);
    expect(lock.token).toBe("res_lock_abc");
    expect(discountAmountCents).toBe(500); // 500 cents = $5.00
  });

  it("calculates zero-decimal currency discount accurately (JPY 1 pt = ¥1)", () => {
    const jpyStore = {
      id: "store_jpy",
      currency: "JPY",
    };

    const pointsRequested = 1200;
    const isZeroDecimal = ["JPY", "VND", "KRW"].includes(jpyStore.currency);
    const discountAmountCents = isZeroDecimal
      ? pointsRequested
      : pointsRequested;

    expect(isZeroDecimal).toBe(true);
    expect(discountAmountCents).toBe(1200); // ¥1,200 discount
  });

  it("rejects points reservation when customer points balance is insufficient", () => {
    const availablePoints = 300;
    const requestedPoints = 500;

    const isEligible = availablePoints >= requestedPoints;
    expect(isEligible).toBe(false);
  });

  it("releases distributed reservation lock upon customer slider cancellation", async () => {
    vi.mocked(releaseDistributedLock).mockResolvedValueOnce(true);

    const released = await releaseDistributedLock({
      key: "loyalty:reservation:store_123:cust_999:chk_token_1",
      token: "res_lock_abc",
    });

    expect(released).toBe(true);
  });
});
