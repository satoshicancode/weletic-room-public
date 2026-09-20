import { exportReviewMediaPage } from "@/lib/weletic/reviews/media-export-checkpoint";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  store: vi.fn(),
  rows: vi.fn(),
  file: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { weleticReviewMedia: { findMany: mocks.rows } },
}));
vi.mock("@/lib/weletic/shopify/compliance-artifacts", () => ({
  readComplianceMediaCheckpoint: mocks.read,
  storeEncryptedComplianceArtifact: mocks.store,
}));
vi.mock("@/lib/weletic/reviews/media-file-export", () => ({
  exportReviewMediaFile: mocks.file,
  reviewMediaFileExportSelect: { id: true },
  reviewMediaFileExportWhere: (storeId: string, shopperId: string) => ({
    storeId,
    shopperId,
  }),
}));

const input = {
  requestId: "request_1",
  storeId: "store_1",
  shopperId: "shopper_1",
  sequence: 0,
  afterId: null,
  expiresAt: new Date("2030-01-01"),
  lease: { workerId: "worker_1", leaseVersion: 1 },
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.read.mockResolvedValue(null);
  mocks.rows.mockResolvedValue([]);
  mocks.file.mockImplementation(async (_store, _shopper, row) => ({
    id: row.id,
    data: "cGhvdG8=",
  }));
});
it("recovers the committed file cursor after crash even when the live page changed", async () => {
  const committed = new Map<number, unknown>();
  mocks.read.mockImplementation(
    async ({ sequence }) => committed.get(sequence) ?? null,
  );
  mocks.store.mockImplementation(async ({ sequence, value }) => {
    committed.set(sequence, value);
    if (sequence === 0) throw new Error("lost publication acknowledgement");
  });
  mocks.rows.mockResolvedValueOnce([{ id: "A" }, { id: "B" }]);
  await expect(exportReviewMediaPage(input)).rejects.toThrow(
    "lost publication acknowledgement",
  );
  // A is no longer eligible. Retry must not select/read B as sequence 0.
  mocks.rows.mockResolvedValue([{ id: "B" }, { id: "C" }]);
  expect(await exportReviewMediaPage(input)).toEqual({
    fileId: "A",
    hasMore: true,
  });
  expect(mocks.rows).toHaveBeenCalledTimes(1);
  expect(mocks.file).toHaveBeenCalledTimes(1);
  expect(
    await exportReviewMediaPage({ ...input, sequence: 1, afterId: "A" }),
  ).toEqual({ fileId: "B", hasMore: true });
  expect(mocks.rows.mock.calls[1][0].where).toEqual({
    storeId: "store_1",
    shopperId: "shopper_1",
    id: { gt: "A" },
  });
  expect(
    [...committed.values()].map((chunk: any) => chunk.files[0].id),
  ).toEqual(["A", "B"]);
});
it("uses the actual immutable publication winner rather than the selected row", async () => {
  mocks.rows.mockResolvedValue([{ id: "B" }]);
  mocks.read
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({
      format: "review_media_files_v1",
      sequence: 0,
      afterId: null,
      hasMore: true,
      files: [{ id: "A" }],
    });
  expect(await exportReviewMediaPage(input)).toEqual({
    fileId: "A",
    hasMore: true,
  });
});
it.each([
  [{ id: "A", downloadUrl: "legacy-url" }],
  {
    format: "review_media_files_v1",
    sequence: 1,
    afterId: null,
    hasMore: true,
    files: [{ id: "A" }],
  },
  {
    format: "review_media_files_v1",
    sequence: 0,
    afterId: "other",
    hasMore: true,
    files: [{ id: "A" }],
  },
])(
  "rejects incompatible checkpoint without fetching a new page",
  async (value) => {
    mocks.read.mockResolvedValue(value);
    await expect(exportReviewMediaPage(input)).rejects.toThrow(
      "checkpoint is invalid",
    );
    expect(mocks.rows).not.toHaveBeenCalled();
  },
);
it("does not advance when publication cannot be resolved", async () => {
  mocks.rows.mockResolvedValue([{ id: "A" }]);
  await expect(exportReviewMediaPage(input)).rejects.toThrow(
    "publication is unresolved",
  );
});
it("does not query another subject when there is no resolved shopper", async () => {
  expect(await exportReviewMediaPage({ ...input, shopperId: null })).toEqual({
    fileId: null,
    hasMore: false,
  });
  expect(mocks.rows).not.toHaveBeenCalled();
});
