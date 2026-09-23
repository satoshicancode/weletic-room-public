import {
  assertStoreReviewPurchase,
  assertStoreReviewPurchaseIdentity,
  assertStoreReviewSubmissionPurchase,
  type StoreReviewPurchase,
} from "@/lib/weletic/reviews/store-purchase";
import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const privacy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/weletic/shopify/privacy-identity", () => ({
  hasShopifyCustomerPrivacyTombstone: privacy,
}));
beforeEach(() => {
  privacy.mockReset().mockResolvedValue(false);
});

function purchase(): StoreReviewPurchase {
  return {
    storeId: "store-a",
    orderId: "order-a",
    shopperId: "shopper-a",
    installationGeneration: "generation-a",
    order: {
      id: "order-a",
      externalId: "gid://shopify/Order/1",
      storeId: "store-a",
      shopperId: "shopper-a",
      status: "paid",
    },
    shopper: {
      id: "shopper-a",
      storeId: "store-a",
      privacyTombstones: [],
      shopifyCustomerId: "gid://shopify/Customer/1",
      email: null,
    },
    lines: [
      {
        purchasedQuantity: 2,
        orderLine: {
          id: "line-a",
          orderId: "order-a",
          quantity: 2,
          shopNet: BigInt(2000),
          refundLines: [],
        },
      },
    ],
  };
}

describe("store-review trusted order evidence", () => {
  const tx = {} as Prisma.TransactionClient;
  it("checks unlinked privacy identities on the caller transaction", async () => {
    const request = purchase();
    await assertStoreReviewSubmissionPurchase({
      tx,
      storeId: "store-a",
      generation: "generation-a",
      request,
    });
    expect(privacy).toHaveBeenCalledExactlyOnceWith({
      tx,
      storeId: "store-a",
      shopifyCustomerId: request.shopper.shopifyCustomerId,
      email: null,
    });
  });
  it("rejects an internally consistent foreign store before privacy lookup", async () => {
    await expect(
      assertStoreReviewSubmissionPurchase({
        tx,
        storeId: "store-b",
        generation: "generation-a",
        request: purchase(),
      }),
    ).rejects.toThrow("Review request unavailable");
    expect(privacy).not.toHaveBeenCalled();
  });
  it("rejects unlinked tombstones and unavailable privacy evidence", async () => {
    privacy
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error("Privacy unavailable"));
    const run = () =>
      assertStoreReviewSubmissionPurchase({
        tx,
        storeId: "store-a",
        generation: "generation-a",
        request: purchase(),
      });
    await expect(run()).rejects.toThrow("Review request unavailable");
    await expect(run()).rejects.toThrow("Privacy unavailable");
  });
  it("accepts order feedback without inventing a product binding", () => {
    expect(() =>
      assertStoreReviewPurchase(purchase(), "generation-a"),
    ).not.toThrow();
  });
  it.each([null, "", "old-generation"])(
    "rejects invalid installation %s",
    (generation) => {
      expect(() => assertStoreReviewPurchase(purchase(), generation)).toThrow(
        "Review request unavailable",
      );
    },
  );
  it.each([
    (r: StoreReviewPurchase) => {
      r.order.id = "other-order";
    },
    (r: StoreReviewPurchase) => {
      r.order.storeId = "other-store";
    },
    (r: StoreReviewPurchase) => {
      r.order.shopperId = "other-shopper";
    },
    (r: StoreReviewPurchase) => {
      r.shopper.id = "other-shopper";
    },
    (r: StoreReviewPurchase) => {
      r.shopper.storeId = "other-store";
    },
    (r: StoreReviewPurchase) => {
      r.shopper.privacyTombstones = [{ id: "tombstone" }];
    },
    (r: StoreReviewPurchase) => {
      r.lines = [];
    },
    (r: StoreReviewPurchase) => {
      r.lines[0].orderLine.orderId = "other-order";
    },
    (r: StoreReviewPurchase) => {
      r.lines.push(structuredClone(r.lines[0]));
    },
    (r: StoreReviewPurchase) => {
      r.lines[0].purchasedQuantity = 3;
    },
    (r: StoreReviewPurchase) => {
      r.lines[0].purchasedQuantity = 0;
    },
    (r: StoreReviewPurchase) => {
      r.lines[0].purchasedQuantity = 1.5;
    },
    (r: StoreReviewPurchase) => {
      r.lines[0].orderLine.quantity = -1;
    },
  ])("rejects forged or malformed persisted bindings %#", (mutate) => {
    const request = purchase();
    mutate(request);
    expect(() => assertStoreReviewPurchase(request, "generation-a")).toThrow(
      "Review request unavailable",
    );
  });
  it("accepts remaining purchased quantity after a partial refund", () => {
    const request = purchase();
    request.order.status = "partially_refunded";
    request.lines[0].orderLine.refundLines = [
      { quantity: 1, shopAmount: BigInt(1000) },
    ];
    expect(() =>
      assertStoreReviewPurchase(request, "generation-a"),
    ).not.toThrow();
  });
  it("qualifies against any retained purchased line, not just the first", () => {
    const request = purchase();
    const second = structuredClone(request.lines[0]);
    second.orderLine.id = "line-b";
    request.lines.push(second);
    request.order.status = "partially_refunded";
    request.lines[0].orderLine.refundLines = [
      { quantity: 2, shopAmount: BigInt(2000) },
    ];
    expect(() =>
      assertStoreReviewPurchase(request, "generation-a"),
    ).not.toThrow();
    second.orderLine.refundLines = [{ quantity: 2, shopAmount: BigInt(2000) }];
    expect(() => assertStoreReviewPurchase(request, "generation-a")).toThrow(
      "Review request unavailable",
    );
    expect(() =>
      assertStoreReviewPurchaseIdentity(request, "generation-a"),
    ).not.toThrow();
  });
  it.each([
    { quantity: -1, shopAmount: BigInt(0) },
    { quantity: 0.5, shopAmount: BigInt(0) },
    { quantity: 0, shopAmount: BigInt(-1) },
  ])(
    "rejects corrupt refund evidence rather than increasing eligibility %#",
    (refund) => {
      const request = purchase();
      request.lines[0].orderLine.refundLines = [refund];
      expect(() => assertStoreReviewPurchase(request, "generation-a")).toThrow(
        "Review request unavailable",
      );
    },
  );
  it.each(["quantity", "amount", "status"])(
    "rejects initial qualification after full refund by %s, without invalidating identity",
    (reason) => {
      const request = purchase();
      if (reason === "status") request.order.status = "refunded";
      else
        request.lines[0].orderLine.refundLines = [
          {
            quantity: reason === "quantity" ? 2 : 0,
            shopAmount: reason === "amount" ? BigInt(2000) : BigInt(0),
          },
        ];
      expect(() =>
        assertStoreReviewPurchaseIdentity(request, "generation-a"),
      ).not.toThrow();
      expect(() => assertStoreReviewPurchase(request, "generation-a")).toThrow(
        "Review request unavailable",
      );
    },
  );
});
