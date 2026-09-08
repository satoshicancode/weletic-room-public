import { manageShopifyMerchantSettingsInTransaction as manage } from "@/lib/weletic/shopify/merchant-settings";
import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  read: vi.fn(),
  update: vi.fn(),
  reviews: vi.fn(),
  loyalty: vi.fn(),
  capabilities: vi.fn(),
}));
vi.mock("@/lib/weletic/shopify/settings-capabilities", () => ({
  readSettingsCapabilities: mocks.capabilities,
}));
vi.mock("@/lib/weletic/loyalty/module-settings", () => ({
  toggleLoyaltyModuleInTransaction: mocks.loyalty,
}));
vi.mock("@/lib/weletic/reviews/service", () => ({
  toggleReviewModuleInTransaction: mocks.reviews,
}));
vi.mock("@/lib/weletic/shopify/staff-authorization", () => ({
  authorizeShopifyMerchantInTransaction: mocks.authorize,
}));
vi.mock("@/lib/weletic/merchant-settings/service", () => ({
  readMerchantSettingsInTransaction: mocks.read,
  updateMerchantSettingsInTransaction: mocks.update,
}));

const tx = Object.freeze({}) as Prisma.TransactionClient;
const envelope = { fixture: "signed actor supplied by request boundary" };
const actor = {
  storeId: "store-a",
  projectId: "workspace-a",
  installationGeneration: "g1",
};
const result = {
  storeId: "store-a",
  installationGeneration: "g1",
  revision: 1,
  capabilities: {
    settings: true,
    appearance: true,
    loyalty: false,
    reviews: false,
  },
};
const input = {
  expectedRevision: 0,
  expectedInstallationGeneration: "g1",
  settings: { shopperEmailPaused: true },
};

describe("Shopify shared merchant settings authorization adapter", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.authorize.mockResolvedValue(actor);
    mocks.read.mockResolvedValue(result);
    mocks.update.mockResolvedValue(result);
    mocks.capabilities.mockResolvedValue(result.capabilities);
  });
  it("uses explicit settings permission and the caller transaction for reads", async () => {
    expect(
      await manage({ tx, envelope, request: { operation: "read", input: {} } }),
    ).toEqual(result);
    expect(mocks.authorize).toHaveBeenCalledWith({
      tx,
      envelope,
      permission: "settings.configure",
    });
    expect(mocks.read).toHaveBeenCalledWith(tx, "workspace-a");
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("requires loyalty configuration and returns only module state", async () => {
    const input = {
      status: "active",
      expectedStatus: "disabled",
      expectedInstallationGeneration: "g1",
    };
    mocks.loyalty.mockResolvedValue({
      status: "active",
      killSwitchActive: true,
      metadata: "private",
    });
    expect(
      await manage({
        tx,
        envelope,
        request: { operation: "loyalty-module", input },
      }),
    ).toEqual({
      storeId: "store-a",
      installationGeneration: "g1",
      settings: { status: "active", killSwitchActive: true },
    });
    expect(mocks.authorize).toHaveBeenCalledWith({
      tx,
      envelope,
      permission: "loyalty.configure",
    });
    expect(mocks.loyalty).toHaveBeenCalledWith(tx, "store-a", input);
    expect(mocks.update).not.toHaveBeenCalled();
    await expect(
      manage({
        tx,
        envelope,
        request: {
          operation: "loyalty-module",
          input: { ...input, expectedInstallationGeneration: "old" },
        },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(mocks.loyalty).toHaveBeenCalledTimes(1);
  });
  it("reuses the authorized transaction without inventing a workspace owner role", async () => {
    await manage({ tx, envelope, request: { operation: "update", input } });
    expect(mocks.update).toHaveBeenCalledWith({
      tx,
      storeId: "store-a",
      workspaceId: "workspace-a",
      input,
    });
  });
  it("uses separate review configuration authority and returns only module state", async () => {
    const input = {
      enabled: false,
      expectedUpdatedAt: null,
      expectedInstallationGeneration: "g1",
    };
    mocks.reviews.mockResolvedValue({
      enabled: false,
      requestEmailEnabled: true,
      updatedAt: new Date(0),
      secret: "not projected",
    });
    expect(
      await manage({
        tx,
        envelope,
        request: { operation: "review-module", input },
      }),
    ).toEqual({
      storeId: "store-a",
      installationGeneration: "g1",
      settings: {
        enabled: false,
        requestEmailEnabled: true,
        updatedAt: new Date(0).toISOString(),
      },
    });
    expect(mocks.authorize).toHaveBeenCalledWith({
      tx,
      envelope,
      permission: "reviews.configure",
    });
    expect(mocks.reviews).toHaveBeenCalledWith(tx, "store-a", input);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it.each(["read", "update"])(
    "does not %s after authority is denied",
    async (operation) => {
      mocks.authorize.mockRejectedValue(new Error("access_denied"));
      await expect(
        manage({
          tx,
          envelope,
          request: { operation, input: operation === "read" ? {} : input },
        }),
      ).rejects.toThrow("access_denied");
      expect(mocks.read).not.toHaveBeenCalled();
      expect(mocks.update).not.toHaveBeenCalled();
    },
  );
  it("rejects an old installation before writing", async () => {
    await expect(
      manage({
        tx,
        envelope,
        request: {
          operation: "update",
          input: { ...input, expectedInstallationGeneration: "old" },
        },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it.each([
    { operation: "read", input: { workspaceId: "foreign" } },
    { operation: "update", input: { ...input, role: "owner" } },
    { operation: "update", input: { ...input, settings: { enabled: true } } },
    { operation: "module", input: { enabled: true } },
  ])(
    "rejects caller identity and module control additions: %j",
    async (request) => {
      await expect(manage({ tx, envelope, request })).rejects.toThrow();
      expect(mocks.authorize).not.toHaveBeenCalled();
      expect(mocks.update).not.toHaveBeenCalled();
    },
  );
  it.each([
    { ...result, storeId: "foreign" },
    { ...result, installationGeneration: "replacement" },
  ])(
    "rejects a projection outside the authorized installation",
    async (projection) => {
      mocks.read.mockResolvedValue(projection);
      await expect(
        manage({ tx, envelope, request: { operation: "read", input: {} } }),
      ).rejects.toMatchObject({ code: "not_found" });
    },
  );
});
