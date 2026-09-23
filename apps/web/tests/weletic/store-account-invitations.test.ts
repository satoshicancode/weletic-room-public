import { ReviewError } from "@/lib/weletic/reviews/contracts";
import { listStoreAccountInvitations } from "@/lib/weletic/reviews/store-account-invitations";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  parent: vi.fn(),
  settings: vi.fn(),
  shopper: vi.fn(),
  anchor: vi.fn(),
  requests: vi.fn(),
  cancellation: vi.fn(),
  policy: vi.fn(),
  suppression: vi.fn(),
  purchase: vi.fn(),
  bindings: vi.fn(),
}));
vi.mock("@/lib/weletic/reviews/transaction", () => ({
  withReviewMutation: async (_store: string, operation: Function) =>
    operation(
      {
        weleticReviewSettings: { findUnique: mocks.parent },
        weleticStoreReviewSettings: { findUnique: mocks.settings },
        weleticShopper: { findFirst: mocks.shopper },
        weleticStoreReviewRequest: {
          findFirst: mocks.anchor,
          findMany: mocks.requests,
        },
        weleticReviewOrderCancellation: { findUnique: mocks.cancellation },
      },
      "generation-a",
    ),
}));
vi.mock("@/lib/weletic/reviews/purchase", () => ({
  assertReviewPurchaseNotSuppressed: mocks.suppression,
}));
vi.mock("@/lib/weletic/reviews/store-purchase", () => ({
  assertStoreReviewPurchase: mocks.purchase,
  assertStoreReviewRequestLineBindings: mocks.bindings,
  storeReviewRequestInclude: {},
}));
vi.mock("@/lib/weletic/reviews/incentive-policy", () => ({
  readReviewIncentivePolicySnapshot: mocks.policy,
}));

const request = (id: string) => ({
  id,
  fulfilledAt: new Date("2026-09-21T00:00:00Z"),
  expiresAt: new Date("2040-01-01T00:00:00Z"),
  incentivePolicyId: null,
  order: { externalId: id },
});
const run = (query: unknown = {}) =>
  listStoreAccountInvitations({
    storeId: "store-a",
    shopperId: "shopper-a",
    expectedInstallationGeneration: "generation-a",
    query,
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.parent.mockResolvedValue({ enabled: true });
  mocks.settings.mockResolvedValue({ enabled: true });
  mocks.shopper.mockResolvedValue({
    id: "shopper-a",
    storeId: "store-a",
    privacyTombstones: [],
  });
  mocks.requests.mockResolvedValue([request("one")]);
  mocks.policy.mockResolvedValue(null);
});

it("reads only the authenticated shopper's sent current-installation page", async () => {
  expect(await run({ limit: "2" })).toEqual({
    items: [
      {
        requestId: "one",
        orderExternalId: "one",
        fulfilledAt: "2026-09-21T00:00:00.000Z",
        expiresAt: "2040-01-01T00:00:00.000Z",
        incentiveDisclosure: null,
      },
    ],
    nextCursor: null,
  });
  expect(mocks.requests).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        storeId: "store-a",
        shopperId: "shopper-a",
        installationGeneration: "generation-a",
        status: "sent",
      }),
      take: 3,
    }),
  );
});

it("filters cancelled or invalid purchases without exposing them", async () => {
  mocks.requests.mockResolvedValue([request("cancelled"), request("invalid")]);
  mocks.cancellation.mockResolvedValueOnce({ orderExternalId: "cancelled" });
  mocks.purchase.mockImplementation((item) => {
    if (item.id === "invalid")
      throw new ReviewError("not_found", "invalid evidence");
  });
  expect(await run()).toEqual({ items: [], nextCursor: null });
  expect(mocks.policy).not.toHaveBeenCalled();
});

it("fails closed for disabled modules, owner privacy and foreign cursors", async () => {
  mocks.settings.mockResolvedValueOnce({ enabled: false });
  await expect(run()).rejects.toThrow("Store reviews unavailable");
  mocks.shopper.mockResolvedValueOnce({
    id: "shopper-a",
    storeId: "store-a",
    privacyTombstones: [{ id: "redacted" }],
  });
  await expect(run()).rejects.toThrow("Review invitations unavailable");
  await expect(run({ cursor: "other-customer" })).rejects.toThrow(
    "Invalid invitation cursor",
  );
  expect(mocks.anchor).toHaveBeenCalledWith({
    where: {
      id: "other-customer",
      storeId: "store-a",
      shopperId: "shopper-a",
      installationGeneration: "generation-a",
    },
    select: { createdAt: true, id: true },
  });
});

it("rejects oversized or unknown query input before opening a transaction", async () => {
  expect(() => run({ limit: "21" })).toThrow();
  expect(() => run({ shopperId: "attacker" })).toThrow();
  expect(mocks.parent).not.toHaveBeenCalled();
});
