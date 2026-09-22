import { ReviewRequestEmailPayloadSchema } from "@/lib/weletic/loyalty/outbox";
import { executeNativeReviewJob } from "@/lib/weletic/reviews/worker";
import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ initial: vi.fn(), reminder: vi.fn() }));
vi.mock("@/lib/weletic/reviews/email", () => ({
  deliverReviewRequest: m.initial,
}));
vi.mock("@/lib/weletic/reviews/reminder-email", () => ({
  deliverReviewReminder: m.reminder,
}));
vi.mock("@/lib/weletic/reviews/media", () => ({ cleanupReviewPhoto: vi.fn() }));
vi.mock("@/lib/weletic/reviews/summary-sync", () => ({
  enqueueReviewSummaryPage: vi.fn(),
  syncProductReviewSummary: vi.fn(),
}));
const payload = {
  requestId: "request",
  reminderId: `wrevrem_${"x".repeat(20)}`,
  installationGeneration: "g1",
};
beforeEach(() => vi.resetAllMocks());
it("dispatches an explicit reminder without ever invoking initial invitation delivery", async () => {
  await executeNativeReviewJob({
    storeId: "store",
    jobType: "REVIEW_REQUEST_EMAIL",
    payload,
  } as never);
  expect(m.reminder).toHaveBeenCalledWith({ storeId: "store", ...payload });
  expect(m.initial).not.toHaveBeenCalled();
});
it("preserves legacy initial invitation dispatch", async () => {
  await executeNativeReviewJob({
    storeId: "store",
    jobType: "REVIEW_REQUEST_EMAIL",
    payload: { requestId: "request" },
  } as never);
  expect(m.initial).toHaveBeenCalledWith("store", "request", null);
  expect(m.reminder).not.toHaveBeenCalled();
});
it.each([
  { ...payload, installationGeneration: undefined },
  { ...payload, installationGeneration: null },
  { ...payload, reminderId: "malformed" },
  { ...payload, token: "private-token" },
])("rejects invalid reminder payloads before dispatch", async (value) => {
  expect(ReviewRequestEmailPayloadSchema.safeParse(value).success).toBe(false);
  await expect(
    executeNativeReviewJob({
      storeId: "store",
      jobType: "REVIEW_REQUEST_EMAIL",
      payload: value,
    } as never),
  ).rejects.toThrow();
  expect(m.reminder).not.toHaveBeenCalled();
  expect(m.initial).not.toHaveBeenCalled();
});
