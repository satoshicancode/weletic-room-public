import { processReviewOrderEvent } from "@/lib/weletic/reviews/shopify-events";
import { beforeEach, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  product: vi.fn(),
  store: vi.fn(),
  cancellation: vi.fn(),
  lock: vi.fn(),
}));
vi.mock("@/lib/weletic/shopify/customer-settlement-lock", () => ({
  withShopifySettlementLocks: mock.lock,
}));
vi.mock("@/lib/weletic/reviews/requests", () => ({
  createFulfilledReviewRequests: mock.product,
  recordReviewOrderCancellation: mock.cancellation,
}));
vi.mock("@/lib/weletic/reviews/store-requests", () => ({
  createProspectiveStoreReviewRequest: mock.store,
}));

const base = {
  topic: "orders/fulfilled" as const,
  storeId: "store-1",
  workspaceId: "workspace-1",
  expectedInstallationGeneration: "generation-1",
  event: {
    id: "12345",
    customer: { id: "98765" },
    fulfillment_status: "fulfilled",
    updated_at: "2026-09-23T00:00:00Z",
  },
};

beforeEach(() => {
  vi.resetAllMocks();
  mock.lock.mockImplementation(({ fn }) => fn());
  mock.product.mockResolvedValue([]);
  mock.store.mockResolvedValue(null);
});

it("creates both prospective invitation sources under the same order lock", async () => {
  await processReviewOrderEvent(base);
  expect(mock.lock).toHaveBeenCalledWith({
    workspaceId: "workspace-1",
    storeId: "store-1",
    orderExternalId: "12345",
    shopifyCustomerId: "98765",
    fn: expect.any(Function),
  });
  const expected = {
    storeId: "store-1",
    orderExternalId: "12345",
    fulfilledAt: new Date("2026-09-23T00:00:00Z"),
    expectedInstallationGeneration: "generation-1",
  };
  expect(mock.product).toHaveBeenCalledWith(expected);
  expect(mock.store).toHaveBeenCalledWith(expected);
  expect(mock.product.mock.invocationCallOrder[0]).toBeLessThan(
    mock.store.mock.invocationCallOrder[0],
  );
});

it("never creates a store invitation for cancellation or a non-fulfilled order", async () => {
  await processReviewOrderEvent({
    ...base,
    topic: "orders/cancelled",
    event: { ...base.event, cancelled_at: "2026-09-23T00:10:00Z" },
  });
  expect(mock.cancellation).toHaveBeenCalledTimes(1);
  expect(mock.product).not.toHaveBeenCalled();
  expect(mock.store).not.toHaveBeenCalled();
  await processReviewOrderEvent({
    ...base,
    event: { ...base.event, fulfillment_status: "partial" },
  });
  expect(mock.product).not.toHaveBeenCalled();
  expect(mock.store).not.toHaveBeenCalled();
});

it("does not create a non-null-generation store source for legacy events", async () => {
  await processReviewOrderEvent({
    ...base,
    expectedInstallationGeneration: null,
  });
  expect(mock.product).toHaveBeenCalledTimes(1);
  expect(mock.store).not.toHaveBeenCalled();
});

it("retries the authenticated fulfillment if product projection is unavailable", async () => {
  mock.product.mockRejectedValueOnce(new Error("projection pending"));
  await expect(processReviewOrderEvent(base)).rejects.toThrow(
    "projection pending",
  );
  expect(mock.store).not.toHaveBeenCalled();
});

it("retries store projection failures after replay-safe product creation", async () => {
  mock.store.mockRejectedValueOnce(new Error("store projection pending"));
  await expect(processReviewOrderEvent(base)).rejects.toThrow(
    "store projection pending",
  );
  expect(mock.product).toHaveBeenCalledTimes(1);
  expect(mock.store).toHaveBeenCalledTimes(1);
});
