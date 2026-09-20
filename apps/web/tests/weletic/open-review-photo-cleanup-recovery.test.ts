import { cleanupReviewPhoto } from "@/lib/weletic/reviews/media";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  query: vi.fn(),
  claim: vi.fn(),
  finish: vi.fn(),
  reconcile: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    weleticReviewMedia: { updateMany: mocks.finish },
  },
}));
vi.mock("@/lib/storage", () => ({ storage: { delete: mocks.remove } }));
vi.mock("@/lib/weletic/redis-lock", () => ({
  withDistributedLock: ({ fn }: { fn: () => unknown }) => fn(),
}));
vi.mock("@/lib/weletic/reviews/open-media-reconciliation", () => ({
  reconcileOpenReviewPhotoStorage: mocks.reconcile,
}));
vi.mock("@/lib/weletic/reviews/requests", () => ({
  readUsableReviewRequest: vi.fn(),
}));
let state: string;
let row: {
  id: string;
  storeId: string;
  requestId: string | null;
  reviewId: string | null;
  status: string;
  objectKey: string;
  uploadExpiresAt: Date;
};
const run = () => cleanupReviewPhoto("store", "media");
beforeEach(() => {
  vi.resetAllMocks();
  state = "ambiguous";
  row = {
    id: "media",
    storeId: "store",
    requestId: null,
    reviewId: null,
    status: "reserved",
    objectKey: "weletic/reviews/store/media.webp",
    uploadExpiresAt: new Date(0),
  };
  mocks.transaction.mockImplementation((fn) =>
    fn({
      $queryRaw: mocks.query,
      weleticReviewMedia: { updateMany: mocks.claim },
    }),
  );
  mocks.query.mockImplementation((sql) =>
    sql.strings.join("?").includes("FROM WeleticReviewMedia")
      ? [{ ...row }]
      : [{ storageWriteState: state }],
  );
  mocks.claim.mockResolvedValue({ count: 1 });
  mocks.finish.mockResolvedValue({ count: 1 });
  mocks.reconcile.mockResolvedValue({ status: "unresolved" });
  for (const name of [
    "STORAGE_ENDPOINT",
    "STORAGE_PRIVATE_BUCKET",
    "STORAGE_ACCESS_KEY_ID",
    "STORAGE_SECRET_ACCESS_KEY",
  ])
    vi.stubEnv(name, "synthetic-cleanup-fixture");
});
afterEach(() => vi.unstubAllEnvs());
it("keeps missing evidence retryable without declaring deletion", async () => {
  await expect(run()).rejects.toThrow("requires reconciliation");
  expect(mocks.reconcile).toHaveBeenCalledExactlyOnceWith("store", "media");
  expect(mocks.claim).not.toHaveBeenCalled();
  expect(mocks.remove).not.toHaveBeenCalled();
});
it("rechecks original cleanup guards after confirmation then deletes once", async () => {
  mocks.reconcile.mockImplementation(() => {
    state = "confirmed";
    return { status: "confirmed" };
  });
  await run();
  expect(mocks.transaction).toHaveBeenCalledTimes(2);
  expect(mocks.remove).toHaveBeenCalledExactlyOnceWith({
    key: row.objectKey,
    bucket: "private",
  });
  expect(mocks.finish).toHaveBeenCalledWith({
    where: { id: "media", storeId: "store", status: "deletion_pending" },
    data: { status: "deleted" },
  });
});
it("positive evidence does not make an unexpired upload due for deletion", async () => {
  row.uploadExpiresAt = new Date(Date.now() + 86400000);
  mocks.reconcile.mockImplementation(() => {
    state = "confirmed";
    return { status: "confirmed" };
  });
  await expect(run()).rejects.toThrow("not due");
  expect(mocks.remove).not.toHaveBeenCalled();
});
it("positive evidence does not erase a concurrently attached photo", async () => {
  mocks.reconcile.mockImplementation(() => {
    state = "confirmed";
    row.reviewId = "review";
    row.status = "uploaded";
    return { status: "confirmed" };
  });
  await run();
  expect(mocks.remove).not.toHaveBeenCalled();
});
it("sanitizes provider errors and does not recover mixed ownership", async () => {
  mocks.reconcile.mockRejectedValue(new Error("private provider diagnostics"));
  await expect(run()).rejects.toThrow("requires reconciliation");
  mocks.reconcile.mockClear();
  row.requestId = "invitation";
  await expect(run()).rejects.toThrow("requires reconciliation");
  expect(mocks.reconcile).not.toHaveBeenCalled();
  expect(mocks.remove).not.toHaveBeenCalled();
});
it("leaves settled legacy cleanup behavior unchanged", async () => {
  state = "confirmed";
  await run();
  expect(mocks.reconcile).not.toHaveBeenCalled();
  expect(mocks.remove).toHaveBeenCalledTimes(1);
});
