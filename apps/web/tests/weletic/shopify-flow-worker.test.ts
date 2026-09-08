import {
  createLoyaltyMaintenanceLeaseMetadata,
  createLoyaltyMaintenanceOwnerPermit,
  LoyaltyMaintenanceBlockedError,
} from "@/lib/weletic/loyalty/maintenance-write-fence";
import { ShopifyDiscountError } from "@/lib/weletic/loyalty/shopify-discounts";
import { ShopifyStoreOperationalWritesBlockedError } from "@/lib/weletic/shopify/store-compliance-state";
import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  accountFindFirst: vi.fn(),
  shouldDispatch: vi.fn(),
  dispatch: vi.fn(),
  resolveCredentials: vi.fn(),
  assertOperationalWrites: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticLoyaltyAccount: { findFirst: mocks.accountFindFirst },
  },
}));

vi.mock("@/lib/weletic/loyalty/flow-lifecycle", () => ({
  shouldDispatchShopifyFlowForStore: mocks.shouldDispatch,
}));

vi.mock("@/lib/weletic/loyalty/shopify-discounts", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/weletic/loyalty/shopify-discounts")
  >()),
  resolveShopifyOfflineCredentials: mocks.resolveCredentials,
}));

vi.mock(
  "@/lib/weletic/shopify/store-compliance-state",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/weletic/shopify/store-compliance-state")
    >()),
    assertShopifyStoreAcceptsOperationalWrites: mocks.assertOperationalWrites,
  }),
);

vi.mock("@/lib/weletic/loyalty/flow-triggers", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/weletic/loyalty/flow-triggers")
  >()),
  dispatchShopifyFlowTrigger: mocks.dispatch,
}));

import { handleFlowTrigger } from "@/lib/weletic/loyalty/flow-trigger-worker";
import { ShopifyFlowDispatchError } from "@/lib/weletic/loyalty/flow-triggers";

const earnedPayload = {
  accountId: "wacc_1",
  handle: "weletic-points-earned",
  pointsDelta: "25",
  pointsBalance: "150",
  reason: "order_purchase",
  installationGeneration: "g1",
};
const credentials = {
  shopDomain: "flow-fixture.myshopify.com",
  accessToken: "synthetic-g1-offline-token",
};
const staleGenerationError = () =>
  new ShopifyStoreOperationalWritesBlockedError({
    storeId: "wstore_1",
    action: "loyalty_outbox:FLOW_TRIGGER",
    complianceState: "stale_installation_generation",
  });

describe("Shopify Flow outbox worker", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.shouldDispatch.mockResolvedValue(true);
    mocks.accountFindFirst.mockResolvedValue({
      cachedPointsBalance: BigInt(150),
      nextExpiryDate: new Date("2026-10-01T00:00:00.000Z"),
      pointsExpiryPolicyVersion: 3,
      shopper: { shopifyCustomerId: "gid://shopify/Customer/42" },
    });
    mocks.dispatch.mockResolvedValue({ success: true });
    mocks.resolveCredentials.mockResolvedValue(credentials);
    mocks.assertOperationalWrites.mockResolvedValue({
      installationGeneration: "g1",
    });
  });

  it("dispatches an enabled event with the stored customer reference unchanged", async () => {
    await handleFlowTrigger("wstore_1", {
      accountId: "wacc_1",
      handle: "weletic-points-earned",
      pointsDelta: "25",
      pointsBalance: "150",
      reason: "order_purchase",
      orderId: "order_1",
    });
    expect(mocks.dispatch).toHaveBeenCalledWith({
      storeId: "wstore_1",
      shopDomain: credentials.shopDomain,
      offlineToken: credentials.accessToken,
      handle: "weletic-points-earned",
      payload: {
        customerGid: "gid://shopify/Customer/42",
        pointsDelta: "25",
        pointsBalance: "150",
        reason: "order_purchase",
        orderId: "order_1",
      },
    });
  });

  it("completes without dispatch when the store has no enabled workflow", async () => {
    mocks.shouldDispatch.mockResolvedValue(false);
    await handleFlowTrigger("wstore_1", {
      accountId: "wacc_1",
      handle: "weletic-points-earned",
      pointsDelta: "25",
      pointsBalance: "150",
      reason: "order_purchase",
    });
    expect(mocks.accountFindFirst).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("drops a stale expiry warning after the policy deadline changes", async () => {
    await handleFlowTrigger("wstore_1", {
      accountId: "wacc_1",
      handle: "weletic-points-expiring-soon",
      pointsExpiring: "150",
      expiryDate: "2026-11-01T00:00:00.000Z",
      urgency: "warning",
      policyVersion: 3,
    });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("uses the current balance when a redemption changes points before a warning runs", async () => {
    mocks.accountFindFirst.mockResolvedValue({
      cachedPointsBalance: BigInt(75),
      nextExpiryDate: new Date("2026-10-01T00:00:00.000Z"),
      pointsExpiryPolicyVersion: 3,
      shopper: { shopifyCustomerId: "gid://shopify/Customer/42" },
    });

    await handleFlowTrigger("wstore_1", {
      accountId: "wacc_1",
      handle: "weletic-points-expiring-soon",
      pointsExpiring: "150",
      expiryDate: "2026-10-01T00:00:00.000Z",
      urgency: "warning",
      policyVersion: 3,
    });

    expect(mocks.dispatch).toHaveBeenCalledWith({
      storeId: "wstore_1",
      shopDomain: credentials.shopDomain,
      offlineToken: credentials.accessToken,
      handle: "weletic-points-expiring-soon",
      payload: {
        customerGid: "gid://shopify/Customer/42",
        pointsExpiring: "75",
        expiryDate: "2026-10-01T00:00:00.000Z",
        urgency: "warning",
      },
    });
  });

  it("marks corrupt durable payloads as terminal", async () => {
    await expect(
      handleFlowTrigger("wstore_1", {
        accountId: "wacc_1",
        handle: "weletic-points-earned",
        pointsDelta: "not-an-integer",
      }),
    ).rejects.toMatchObject({ retryable: false });
    expect(mocks.shouldDispatch).not.toHaveBeenCalled();
  });

  it("drops an event invalidated while waiting for the customer lock before resolving credentials", async () => {
    mocks.assertOperationalWrites.mockRejectedValueOnce(staleGenerationError());
    await expect(
      handleFlowTrigger("wstore_1", earnedPayload),
    ).resolves.toBeUndefined();
    expect(mocks.assertOperationalWrites).toHaveBeenCalledTimes(1);
    expect(mocks.assertOperationalWrites).toHaveBeenCalledWith({
      storeId: "wstore_1",
      action: "loyalty_outbox:FLOW_TRIGGER",
      expectedInstallationGeneration: "g1",
      loyaltyMaintenancePermit: undefined,
    });
    expect(mocks.resolveCredentials).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("does not dispatch a newer installation's credential after reconnect during credential resolution", async () => {
    mocks.resolveCredentials.mockImplementation(async () => {
      mocks.assertOperationalWrites.mockRejectedValueOnce(
        staleGenerationError(),
      );
      return { ...credentials, accessToken: "synthetic-g2-offline-token" };
    });
    await expect(
      handleFlowTrigger("wstore_1", earnedPayload),
    ).resolves.toBeUndefined();
    expect(mocks.resolveCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.resolveCredentials).toHaveBeenCalledWith({
      storeId: "wstore_1",
    });
    expect(mocks.assertOperationalWrites).toHaveBeenCalledTimes(2);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("keeps a missing legacy generation null at both guards instead of adopting the current installation", async () => {
    const { installationGeneration: _generation, ...legacyPayload } =
      earnedPayload;
    await handleFlowTrigger("wstore_1", legacyPayload);
    expect(mocks.assertOperationalWrites).toHaveBeenCalledTimes(2);
    for (const [guardInput] of mocks.assertOperationalWrites.mock.calls) {
      expect(guardInput).toMatchObject({
        expectedInstallationGeneration: null,
      });
    }
  });

  it.each([
    ["NOT_FOUND", false],
    ["UNAUTHORIZED", false],
    ["NETWORK_ERROR", true],
  ] as const)(
    "classifies credential %s failures with retryable=%s before dispatch",
    async (code, retryable) => {
      mocks.resolveCredentials.mockRejectedValueOnce(
        new ShopifyDiscountError(code, "Credential resolution failed"),
      );
      const result = handleFlowTrigger("wstore_1", earnedPayload);
      await expect(result).rejects.toBeInstanceOf(ShopifyFlowDispatchError);
      await expect(result).rejects.toMatchObject({
        message: "Credential resolution failed",
        retryable,
      });
      expect(mocks.assertOperationalWrites).toHaveBeenCalledTimes(1);
      expect(mocks.resolveCredentials).toHaveBeenCalledTimes(1);
      expect(mocks.dispatch).not.toHaveBeenCalled();
    },
  );

  it.each(["before_credentials", "after_credentials"] as const)(
    "propagates a real Prisma error from the %s guard without dispatching",
    async (stage) => {
      const error = new Prisma.PrismaClientKnownRequestError(
        "Database transaction failed",
        {
          code: "P2034",
          clientVersion: "test",
        },
      );
      if (stage === "after_credentials") {
        mocks.assertOperationalWrites.mockResolvedValueOnce({
          installationGeneration: "g1",
        });
      }
      mocks.assertOperationalWrites.mockRejectedValueOnce(error);
      await expect(handleFlowTrigger("wstore_1", earnedPayload)).rejects.toBe(
        error,
      );
      expect(mocks.dispatch).not.toHaveBeenCalled();
      expect(mocks.resolveCredentials).toHaveBeenCalledTimes(
        stage === "before_credentials" ? 0 : 1,
      );
    },
  );

  it("forwards an actual owner maintenance permit to both installation guards", async () => {
    const ownerToken = "owner-token-0123456789abcdef0123456789abcdef";
    const metadata = createLoyaltyMaintenanceLeaseMetadata({
      existingMetadata: null,
      ownerToken,
      runMarker: "weletic-a1-0123456789abcdef",
      fixtureEmails: ["flow-fixture@example.test"],
      acquiredAt: new Date("2026-09-05T00:00:00.000Z"),
      recoveryAfter: new Date("2026-09-05T01:00:00.000Z"),
    });
    const permit = createLoyaltyMaintenanceOwnerPermit({
      storeId: "wstore_1",
      ownerToken,
      metadata: metadata as Prisma.JsonObject,
    });
    await handleFlowTrigger("wstore_1", earnedPayload, permit);
    expect(mocks.assertOperationalWrites).toHaveBeenCalledTimes(2);
    for (const [guardInput] of mocks.assertOperationalWrites.mock.calls) {
      expect(guardInput.loyaltyMaintenancePermit).toBe(permit);
    }
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
  });

  it("propagates a maintenance lease deferral instead of treating it as a stale installation", async () => {
    const error = new LoyaltyMaintenanceBlockedError({ storeId: "wstore_1" });
    mocks.assertOperationalWrites.mockRejectedValueOnce(error);
    await expect(handleFlowTrigger("wstore_1", earnedPayload)).rejects.toBe(
      error,
    );
    expect(mocks.resolveCredentials).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
});
