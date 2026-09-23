import { defaultReviewCollectionPolicy } from "@/lib/weletic/reviews/collection-contract";
import {
  cancelIneligibleReviewRequests,
  createFulfilledReviewRequests,
} from "@/lib/weletic/reviews/requests";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  cancelled: vi.fn(),
  order: vi.fn(),
  existing: vi.fn(),
  create: vi.fn(),
  enqueue: vi.fn(),
  requests: vi.fn(),
  storeRequest: vi.fn(),
  update: vi.fn(),
  cancelJobs: vi.fn(),
  erase: vi.fn(),
}));
vi.mock("@/lib/weletic/reviews/transaction", () => ({
  withReviewMutation: async (_store: string, operation: Function) =>
    operation(
      {
        weleticReviewSettings: { findUnique: mocks.settings },
        weleticReviewOrderCancellation: { findUnique: mocks.cancelled },
        weleticCommerceOrder: { findUnique: mocks.order },
        weleticReviewRequest: {
          findMany: mocks.requests,
          findUnique: mocks.existing,
          create: mocks.create,
          update: mocks.update,
        },
        weleticStoreReviewRequest: { findUnique: mocks.storeRequest },
        weleticLoyaltyOutboxJob: { updateMany: mocks.cancelJobs },
      },
      "g1",
    ),
}));
vi.mock("@/lib/weletic/reviews/reminder-retention", () => ({
  eraseReviewReminderMaterialInTransaction: mocks.erase,
}));
vi.mock("@/lib/weletic/reviews/incentive-activation-history", () => ({
  reviewPolicyAtOrderTime: async () => null,
}));
vi.mock("@/lib/weletic/reviews/incentive-policy", () => ({
  readReviewIncentivePolicySnapshot: async () => null,
}));
vi.mock("@/lib/weletic/reviews/purchase", () => ({
  assertReviewPurchase: vi.fn(),
  reviewRequestInclude: {},
}));
vi.mock("@/lib/weletic/loyalty/outbox", () => ({
  enqueueOutboxJobFromProgramTransaction: mocks.enqueue,
}));
const settings = {
  ...defaultReviewCollectionPolicy(),
  enabled: true,
  requestEmailEnabled: true,
  activatedAt: new Date("2026-09-01T00:00:00Z"),
  collectionRevision: 4,
  reminderAfterDays: [3, 7],
};
const run = () =>
  createFulfilledReviewRequests({
    storeId: "store",
    orderExternalId: "1234",
    fulfilledAt: new Date("2026-09-20T00:00:00Z"),
    expectedInstallationGeneration: "g1",
  });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.requests.mockResolvedValue([]);
  mocks.storeRequest.mockResolvedValue(null);
  mocks.settings.mockResolvedValue(settings);
  mocks.order.mockResolvedValue({
    id: "order",
    status: "paid",
    occurredAt: new Date("2026-09-19T00:00:00Z"),
    shopper: {
      id: "shopper",
      storeId: "store",
      email: "synthetic@example.test",
      privacyTombstones: [],
    },
    lines: [
      {
        id: "line",
        productId: "product",
        quantity: 1,
        product: { storeId: "store" },
      },
    ],
  });
  mocks.create.mockImplementation(async ({ data }) => ({ ...data }));
});
it("order cancellation erases reminder authority in the same transaction without changing awards", async () => {
  mocks.requests.mockResolvedValue([
    { id: "request", reminderSnapshot: { version: 1 } },
  ]);
  await cancelIneligibleReviewRequests("store", "order", true, {
    expectedInstallationGeneration: "g1",
  });
  expect(mocks.update).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        status: "cancelled",
        cancellationReason: "order_cancelled",
      }),
    }),
  );
  expect(mocks.erase).toHaveBeenCalledWith(expect.anything(), {
    storeId: "store",
    requestIds: ["request"],
    reason: "purchase_ineligible",
  });
  expect(mocks.enqueue).not.toHaveBeenCalled();
});
it("snapshots only the new request schedule alongside its original send and expiry", async () => {
  await run();
  const saved = mocks.create.mock.calls[0][0].data;
  expect(saved).toMatchObject({
    installationGeneration: "g1",
    sendAt: new Date("2026-09-27T00:00:00Z"),
    expiresAt: new Date("2026-10-27T00:00:00Z"),
    reminderSnapshot: {
      version: 1,
      collectionRevision: 4,
      expiresAfterDays: 30,
      reminderAfterDays: [3, 7],
    },
  });
  expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  expect(mocks.enqueue.mock.calls[0][0].jobType).toBe("REVIEW_REQUEST_EMAIL");
});
it("does not retrofit a reminder schedule when a fulfillment event replays", async () => {
  mocks.existing.mockResolvedValue({
    id: "historical-request",
    reminderSnapshot: null,
  });
  expect(await run()).toEqual(["historical-request"]);
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.enqueue).not.toHaveBeenCalled();
});
it("uses the already-promised store invitation policy for a later product invitation", async () => {
  mocks.storeRequest.mockResolvedValue({ incentivePolicyId: "store-promise" });
  await run();
  expect(mocks.create.mock.calls[0][0].data.incentivePolicyId).toBe(
    "store-promise",
  );
});
it("rejects conflicting product and store invitation policies", async () => {
  mocks.requests.mockResolvedValue([{ incentivePolicyId: "product-promise" }]);
  mocks.storeRequest.mockResolvedValue({ incentivePolicyId: "store-promise" });
  await expect(run()).rejects.toThrow("require reconciliation");
  expect(mocks.create).not.toHaveBeenCalled();
});
it("retains no-reminder behavior for legacy null settings", async () => {
  mocks.settings.mockResolvedValue({
    ...settings,
    reminderAfterDays: null,
    collectionRevision: 0,
  });
  await run();
  expect(mocks.create.mock.calls[0][0].data.reminderSnapshot).toMatchObject({
    collectionRevision: 0,
    reminderAfterDays: [],
  });
});
