import { createProspectiveStoreReviewRequest } from "@/lib/weletic/reviews/store-requests";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  parent: vi.fn(),
  storeSettings: vi.fn(),
  cancellation: vi.fn(),
  order: vi.fn(),
  existing: vi.fn(),
  productRequests: vi.fn(),
  create: vi.fn(),
  policyAtOrderTime: vi.fn(),
  readPolicy: vi.fn(),
  purchase: vi.fn(),
  suppression: vi.fn(),
  enqueue: vi.fn(),
}));
vi.mock("@/lib/weletic/loyalty/outbox", () => ({
  enqueueOutboxJobFromProgramTransaction: mocks.enqueue,
}));
vi.mock("@/lib/weletic/reviews/transaction", () => ({
  withReviewMutation: async (_store: string, operation: Function) =>
    operation(
      {
        weleticReviewSettings: { findUnique: mocks.parent },
        weleticStoreReviewSettings: { findUnique: mocks.storeSettings },
        weleticReviewOrderCancellation: { findUnique: mocks.cancellation },
        weleticCommerceOrder: { findUnique: mocks.order },
        weleticStoreReviewRequest: {
          findUnique: mocks.existing,
          create: mocks.create,
        },
        weleticReviewRequest: { findMany: mocks.productRequests },
      },
      "generation-1",
    ),
}));
vi.mock("@/lib/weletic/reviews/incentive-activation-history", () => ({
  reviewPolicyAtOrderTime: mocks.policyAtOrderTime,
}));
vi.mock("@/lib/weletic/reviews/incentive-policy", () => ({
  readReviewIncentivePolicySnapshot: mocks.readPolicy,
}));
vi.mock("@/lib/weletic/reviews/purchase", () => ({
  assertReviewPurchaseNotSuppressed: mocks.suppression,
}));
vi.mock("@/lib/weletic/reviews/store-purchase", () => ({
  assertStoreReviewPurchase: mocks.purchase,
  storeReviewRequestInclude: {},
}));

const parent = {
  enabled: true,
  requestEmailEnabled: true,
  activatedAt: new Date("2026-09-01T00:00:00Z"),
  activeIncentivePolicyId: "current-policy",
};
const storeSettings = {
  enabled: true,
  requestEmailEnabled: true,
  activatedAt: new Date("2026-09-15T00:00:00Z"),
  sendAfterDays: 3,
  expiresAfterDays: 30,
  revision: 7,
};
const run = (fulfilledAt = new Date("2026-09-20T00:00:00Z")) =>
  createProspectiveStoreReviewRequest({
    storeId: "store",
    orderExternalId: "1234",
    fulfilledAt,
    expectedInstallationGeneration: "generation-1",
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.parent.mockResolvedValue(parent);
  mocks.storeSettings.mockResolvedValue(storeSettings);
  mocks.order.mockResolvedValue({
    id: "order",
    storeId: "store",
    status: "paid",
    occurredAt: new Date("2026-09-18T00:00:00Z"),
    shopper: {
      id: "shopper",
      storeId: "store",
      email: "synthetic@example.test",
      privacyTombstones: [],
    },
    lines: [{ id: "line", quantity: 2 }],
  });
  mocks.productRequests.mockResolvedValue([{ incentivePolicyId: "original" }]);
  mocks.create.mockImplementation(async ({ data }) => ({ ...data }));
});

it("requires both prospective cutoffs, including a later store re-enable", async () => {
  expect(await run(new Date("2026-09-14T23:59:59Z"))).toBeNull();
  mocks.parent.mockResolvedValue({
    ...parent,
    activatedAt: new Date("2026-09-21T00:00:00Z"),
  });
  expect(await run()).toBeNull();
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.order).not.toHaveBeenCalled();
});

it("keeps the product invitation's original order-wide policy and one order request", async () => {
  await run();
  expect(mocks.policyAtOrderTime).not.toHaveBeenCalled();
  expect(mocks.readPolicy).toHaveBeenCalledWith(
    expect.anything(),
    "store",
    "original",
  );
  expect(mocks.create.mock.calls[0][0].data).toMatchObject({
    store: { connect: { id: "store" } },
    order: { connect: { id: "order" } },
    shopper: { connect: { storeId_id: { storeId: "store", id: "shopper" } } },
    incentivePolicy: {
      connect: { storeId_id: { storeId: "store", id: "original" } },
    },
    settingsRevision: 7,
    installationGeneration: "generation-1",
    sendAt: new Date("2026-09-23T00:00:00Z"),
    expiresAt: new Date("2026-10-23T00:00:00Z"),
    lines: {
      create: [
        { orderLine: { connect: { id: "line" } }, purchasedQuantity: 2 },
      ],
    },
  });
  expect(mocks.purchase).toHaveBeenCalledOnce();
  expect(mocks.enqueue).toHaveBeenCalledWith(
    expect.objectContaining({
      storeId: "store",
      jobType: "REVIEW_REQUEST_EMAIL",
      payload: {
        storeRequestId: expect.stringMatching(/^wstorereq_/),
        installationGeneration: "generation-1",
      },
      scheduledFor: new Date("2026-09-23T00:00:00Z"),
    }),
  );
});

it("replays the existing invitation without replacing its policy or deadline", async () => {
  mocks.existing.mockResolvedValue({
    id: "prior-request",
    installationGeneration: "generation-1",
  });
  expect(await run()).toBe("prior-request");
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.productRequests).not.toHaveBeenCalled();
  expect(mocks.enqueue).not.toHaveBeenCalled();
});

it("fails closed when product invitations disagree on the promised policy", async () => {
  mocks.productRequests.mockResolvedValue([
    { incentivePolicyId: "points" },
    { incentivePolicyId: "coupon" },
  ]);
  await expect(run()).rejects.toThrow("require reconciliation");
  expect(mocks.create).not.toHaveBeenCalled();
});

it("does not create after cancellation or shopper privacy suppression", async () => {
  mocks.cancellation.mockResolvedValue({ orderExternalId: "1234" });
  expect(await run()).toBeNull();
  mocks.cancellation.mockResolvedValue(null);
  mocks.suppression.mockRejectedValue(new Error("privacy tombstone"));
  await expect(run()).rejects.toThrow("privacy tombstone");
  expect(mocks.create).not.toHaveBeenCalled();
});
