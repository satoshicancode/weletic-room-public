import {
  disableReviewRemindersInTransaction as disable,
  eraseReviewReminderMaterialInTransaction as erase,
} from "@/lib/weletic/reviews/reminder-retention";
import { beforeEach, expect, it, vi } from "vitest";

const reminders = vi.fn();
const requests = vi.fn();
const tx = {
  weleticReviewReminder: { updateMany: reminders },
  weleticReviewRequest: { updateMany: requests },
} as any;
beforeEach(() => vi.resetAllMocks());
it.each([
  "submitted",
  "expired",
  "privacy",
  "settings_disabled",
  "purchase_ineligible",
] as const)(
  "erases private material for %s without changing sent outcomes or financial records",
  async (reason) => {
    await erase(tx, { storeId: "store", requestIds: ["request"], reason });
    expect(reminders).toHaveBeenNthCalledWith(1, {
      where: {
        storeId: "store",
        requestId: { in: ["request"] },
        request: { storeId: "store", id: { in: ["request"] } },
        status: { in: ["queued", "sending", "failed"] },
        attempts: 0,
      },
      data: {
        status: "cancelled",
        settledAt: expect.any(Date),
        outcomeReason: reason,
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
    expect(reminders.mock.calls[1][0]).toMatchObject({
      where: {
        attempts: { gt: 0 },
        storeId: "store",
        requestId: { in: ["request"] },
      },
      data: {
        status: "reconciliation",
        outcomeReason: `${reason}_delivery_unconfirmed`,
        leaseToken: null,
      },
    });
    expect(reminders.mock.calls[2][0].data).toEqual({
      encryptedDeliverySnapshot: null,
    });
    expect(requests).toHaveBeenCalledWith({
      where: { storeId: "store", id: { in: ["request"] } },
      data: { encryptedReminderToken: null },
    });
  },
);
it("settings disable distinguishes unattempted cancellation from prior ambiguous delivery", async () => {
  await disable(tx, "store");
  expect(reminders.mock.calls[0][0]).toMatchObject({
    where: { storeId: "store", attempts: 0 },
    data: { status: "cancelled" },
  });
  expect(reminders.mock.calls[1][0]).toMatchObject({
    where: { storeId: "store", attempts: { gt: 0 } },
    data: {
      status: "reconciliation",
      outcomeReason: "settings_disabled_delivery_unconfirmed",
      encryptedDeliverySnapshot: null,
    },
  });
});
it.each([
  [],
  [""],
  ["same", "same"],
  Array.from({ length: 101 }, (_, i) => String(i)),
])(
  "rejects unbounded or ambiguous request identity %#",
  async (...requestIds) => {
    await expect(
      erase(tx, { storeId: "store", requestIds, reason: "privacy" }),
    ).rejects.toThrow();
    expect(reminders).not.toHaveBeenCalled();
    expect(requests).not.toHaveBeenCalled();
  },
);
