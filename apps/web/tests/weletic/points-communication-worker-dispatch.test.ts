import type { WeleticLoyaltyOutboxJob } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";
import { executeOutboxJob } from "../../lib/weletic/loyalty/outbox-worker";

const mocks = vi.hoisted(() => ({
  account: vi.fn(),
  guard: vi.fn(),
  locks: vi.fn(),
  send: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { weleticLoyaltyAccount: { findFirst: mocks.account } },
}));
vi.mock("@/lib/weletic/shopify/store-compliance-state", async (original) => ({
  ...(await original<
    typeof import("@/lib/weletic/shopify/store-compliance-state")
  >()),
  assertShopifyStoreAcceptsOperationalWrites: mocks.guard,
}));
vi.mock("@/lib/weletic/shopify/customer-settlement-lock", () => ({
  withShopifyCustomerSettlementLocks: mocks.locks,
}));
vi.mock("../../lib/weletic/loyalty/points-earned-notifications", () => ({
  sendPointsEarnedNotification: mocks.send,
}));
const at = new Date("2026-09-10T00:00:00Z");
function fixture() {
  const candidate: WeleticLoyaltyOutboxJob = {
    id: "job",
    storeId: "store",
    jobType: "LOYALTY_COMMUNICATION",
    status: "pending",
    idempotencyKey: "event-key",
    scheduledFor: at,
    createdAt: at,
    updatedAt: at,
    attempts: 0,
    maxAttempts: 5,
    priority: 0,
    lockedAt: null,
    lockedBy: null,
    processedAt: null,
    completedAt: null,
    lastError: null,
    nextRetryAt: null,
    errorLog: [],
    payload: { accountId: "account", installationGeneration: "g1" },
  };
  return { candidate, ownerToken: "worker", claimedAt: at, attempt: 1 };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.account.mockResolvedValue({
    status: "active",
    shopper: { shopifyCustomerId: "synthetic-customer" },
    store: { projectId: "workspace" },
  });
  mocks.locks.mockImplementation(async ({ fn }) => fn());
});
it("dispatches under customer settlement locks with the persisted generation", async () => {
  const claim = fixture();
  let held = false;
  mocks.locks.mockImplementation(async ({ fn }) => {
    held = true;
    try {
      return await fn();
    } finally {
      held = false;
    }
  });
  mocks.send.mockImplementation(async () => {
    expect(held).toBe(true);
  });
  await executeOutboxJob(claim.candidate, at, undefined, claim);
  expect(mocks.guard).toHaveBeenCalledWith(
    expect.objectContaining({
      storeId: "store",
      expectedInstallationGeneration: "g1",
    }),
  );
  expect(mocks.locks).toHaveBeenCalledWith(
    expect.objectContaining({
      workspaceId: "workspace",
      storeId: "store",
      shopifyCustomerId: "synthetic-customer",
    }),
  );
  expect(mocks.send).toHaveBeenCalledWith({
    claim,
    loyaltyMaintenancePermit: undefined,
  });
});
it.each(["missing", "different"])("rejects %s worker claim", async (kind) => {
  const claim = fixture();
  await expect(
    executeOutboxJob(
      claim.candidate,
      at,
      undefined,
      kind === "missing" ? undefined : fixture(),
    ),
  ).rejects.toThrow("requires its worker claim");
  expect(mocks.send).not.toHaveBeenCalled();
});
it.each(["missing", "closed"])(
  "does not deliver to %s accounts",
  async (kind) => {
    const claim = fixture();
    if (kind === "missing") mocks.account.mockResolvedValue(null);
    else
      mocks.account
        .mockResolvedValueOnce({
          status: "active",
          shopper: { shopifyCustomerId: "synthetic-customer" },
          store: { projectId: "workspace" },
        })
        .mockResolvedValueOnce({ status: "closed" });
    await executeOutboxJob(claim.candidate, at, undefined, claim);
    expect(mocks.send).not.toHaveBeenCalled();
  },
);
