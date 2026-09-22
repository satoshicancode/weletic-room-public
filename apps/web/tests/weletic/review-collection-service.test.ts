import { defaultReviewCollectionPolicy } from "@/lib/weletic/reviews/collection-contract";
import { updateReviewCollectionInTransaction } from "@/lib/weletic/reviews/service";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settings: { findUnique: vi.fn(), upsert: vi.fn() },
  requests: { updateMany: vi.fn() },
  integration: { updateMany: vi.fn() },
  reminders: { updateMany: vi.fn() },
  operational: vi.fn(),
  enqueue: vi.fn(),
}));
vi.mock("@/lib/weletic/shopify/store-compliance-state", () => ({
  assertShopifyStoreAcceptsOperationalWrites: mocks.operational,
}));
vi.mock("@/lib/weletic/loyalty/outbox", () => ({
  enqueueOutboxJobFromProgramTransaction: mocks.enqueue,
}));
const tx = {
  weleticReviewSettings: mocks.settings,
  weleticReviewRequest: mocks.requests,
  weleticLoyaltyReviewIntegration: mocks.integration,
  weleticReviewReminder: mocks.reminders,
} as any;
const previous = {
  ...defaultReviewCollectionPolicy(),
  enabled: true,
  collectionRevision: 3,
  activeIncentivePolicyId: "original-promise",
};
const patch = {
  expectedRevision: 3,
  expectedInstallationGeneration: "g1",
  policy: {
    ...defaultReviewCollectionPolicy(),
    requestEmailEnabled: true,
    reminderAfterDays: [3, 7],
  },
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.operational.mockResolvedValue({ installationGeneration: "g1" });
  mocks.settings.findUnique.mockResolvedValue(previous);
  mocks.settings.upsert.mockImplementation(async ({ update }) => ({
    ...previous,
    ...update,
  }));
});

it("preserves module and incentive authority while advancing collection revision", async () => {
  const result = await updateReviewCollectionInTransaction(tx, "store", patch);
  expect(mocks.operational).toHaveBeenCalledWith({
    tx,
    storeId: "store",
    action: "native_reviews",
    expectedInstallationGeneration: "g1",
  });
  expect(result).toMatchObject({
    enabled: true,
    collectionRevision: 4,
    activeIncentivePolicyId: "original-promise",
    reminderAfterDays: [3, 7],
  });
  const write = mocks.settings.upsert.mock.calls[0][0].update;
  expect(write).not.toHaveProperty("activeIncentivePolicyId");
  expect(write.activatedAt).toBeInstanceOf(Date);
  expect(mocks.enqueue).not.toHaveBeenCalled();
  expect(mocks.requests.updateMany).not.toHaveBeenCalled();
});
it("rejects stale editors without lifecycle side effects", async () => {
  await expect(
    updateReviewCollectionInTransaction(tx, "store", {
      ...patch,
      expectedRevision: 2,
    }),
  ).rejects.toThrow("settings changed");
  expect(mocks.settings.upsert).not.toHaveBeenCalled();
  expect(mocks.requests.updateMany).not.toHaveBeenCalled();
  expect(mocks.enqueue).not.toHaveBeenCalled();
});
it("does not configure a retired installation", async () => {
  mocks.operational.mockRejectedValue(new Error("retired installation"));
  await expect(
    updateReviewCollectionInTransaction(tx, "store", patch),
  ).rejects.toThrow("retired installation");
  expect(mocks.settings.findUnique).not.toHaveBeenCalled();
  expect(mocks.settings.upsert).not.toHaveBeenCalled();
});
it("creates settings without enabling the review module", async () => {
  mocks.settings.findUnique.mockResolvedValue(null);
  await updateReviewCollectionInTransaction(tx, "store", {
    ...patch,
    expectedRevision: 0,
  });
  expect(mocks.settings.upsert.mock.calls[0][0].create).toMatchObject({
    storeId: "store",
    enabled: false,
    activatedAt: null,
    collectionRevision: 1,
  });
  expect(mocks.integration.updateMany).not.toHaveBeenCalled();
});
it("reuses email-disable cancellation while leaving already-sent tokens usable", async () => {
  await updateReviewCollectionInTransaction(tx, "store", {
    ...patch,
    policy: { ...patch.policy, requestEmailEnabled: false },
  });
  expect(mocks.requests.updateMany).toHaveBeenCalledWith({
    where: {
      storeId: "store",
      status: { in: ["queued", "sending", "failed"] },
    },
    data: expect.objectContaining({
      status: "cancelled",
      cancellationReason: "settings_disabled",
      tokenHash: null,
      encryptedDeliveryToken: null,
      encryptedDeliverySnapshot: null,
    }),
  });
  expect(mocks.reminders.updateMany).toHaveBeenCalledWith({
    where: {
      storeId: "store",
      request: { storeId: "store" },
      attempts: 0,
      status: { in: ["queued", "sending", "failed"] },
    },
    data: expect.objectContaining({
      status: "cancelled",
      outcomeReason: "settings_disabled",
      encryptedDeliverySnapshot: null,
    }),
  });
});
it.each([-1, 1.5, 2147483647, NaN])(
  "contains invalid/exhausted stored revision %s",
  async (collectionRevision) => {
    mocks.settings.findUnique.mockResolvedValue({
      ...previous,
      collectionRevision,
    });
    await expect(
      updateReviewCollectionInTransaction(tx, "store", patch),
    ).rejects.toThrow("revision unavailable");
    expect(mocks.settings.upsert).not.toHaveBeenCalled();
  },
);

it("does not move the cutoff when editing already-enabled collection", async () => {
  mocks.settings.findUnique.mockResolvedValue({
    ...previous,
    requestEmailEnabled: true,
  });
  await updateReviewCollectionInTransaction(tx, "store", patch);
  expect(mocks.settings.upsert.mock.calls[0][0].update).not.toHaveProperty(
    "activatedAt",
  );
});
