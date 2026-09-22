import { finalizeReviewDeliveryInTransaction as finalize } from "@/lib/weletic/reviews/delivery-finalization";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock("@/lib/weletic/reviews/reminder-production", () => ({
  prepareReviewRemindersInTransaction: mocks.prepare,
}));
const lock = vi.fn();
const update = vi.fn();
const tx = {
  $queryRaw: lock,
  weleticReviewRequest: { updateMany: update },
} as any;
const input = {
  storeId: "store",
  requestId: "request",
  leaseToken: "winning-lease",
  installationGeneration: "g1",
  invitationToken: "a".repeat(43),
};
beforeEach(() => {
  vi.resetAllMocks();
  update.mockResolvedValue({ count: 1 });
});
it("finalizes the exact initial lease and prepares reminders in the same transaction", async () => {
  await finalize(tx, input);
  expect(update).toHaveBeenCalledWith({
    where: {
      id: "request",
      storeId: "store",
      installationGeneration: "g1",
      status: "sending",
      deliveryToken: "winning-lease",
    },
    data: {
      status: "sent",
      sentAt: expect.any(Date),
      deliveryToken: null,
      deliveryLeaseExpiresAt: null,
      encryptedDeliveryToken: null,
      encryptedDeliverySnapshot: null,
      lastError: null,
    },
  });
  expect(lock.mock.invocationCallOrder[0]).toBeLessThan(
    update.mock.invocationCallOrder[0],
  );
  expect(update.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.prepare.mock.invocationCallOrder[0],
  );
  expect(mocks.prepare).toHaveBeenCalledWith(tx, {
    storeId: "store",
    requestId: "request",
    installationGeneration: "g1",
    token: input.invitationToken,
  });
});
it("does not prepare reminders when cancellation or replacement wins", async () => {
  update.mockResolvedValue({ count: 0 });
  await expect(finalize(tx, input)).rejects.toThrow("lease lost");
  expect(mocks.prepare).not.toHaveBeenCalled();
});
it("propagates preparation failure so the caller rolls back initial finalization", async () => {
  mocks.prepare.mockRejectedValue(new Error("reconciliation required"));
  await expect(finalize(tx, input)).rejects.toThrow("reconciliation required");
});
it("never adds reminders to a legacy installation without generation identity", async () => {
  await finalize(tx, { ...input, installationGeneration: null });
  expect(update.mock.calls[0][0].where.installationGeneration).toBeNull();
  expect(mocks.prepare).not.toHaveBeenCalled();
});
it.each([
  { leaseToken: "" },
  { invitationToken: "bad" },
  { installationGeneration: "" },
  { requestId: "" },
  { storeId: "" },
])(
  "rejects missing or malformed authority before writing %j",
  async (patch) => {
    await expect(finalize(tx, { ...input, ...patch })).rejects.toThrow();
    expect(lock).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  },
);
