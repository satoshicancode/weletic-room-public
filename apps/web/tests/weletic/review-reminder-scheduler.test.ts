import { enqueueReviewReminderJobs as schedule } from "@/lib/weletic/reviews/reminder-scheduler";
import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  scan: vi.fn(),
  rotate: vi.fn(),
  find: vi.fn(),
  settings: vi.fn(),
  enqueue: vi.fn(),
  mutation: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: m.scan,
    weleticReviewReminder: { updateMany: m.rotate },
  },
}));
vi.mock("@/lib/weletic/loyalty/outbox", () => ({
  enqueueOutboxJobFromProgramTransaction: m.enqueue,
}));
vi.mock("@/lib/weletic/reviews/transaction", () => ({
  withReviewMutation: m.mutation,
}));
const tx = {
  weleticReviewReminder: { findFirst: m.find },
  weleticReviewSettings: { findUnique: m.settings },
};
const row = {
  id: `wrevrem_${"x".repeat(20)}`,
  storeId: "store",
  requestId: "request",
  installationGeneration: "g1",
  scheduledFor: new Date("2026-10-01T00:00:00Z"),
};
beforeEach(() => {
  vi.resetAllMocks();
  m.scan.mockResolvedValue([row]);
  m.rotate.mockResolvedValue({ count: 1 });
  m.find.mockResolvedValue(row);
  m.settings.mockResolvedValue({ enabled: true, requestEmailEnabled: true });
  m.mutation.mockImplementation((_store, fn) => fn(tx, "g1"));
  m.enqueue.mockResolvedValue({ created: true });
});
it("discovers durable unqueued intents and queues under the saved generation", async () => {
  expect(await schedule({ batchSize: 3 })).toEqual({
    scanned: 1,
    enqueued: 1,
    alreadyQueued: 0,
    deferred: 0,
  });
  expect(m.mutation).toHaveBeenCalledWith("store", expect.any(Function), "g1");
  expect(m.enqueue).toHaveBeenCalledWith({
    tx,
    storeId: "store",
    jobType: "REVIEW_REQUEST_EMAIL",
    payload: {
      requestId: "request",
      reminderId: row.id,
      installationGeneration: "g1",
    },
    idempotencyKey: `review_reminder_email:${row.id}`,
    scheduledFor: row.scheduledFor,
  });
  const query = m.scan.mock.calls[0][0];
  expect(query.sql).toContain("j.id IS NULL");
  expect(query.sql).toContain(
    "s.installationGeneration = r.installationGeneration",
  );
  expect(query.values).toContain(3);
});
it("rotates a full failing page so later intents can be scheduled", async () => {
  const rows = [
    { ...row, id: "invalid-a", checked: 0 },
    { ...row, id: "invalid-b", checked: 1 },
    { ...row, checked: 2 },
  ];
  const done = new Set<string>();
  m.scan.mockImplementation(async () =>
    rows
      .filter((r) => !done.has(r.id))
      .sort((a, b) => a.checked - b.checked)
      .slice(0, 2),
  );
  m.rotate.mockImplementation(async ({ where, data }) => {
    rows.find((r) => r.id === where.id)!.checked = data.updatedAt.getTime();
    return { count: 1 };
  });
  m.find.mockImplementation(async ({ where }) =>
    rows.find((r) => r.id === where.id),
  );
  m.enqueue.mockImplementation(async ({ payload }) => {
    if (payload.reminderId.startsWith("invalid"))
      throw new Error("malformed source");
    done.add(payload.reminderId);
    return { created: true };
  });
  expect(await schedule({ batchSize: 2, now: new Date(1000) })).toMatchObject({
    enqueued: 0,
    deferred: 2,
  });
  expect(await schedule({ batchSize: 2, now: new Date(2000) })).toMatchObject({
    enqueued: 1,
    deferred: 1,
  });
});
it("does not recreate existing jobs, including dead letters", async () => {
  m.enqueue.mockResolvedValue({ created: false });
  expect(await schedule()).toMatchObject({ enqueued: 0, alreadyQueued: 1 });
});
it("leaves intents discoverable after a transient fence or queue failure", async () => {
  m.enqueue.mockRejectedValue(new Error("private data"));
  expect(await schedule()).toEqual({
    scanned: 1,
    enqueued: 0,
    alreadyQueued: 0,
    deferred: 1,
  });
});
it.each(["missing", "disabled"])(
  "rechecks %s state before enqueue",
  async (state) => {
    if (state === "missing") m.find.mockResolvedValue(null);
    else
      m.settings.mockResolvedValue({
        enabled: true,
        requestEmailEnabled: false,
      });
    expect(await schedule()).toMatchObject({ deferred: 1 });
    expect(m.enqueue).not.toHaveBeenCalled();
  },
);
it.each([0, 101, NaN, 1.5])("rejects unbounded batch %s", async (batchSize) => {
  await expect(schedule({ batchSize })).rejects.toThrow();
  expect(m.scan).not.toHaveBeenCalled();
});
