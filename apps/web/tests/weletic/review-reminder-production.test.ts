import { hashReviewToken } from "@/lib/weletic/reviews/contracts";
import { prepareReviewRemindersInTransaction as prepare } from "@/lib/weletic/reviews/reminder-production";
import { beforeEach, expect, it, vi } from "vitest";
const enqueue = vi.hoisted(() => vi.fn());
vi.mock("@/lib/weletic/loyalty/outbox", () => ({ enqueueOutboxJob: enqueue }));

vi.mock("@/lib/encryption", () => ({ encrypt: () => "encrypted-only" }));
const find = vi.fn();
const upsert = vi.fn();
const update = vi.fn();
const tx = {
  weleticReviewRequest: { findFirst: find, updateMany: update },
  weleticReviewReminder: { upsert },
} as any;
const token = "a".repeat(43);
const input = {
  storeId: "store",
  requestId: "request",
  installationGeneration: "g1",
  token,
};
const row = () => ({
  status: "sent",
  sentAt: new Date(),
  expiresAt: new Date(Date.now() + 30 * 86400000),
  tokenHash: hashReviewToken(token),
  reminderSnapshot: {
    version: 1,
    collectionRevision: 2,
    expiresAfterDays: 30,
    reminderAfterDays: [3, 7],
  },
  store: {
    installationGeneration: "g1",
    complianceState: "active",
    storeAccessState: "active",
    reviewSettings: { enabled: true, requestEmailEnabled: true },
  },
});
beforeEach(() => {
  vi.resetAllMocks();
  find.mockResolvedValue(row());
  upsert.mockImplementation(async ({ create }) => ({
    ...create,
    status: "queued",
  }));
  update.mockResolvedValue({ count: 1 });
});
it("creates one stable logical delivery per saved sequence and retains only encrypted token material", async () => {
  expect(await prepare(tx, input)).toBe(2);
  expect(upsert).toHaveBeenCalledTimes(2);
  expect(upsert.mock.calls[0][0]).toMatchObject({
    where: {
      storeId_requestId_sequence: {
        storeId: "store",
        requestId: "request",
        sequence: 1,
      },
    },
    create: { installationGeneration: "g1", sequence: 1 },
    update: {},
  });
  expect(update.mock.calls[0][0].data).toEqual({
    encryptedReminderToken: "encrypted-only",
  });
  expect(JSON.stringify(upsert.mock.calls)).not.toContain(token);
  expect(enqueue).not.toHaveBeenCalled();
});
it.each(["queued", "sending", "failed", "submitted", "cancelled"])(
  "does not produce reminders before confirmed initial delivery or after %s",
  async (status) => {
    find.mockResolvedValue({ ...row(), status });
    expect(await prepare(tx, input)).toBe(0);
    expect(upsert).not.toHaveBeenCalled();
  },
);
it("does not revive terminal delivery rows", async () => {
  upsert.mockImplementation(async ({ create }) => ({
    ...create,
    status: "cancelled",
  }));
  expect(await prepare(tx, input)).toBe(0);
  expect(enqueue).not.toHaveBeenCalled();
  expect(update.mock.calls[0][0].data).toEqual({
    encryptedReminderToken: null,
  });
});
it("retains scheduling intent without depending on queue availability", async () => {
  enqueue.mockRejectedValue(new Error("queue unavailable"));
  expect(await prepare(tx, input)).toBe(2);
  expect(update).toHaveBeenCalledOnce();
  expect(enqueue).not.toHaveBeenCalled();
});
it("contains stale installation and disabled email", async () => {
  for (const patch of [
    { installationGeneration: "retired" },
    { storeAccessState: "pending_approval" },
    { reviewSettings: { enabled: true, requestEmailEnabled: false } },
  ]) {
    find.mockResolvedValue({ ...row(), store: { ...row().store, ...patch } });
    expect(await prepare(tx, input)).toBe(0);
  }
  expect(upsert).not.toHaveBeenCalled();
});
it("rejects a token from another invitation before retaining it", async () => {
  await expect(
    prepare(tx, { ...input, token: "b".repeat(43) }),
  ).rejects.toThrow("identity changed");
  expect(upsert).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
});
it("throws so the caller rolls back prepared rows when the invitation fence loses", async () => {
  update.mockResolvedValue({ count: 0 });
  await expect(prepare(tx, input)).rejects.toThrow(
    "changed during preparation",
  );
});
it("rejects a conflicting persisted schedule instead of updating its identity", async () => {
  upsert.mockImplementation(async ({ create }) => ({
    ...create,
    installationGeneration: "other",
  }));
  await expect(prepare(tx, input)).rejects.toThrow("reconciliation");
  expect(update).not.toHaveBeenCalled();
});
it("does not create reminders for expired invitations or historical null snapshots", async () => {
  find.mockResolvedValue({ ...row(), expiresAt: new Date(0) });
  expect(await prepare(tx, input)).toBe(0);
  find.mockResolvedValue({ ...row(), reminderSnapshot: null });
  expect(await prepare(tx, input)).toBe(0);
  expect(upsert).not.toHaveBeenCalled();
});
