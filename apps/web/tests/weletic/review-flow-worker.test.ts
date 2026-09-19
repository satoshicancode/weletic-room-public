import { LoyaltyMaintenanceBlockedError } from "@/lib/weletic/loyalty/maintenance-write-fence";
import { REVIEW_FLOW_HANDLES } from "@/lib/weletic/reviews/flow-contract";
import { ReviewFlowDeferredError } from "@/lib/weletic/reviews/flow-errors";
import { enqueueReviewFlowEvent } from "@/lib/weletic/reviews/flow-producer";
import { handleReviewFlowTrigger } from "@/lib/weletic/reviews/flow-worker";
import type { Prisma } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  settings: vi.fn(),
  review: vi.fn(),
  privacy: vi.fn(),
  assert: vi.fn(),
  lock: vi.fn(),
  credentials: vi.fn(),
  dispatch: vi.fn(),
  enqueue: vi.fn(),
}));
vi.mock("@/lib/weletic/loyalty/flow-trigger-outbox", () => ({
  enqueueFlowTriggerJob: m.enqueue,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticReviewSettings: { findUnique: m.settings },
    weleticProductReview: { findFirst: m.review },
  },
}));
vi.mock("@/lib/weletic/loyalty/flow-triggers", () => ({
  dispatchShopifyFlowTrigger: m.dispatch,
  classifyShopifyFlowDispatchError: (e: unknown) => e,
  ShopifyFlowDispatchError: class extends Error {
    constructor(
      message: string,
      public retryable: boolean,
    ) {
      super(message);
    }
  },
}));
vi.mock("@/lib/weletic/loyalty/shopify-discounts", () => ({
  resolveShopifyOfflineCredentials: m.credentials,
}));
vi.mock("@/lib/weletic/shopify/customer-settlement-lock", () => ({
  withShopifyCustomerSettlementLocks: m.lock,
}));
vi.mock("@/lib/weletic/shopify/privacy-identity", () => ({
  hasShopifyCustomerPrivacyTombstone: m.privacy,
}));
vi.mock("@/lib/weletic/shopify/store-compliance-state", () => ({
  assertShopifyStoreAcceptsOperationalWrites: m.assert,
  isShopifyStoreOperationalWritesBlocked: (e: unknown) =>
    e instanceof Error && e.message === "blocked",
}));
const event = {
  handle: REVIEW_FLOW_HANDLES.SUBMITTED,
  reviewId: `wreview_${"a".repeat(20)}`,
  version: 1,
  installationGeneration: "g1",
  occurredAt: "2026-09-20T00:00:00.000Z",
  rating: 1,
  verifiedPurchase: true,
};
function row() {
  return {
    status: "pending",
    version: 1,
    rating: 1,
    verifiedPurchase: true,
    shopperId: "shopper",
    productId: "product",
    product: { storeId: "store" },
    store: { projectId: "workspace" },
    request: {
      storeId: "store",
      shopperId: "shopper",
      productId: "product",
      installationGeneration: "g1",
      order: { storeId: "store", shopperId: "shopper" },
    },
    shopper: {
      storeId: "store",
      shopifyCustomerId: "gid://shopify/Customer/1",
      email: "fixture@example.test",
      privacyTombstones: [] as { id: string }[],
    },
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  m.settings.mockResolvedValue({ enabled: true });
  m.review.mockResolvedValue(row());
  m.privacy.mockResolvedValue(false);
  m.lock.mockImplementation(({ fn }) => fn());
  m.credentials.mockResolvedValue({
    shopDomain: "test.myshopify.com",
    accessToken: "synthetic-token",
  });
});
it("dispatches a low-rating review with no loyalty account or content projection", async () => {
  await handleReviewFlowTrigger("store", event);
  expect(m.dispatch).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      handle: event.handle,
      payload: { event, customerGid: "gid://shopify/Customer/1" },
    }),
  );
  expect(m.lock).toHaveBeenCalledWith(
    expect.objectContaining({
      workspaceId: "workspace",
      storeId: "store",
      shopifyCustomerId: "gid://shopify/Customer/1",
    }),
  );
  expect(m.assert).toHaveBeenCalledTimes(3);
  for (const [call] of m.assert.mock.calls)
    expect(call.expectedInstallationGeneration).toBe("g1");
  expect(m.review.mock.calls[0][0].select).not.toHaveProperty("body");
});
it.each([
  "disabled",
  "missing",
  "privacy",
  "foreign-shopper",
  "foreign-request",
  "foreign-product",
  "foreign-order",
  "stale-generation",
  "linked-tombstone",
  "future-version",
])("suppresses %s before credentials/transport", async (reason) => {
  const value = row();
  if (reason === "disabled") m.settings.mockResolvedValue({ enabled: false });
  if (reason === "missing") m.review.mockResolvedValue(null);
  if (reason === "privacy") m.privacy.mockResolvedValue(true);
  if (reason === "foreign-shopper") value.shopper.storeId = "other";
  if (reason === "foreign-request") value.request.shopperId = "other";
  if (reason === "foreign-product") value.product.storeId = "other";
  if (reason === "foreign-order") value.request.order.storeId = "other";
  if (reason === "stale-generation")
    value.request.installationGeneration = "g2";
  if (reason === "linked-tombstone")
    value.shopper.privacyTombstones.push({ id: "erased" });
  if (reason === "future-version") value.version = 0;
  if (reason !== "missing") m.review.mockResolvedValue(value);
  await expect(handleReviewFlowTrigger("store", event)).rejects.toThrow();
  expect(m.credentials).not.toHaveBeenCalled();
  expect(m.dispatch).not.toHaveBeenCalled();
});
it.each(["privacy", "disabled", "generation", "identity"])(
  "rechecks %s after credential refresh",
  async (change) => {
    m.credentials.mockImplementation(async () => {
      if (change === "privacy") m.privacy.mockResolvedValue(true);
      if (change === "disabled")
        m.settings.mockResolvedValue({ enabled: false });
      if (change === "generation")
        m.assert.mockRejectedValue(new Error("blocked"));
      if (change === "identity")
        m.review.mockResolvedValue({
          ...row(),
          shopper: {
            ...row().shopper,
            shopifyCustomerId: "gid://shopify/Customer/2",
          },
        });
      return {
        shopDomain: "test.myshopify.com",
        accessToken: "synthetic-token",
      };
    });
    await expect(handleReviewFlowTrigger("store", event)).rejects.toThrow();
    expect(m.credentials).toHaveBeenCalledTimes(1);
    expect(m.dispatch).not.toHaveBeenCalled();
  },
);
it("suppresses unpublished publication events without suppressing submitted criticism", async () => {
  m.review.mockResolvedValue({ ...row(), status: "hidden" });
  await expect(
    handleReviewFlowTrigger("store", {
      ...event,
      handle: REVIEW_FLOW_HANDLES.PUBLISHED,
    }),
  ).rejects.toMatchObject({ retryable: false });
  expect(m.dispatch).not.toHaveBeenCalled();
  await handleReviewFlowTrigger("store", event);
  expect(m.dispatch).toHaveBeenCalledTimes(1);
});
it("propagates provider failure for durable queue retry", async () => {
  m.dispatch.mockRejectedValue(new Error("synthetic failure"));
  await expect(handleReviewFlowTrigger("store", event)).rejects.toThrow(
    "synthetic failure",
  );
});
it("rejects malformed event authority before any lookup", async () => {
  await expect(
    handleReviewFlowTrigger("store", { ...event, installationGeneration: "" }),
  ).rejects.toThrow();
  expect(m.review).not.toHaveBeenCalled();
  expect(m.assert).not.toHaveBeenCalled();
});

it("defers customer-lock contention without resolving credentials or sending", async () => {
  m.lock.mockImplementation(({ onLocked }) => onLocked());
  await expect(handleReviewFlowTrigger("store", event)).rejects.toBeInstanceOf(
    ReviewFlowDeferredError,
  );
  expect(m.credentials).not.toHaveBeenCalled();
  expect(m.dispatch).not.toHaveBeenCalled();
});
it("preserves maintenance deferral identity after credential lookup", async () => {
  const blocked = new LoyaltyMaintenanceBlockedError({ storeId: "store" });
  m.credentials.mockImplementation(async () => {
    m.assert.mockRejectedValue(blocked);
    return { shopDomain: "test.myshopify.com", accessToken: "synthetic-token" };
  });
  await expect(handleReviewFlowTrigger("store", event)).rejects.toBe(blocked);
  expect(m.dispatch).not.toHaveBeenCalled();
});
it.each(["suspended", "pending_approval", "frozen", "currency_unverified"])(
  "defers temporary %s store authority",
  async (complianceState) => {
    m.assert.mockRejectedValue(
      Object.assign(new Error("blocked"), { complianceState }),
    );
    await expect(
      handleReviewFlowTrigger("store", event),
    ).rejects.toBeInstanceOf(ReviewFlowDeferredError);
    expect(m.dispatch).not.toHaveBeenCalled();
  },
);
it.each([
  "redacted",
  "stale_installation_generation",
  "access_unavailable",
  "unknown",
  undefined,
])(
  "terminally contains retired or missing authority %s",
  async (complianceState) => {
    m.assert.mockRejectedValue(
      Object.assign(new Error("blocked"), { complianceState }),
    );
    await expect(handleReviewFlowTrigger("store", event)).rejects.toMatchObject(
      { retryable: false },
    );
    expect(m.dispatch).not.toHaveBeenCalled();
  },
);
it("allows newly authorized publication after reinstall without rebinding its historical invitation", async () => {
  m.review.mockResolvedValue({ ...row(), status: "published", version: 2 });
  const publication = {
    ...event,
    handle: REVIEW_FLOW_HANDLES.PUBLISHED,
    version: 2,
    installationGeneration: "g2",
  };
  await enqueueReviewFlowEvent({
    tx: {} as Prisma.TransactionClient,
    storeId: "store",
    generation: "g2",
    event: {
      handle: publication.handle,
      reviewId: publication.reviewId,
      version: publication.version,
      occurredAt: publication.occurredAt,
      rating: publication.rating,
      verifiedPurchase: publication.verifiedPurchase,
    },
  });
  expect(m.enqueue).toHaveBeenCalledTimes(1);
  expect(m.enqueue.mock.calls[0][0].payload).toEqual(publication);
  await handleReviewFlowTrigger("store", m.enqueue.mock.calls[0][0].payload);
  expect(m.dispatch).toHaveBeenCalledWith(
    expect.objectContaining({
      payload: { event: publication, customerGid: "gid://shopify/Customer/1" },
    }),
  );
  for (const [call] of m.assert.mock.calls)
    expect(call.expectedInstallationGeneration).toBe("g2");
});
