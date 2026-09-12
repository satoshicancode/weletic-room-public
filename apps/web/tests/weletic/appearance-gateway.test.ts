import { DEFAULT_LOYALTY_BRANDING } from "@/lib/weletic/loyalty/branding";
import { manageShopifyLoyaltyAppearanceInTransaction } from "@/lib/weletic/shopify/loyalty-appearance";
import type { Prisma } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  read: vi.fn(),
  save: vi.fn(),
  fence: vi.fn(),
  store: vi.fn(),
}));
vi.mock("@/lib/weletic/shopify/staff-authorization", () => ({
  authorizeShopifyMerchantInTransaction: mocks.auth,
  ShopifyStaffAuthorizationError: class extends Error {},
}));
vi.mock("@/lib/weletic/shopify/store-compliance-state", () => ({
  assertShopifyStoreAcceptsOperationalWrites: mocks.fence,
}));
vi.mock("@/lib/weletic/loyalty/appearance-service", () => ({
  readLoyaltyAppearanceInTransaction: mocks.read,
  saveLoyaltyAppearanceInTransaction: mocks.save,
  LoyaltyAppearanceConflictError: class extends Error {},
}));
const tx = {
  weleticShopifyStore: { findUnique: mocks.store },
} as unknown as Prisma.TransactionClient;
const actor = {
  storeId: "store-1",
  projectId: "project-1",
  installationGeneration: "generation-1",
};
const save = {
  operation: "save",
  expectedInstallationGeneration: "generation-1",
  expectedRevision: "a".repeat(64),
  branding: { ...DEFAULT_LOYALTY_BRANDING },
};
const run = (request: unknown) =>
  manageShopifyLoyaltyAppearanceInTransaction({
    tx,
    envelope: { signedFixture: true },
    request,
  });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue(actor);
  mocks.store.mockResolvedValue({ projectId: actor.projectId });
  const state = {
    revision: "b".repeat(64),
    programConfigured: true,
    branding: save.branding,
  };
  mocks.read.mockResolvedValue(state);
  mocks.save.mockResolvedValue(state);
});
it("requires appearance authority for reads without writing or activating", async () => {
  expect(await run({ operation: "read" })).toMatchObject({
    storeId: "store-1",
    capabilities: { configure: true },
  });
  expect(mocks.auth).toHaveBeenCalledWith(
    expect.objectContaining({ permission: "appearance.configure", tx }),
  );
  expect(mocks.read).toHaveBeenCalledWith(tx, actor.storeId);
  expect(mocks.save).not.toHaveBeenCalled();
  expect(mocks.fence).not.toHaveBeenCalled();
});
it("uses only authenticated ownership and fences before saving", async () => {
  await run(save);
  expect(mocks.fence).toHaveBeenCalledWith(
    expect.objectContaining({
      tx,
      storeId: actor.storeId,
      expectedInstallationGeneration: actor.installationGeneration,
    }),
  );
  expect(mocks.save).toHaveBeenCalledWith({
    tx,
    storeId: actor.storeId,
    installationGeneration: actor.installationGeneration,
    request: save,
  });
  expect(mocks.fence.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.save.mock.invocationCallOrder[0],
  );
});
it.each(["ownership", "generation", "authorization", "operational"])(
  "rejects %s failure before saving",
  async (kind) => {
    if (kind === "ownership")
      mocks.store.mockResolvedValue({ projectId: "foreign" });
    if (kind === "generation")
      mocks.auth.mockResolvedValue({
        ...actor,
        installationGeneration: "replacement",
      });
    if (kind === "authorization")
      mocks.auth.mockRejectedValue(new Error("denied"));
    if (kind === "operational")
      mocks.fence.mockRejectedValue(new Error("blocked"));
    await expect(run(save)).rejects.toThrow();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
  },
);
