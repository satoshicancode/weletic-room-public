import { defaultStoreReviewSettingsPolicy } from "@/lib/weletic/reviews/store-settings-contract";
import {
  readShopifyMerchantStoreReviewSettingsInTransaction as read,
  writeShopifyMerchantStoreReviewSettings as write,
} from "@/lib/weletic/shopify/merchant-store-review-settings";
import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  authorize: vi.fn(),
  fence: vi.fn(),
  findStore: vi.fn(),
  findProduct: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/weletic/shopify/staff-authorization", () => ({
  authorizeShopifyMerchantInTransaction: m.authorize,
}));
vi.mock("@/lib/weletic/reviews/transaction", () => ({
  withReviewMutation: m.fence,
}));

const tx = {
  weleticStoreReviewSettings: {
    findUnique: m.findStore,
    create: m.create,
    updateMany: m.update,
  },
  weleticReviewSettings: { findUnique: m.findProduct },
} as unknown as Parameters<typeof read>[0]["tx"];
const actor = {
  version: 1,
  storeId: "store-a",
  appId: "app-a",
  shop: "shop.myshopify.com",
  installationGeneration: "generation-a",
  userId: "123",
  sessionId: "shop.myshopify.com_123",
  sessionDigest: "a".repeat(64),
  authenticatedAt: 1,
  requestId: "b".repeat(64),
};
let current: Record<string, unknown> | null;
const patch = (
  revision: number,
  enabled: boolean,
  requestEmailEnabled: boolean,
) => ({
  expectedRevision: revision,
  expectedInstallationGeneration: "generation-a",
  policy: {
    ...defaultStoreReviewSettingsPolicy(),
    enabled,
    requestEmailEnabled,
  },
});
beforeEach(() => {
  vi.resetAllMocks();
  current = null;
  m.authorize.mockResolvedValue(actor);
  m.findProduct.mockResolvedValue({ enabled: true });
  m.findStore.mockImplementation(async () => current);
  m.fence.mockImplementation(async (_store, operation) =>
    operation(tx, "generation-a"),
  );
  m.create.mockImplementation(async ({ data }) => {
    current = data;
    return data;
  });
  m.update.mockImplementation(async ({ where, data }) => {
    if (current?.revision !== where.revision) return { count: 0 };
    current = { ...current, ...data, revision: where.revision + 1 };
    return { count: 1 };
  });
});
it("requires configure authority and returns disabled defaults without a writer", async () => {
  expect(await read({ tx, envelope: actor, input: {} })).toEqual({
    revision: 0,
    installationGeneration: "generation-a",
    productReviewsEnabled: true,
    policy: defaultStoreReviewSettingsPolicy(),
  });
  expect(m.authorize).toHaveBeenCalledWith({
    tx,
    envelope: actor,
    permission: "reviews.configure",
  });
  expect(m.create).not.toHaveBeenCalled();
});
it("sets a prospective cutoff only on email activation and reactivation", async () => {
  const first = await write({ envelope: actor, input: patch(0, true, false) });
  expect(first.revision).toBe(1);
  expect(current?.activatedAt).toBeNull();
  await write({ envelope: actor, input: patch(1, true, true) });
  const activated = current?.activatedAt;
  expect(activated).toBeInstanceOf(Date);
  await write({
    envelope: actor,
    input: {
      ...patch(2, true, true),
      policy: { ...patch(2, true, true).policy, sendAfterDays: 8 },
    },
  });
  expect(current?.activatedAt).toEqual(activated);
  await write({ envelope: actor, input: patch(3, true, false) });
  expect(current?.activatedAt).toBeNull();
  await write({ envelope: actor, input: patch(4, true, true) });
  expect(current?.activatedAt).toBeInstanceOf(Date);
});
it("rejects stale revisions, disabled parent and foreign installation", async () => {
  await write({ envelope: actor, input: patch(0, false, false) });
  await expect(
    write({ envelope: actor, input: patch(0, true, true) }),
  ).rejects.toThrow("changed");
  m.findProduct.mockResolvedValue({ enabled: false });
  await expect(
    write({ envelope: actor, input: patch(1, true, true) }),
  ).rejects.toThrow("Product Reviews");
  await expect(
    write({
      envelope: actor,
      input: {
        ...patch(1, true, true),
        expectedInstallationGeneration: "retired",
      },
    }),
  ).rejects.toThrow("Installation changed");
  expect(m.update).not.toHaveBeenCalled();
});
it("does not reach settings after authority denial", async () => {
  m.authorize.mockRejectedValue(new Error("denied"));
  await expect(
    write({ envelope: actor, input: patch(0, true, true) }),
  ).rejects.toThrow("denied");
  expect(m.findStore).not.toHaveBeenCalled();
  expect(m.create).not.toHaveBeenCalled();
});
