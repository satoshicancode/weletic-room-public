import { exportStoreReviewPage } from "@/lib/weletic/reviews/store-export-checkpoint";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  store: vi.fn(),
  reminders: vi.fn(),
  reviews: vi.fn(),
  requests: vi.fn(),
  audits: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticReviewReminder: { findMany: mocks.reminders },
    weleticStoreReview: { findMany: mocks.reviews },
    weleticStoreReviewRequest: { findMany: mocks.requests },
    weleticStoreReviewModerationAudit: { findMany: mocks.audits },
  },
}));
vi.mock("@/lib/weletic/shopify/compliance-artifacts", () => ({
  readComplianceReviewCheckpoint: mocks.read,
  storeEncryptedComplianceArtifact: mocks.store,
}));
const input = {
  requestId: "request",
  storeId: "store",
  shopperId: "shopper",
  kind: "store_reviews" as const,
  sequence: 0,
  afterId: null,
  expiresAt: new Date("2030-01-01"),
  lease: { workerId: "worker", leaseVersion: 1 },
};
const saved = {
  format: "store_review_rows_v1",
  kind: "store_reviews",
  sequence: 0,
  afterId: null,
  shopperId: "shopper",
  hasMore: true,
  rows: [{ id: "A" }],
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.read.mockResolvedValue(null);
  mocks.reminders.mockResolvedValue([]);
  mocks.reviews.mockResolvedValue([]);
  mocks.requests.mockResolvedValue([]);
  mocks.audits.mockResolvedValue([]);
});
it.each([
  "review_reminders",
  "store_reviews",
  "store_review_requests",
  "store_review_audits",
] as const)(
  "recovers %s after lost publication acknowledgement despite changed membership",
  async (kind) => {
    const query =
      kind === "review_reminders"
        ? mocks.reminders
        : kind === "store_reviews"
          ? mocks.reviews
          : kind === "store_review_requests"
            ? mocks.requests
            : mocks.audits;
    let published: unknown = null;
    mocks.read.mockImplementation(async () => published);
    mocks.store.mockImplementation(async ({ value }) => {
      published = value;
      throw new Error("lost acknowledgement");
    });
    query.mockResolvedValue(
      Array.from({ length: 21 }, (_, n) => ({
        id: `A${String(n).padStart(2, "0")}`,
      })),
    );
    await expect(exportStoreReviewPage({ ...input, kind })).rejects.toThrow(
      "lost acknowledgement",
    );
    // First and boundary rows are deleted; a newly inserted row changes the page.
    query.mockResolvedValue([{ id: "A01" }, { id: "A18x" }, { id: "A20" }]);
    expect(await exportStoreReviewPage({ ...input, kind })).toEqual({
      lastId: "A19",
      count: 20,
      hasMore: true,
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(mocks.store).toHaveBeenCalledTimes(1);
  },
);
it("uses the actual winning artifact instead of the losing page", async () => {
  mocks.reviews.mockResolvedValue([{ id: "B" }]);
  mocks.read.mockResolvedValueOnce(null).mockResolvedValueOnce(saved);
  expect(await exportStoreReviewPage(input)).toEqual({
    lastId: "A",
    count: 1,
    hasMore: true,
  });
});
it.each([
  { sequence: 1 },
  { kind: "store_review_requests" },
  { afterId: "other" },
  { shopperId: "other" },
  { rows: [] },
  { format: "unknown" },
])("rejects incompatible saved checkpoints: %j", async (change) => {
  mocks.read.mockResolvedValue({ ...saved, ...change });
  await expect(exportStoreReviewPage(input)).rejects.toThrow(
    "checkpoint invalid",
  );
  expect(mocks.reviews).not.toHaveBeenCalled();
});
it("uses keyset continuation when the preceding row has been deleted", async () => {
  await exportStoreReviewPage({ ...input, afterId: "deleted-row" });
  expect(mocks.reviews).toHaveBeenCalledWith(
    expect.objectContaining({
      where: {
        storeId: "store",
        shopperId: "shopper",
        id: { gt: "deleted-row" },
      },
      take: 21,
    }),
  );
  expect(mocks.reviews.mock.calls[0][0]).not.toHaveProperty("cursor");
});
it.each([
  { rows: [{ id: "A" }, { id: "A" }], afterId: null },
  { rows: [{ id: "A" }], afterId: "A" },
])("rejects duplicate or repeated cursor rows", async ({ rows, afterId }) => {
  mocks.read.mockResolvedValue({ ...saved, rows, afterId });
  await expect(exportStoreReviewPage({ ...input, afterId })).rejects.toThrow(
    "does not advance",
  );
  expect(mocks.reviews).not.toHaveBeenCalled();
});
it("does not advance if publication cannot be recovered", async () => {
  mocks.reviews.mockResolvedValue([{ id: "A" }]);
  await expect(exportStoreReviewPage(input)).rejects.toThrow(
    "publication unresolved",
  );
});
it.each([-1, NaN, 1.5, 2147483647, Number.MAX_SAFE_INTEGER])(
  "rejects invalid sequence %s before IO",
  async (sequence) => {
    await expect(exportStoreReviewPage({ ...input, sequence })).rejects.toThrow(
      "sequence invalid",
    );
    expect(mocks.read).not.toHaveBeenCalled();
  },
);

it("exports reminders only through same-store customer-owned requests without private transport material", async () => {
  await exportStoreReviewPage({
    ...input,
    kind: "review_reminders",
    afterId: "prior",
  });
  const query = mocks.reminders.mock.calls[0][0];
  expect(query.where).toEqual({
    storeId: "store",
    request: { storeId: "store", shopperId: "shopper" },
    id: { gt: "prior" },
  });
  expect(query.take).toBe(21);
  expect(Object.keys(query.select).sort()).toEqual(
    [
      "id",
      "requestId",
      "sequence",
      "scheduledFor",
      "status",
      "sentAt",
      "settledAt",
      "outcomeReason",
      "createdAt",
    ].sort(),
  );
});
