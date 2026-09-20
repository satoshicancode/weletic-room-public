import { OpenPhotoReconciliationRequired } from "@/lib/weletic/reviews/open-media-errors";
import { reserveOpenReviewPhotoInTransaction } from "@/lib/weletic/reviews/open-media-reservation";
import { Prisma } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ enqueue: vi.fn() }));
vi.mock("@/lib/weletic/loyalty/outbox", () => ({
  enqueueOutboxJob: mocks.enqueue,
}));
const scope = {
  storeId: "store",
  shopperId: "shopper",
  installationGeneration: "g1",
  source: "app_proxy" as const,
};
const input = {
  submissionId: "12345678-1234-4123-8123-123456789012",
  uploadId: "12345678-1234-4123-8123-123456789013",
  productId: "gid://shopify/Product/123",
  expectedInstallationGeneration: "g1",
  expectedSettingsRevision: 1,
  contentType: "image/png" as const,
};
const evidence = {
  submissionKey: "s".repeat(64),
  idempotencyKey: "i".repeat(64),
  contentDigest: "c".repeat(64),
};
const now = new Date("2026-09-20T12:00:00Z");
let previous: object[];
let accepted: object[];
let slots: object[];
let recent: object[];
let clock: Date;
const query = vi.fn();
const createMedia = vi.fn();
const createOwner = vi.fn();
const tx = {
  $queryRaw: query,
  weleticReviewMedia: { create: createMedia },
  weleticOpenReviewMediaOwnership: { create: createOwner },
} as unknown as Prisma.TransactionClient;
const run = () =>
  reserveOpenReviewPhotoInTransaction({
    tx,
    scope,
    input,
    evidence,
    productId: "product",
    sizeBytes: 100,
    maxSubmissionsPer24Hours: 3,
  });
const original = () => ({
  id: "wrevmedia_photo",
  mediaStoreId: "store",
  requestId: null,
  reviewId: null,
  objectKey: "weletic/reviews/store/wrevmedia_photo.webp",
  status: "reserved",
  storageWriteState: "not_started",
  uploadExpiresAt: new Date(now.getTime() + 1000),
  shopperId: "shopper",
  productId: "product",
  installationGeneration: "g1",
  source: "app_proxy",
  ...evidence,
  settingsRevision: 1,
  redactedAt: null,
  sizeBytes: 100,
  contentType: "image/webp",
});
beforeEach(() => {
  vi.resetAllMocks();
  previous = [];
  accepted = [];
  slots = [];
  recent = [];
  clock = now;
  query.mockImplementation((sql: Prisma.Sql) => {
    const text = sql.strings.join("?");
    if (text.includes("CURRENT_TIMESTAMP")) return [{ now: clock }];
    if (text.includes("o.idempotencyKey")) return previous;
    if (text.includes("WeleticOpenReviewSubmission")) return accepted;
    if (text.includes("o.submissionKey =")) return slots;
    if (text.includes("createdAt >")) return recent;
    throw new Error("Unexpected query");
  });
});
it("signals recovery only after exact ownership and bytes match", async () => {
  previous = [{ ...original(), storageWriteState: "ambiguous" }];
  await expect(run()).rejects.toBeInstanceOf(OpenPhotoReconciliationRequired);
  previous = [
    { ...original(), storageWriteState: "ambiguous", contentDigest: "changed" },
  ];
  await expect(run()).rejects.toMatchObject({ code: "conflict" });
  previous = [
    { ...original(), storageWriteState: "ambiguous", shopperId: "foreign" },
  ];
  await expect(run()).rejects.toMatchObject({ code: "not_found" });
  previous = [
    { ...original(), storageWriteState: "ambiguous", redactedAt: now },
  ];
  await expect(run()).rejects.toMatchObject({ code: "not_found" });
});
it("atomically reserves private media, owner provenance and deadline cleanup", async () => {
  const result = await run();
  expect(result).toMatchObject({
    status: "reserved",
    reviewId: null,
    uploadExpiresAt: new Date(now.getTime() + 86_400_000),
  });
  expect(createMedia).toHaveBeenCalledWith({
    data: expect.objectContaining({
      id: result.id,
      storeId: "store",
      requestId: null,
      reviewId: null,
      contentType: "image/webp",
      sizeBytes: 100,
    }),
  });
  expect(createOwner).toHaveBeenCalledWith({
    data: expect.objectContaining({
      storeId: "store",
      mediaId: result.id,
      shopperId: "shopper",
      productId: "product",
      installationGeneration: "g1",
      source: "app_proxy",
      ...evidence,
      settingsRevision: 1,
    }),
  });
  expect(mocks.enqueue).toHaveBeenCalledWith({
    tx,
    storeId: "store",
    jobType: "REVIEW_MEDIA_CLEANUP",
    payload: { mediaId: result.id },
    idempotencyKey: `review_media_expiry:${result.id}`,
    scheduledFor: result.uploadExpiresAt,
  });
  expect(
    query.mock.calls
      .map(([sql]) => (sql as Prisma.Sql).strings.join("?"))
      .slice(1)
      .every((sql) => sql.includes("FOR UPDATE")),
  ).toBe(true);
});
it.each(["reserved", "uploaded"])(
  "replays %s before budgets without allocating again",
  async (status) => {
    previous = [
      {
        ...original(),
        status,
        storageWriteState: status === "uploaded" ? "confirmed" : "not_started",
      },
    ];
    slots = Array(5).fill({ id: "slot" });
    recent = Array(15).fill({ id: "attempt" });
    expect(await run()).toMatchObject({ id: "wrevmedia_photo", status });
    expect(createMedia).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  },
);
it.each([
  { mediaStoreId: "foreign" },
  { requestId: "invitation" },
  { reviewId: "already-attached" },
  { shopperId: "other" },
  { productId: "other" },
  { installationGeneration: "old" },
  { source: "forged" },
  { redactedAt: now },
  { contentDigest: null },
  { status: "deleted" },
  { status: "deletion_pending" },
  { uploadExpiresAt: now },
  { objectKey: "another-private-object" },
  { contentType: "image/svg+xml" },
])("rejects revoked, mixed or foreign ownership %j", async (patch) => {
  previous = [{ ...original(), ...patch }];
  await expect(run()).rejects.toMatchObject({ code: "not_found" });
  expect(createMedia).not.toHaveBeenCalled();
});
it.each([
  { contentDigest: "changed" },
  { submissionKey: "changed" },
  { settingsRevision: 2 },
  { sizeBytes: 101 },
])("rejects upload identity reuse %j", async (patch) => {
  previous = [{ ...original(), ...patch }];
  await expect(run()).rejects.toMatchObject({ code: "conflict" });
});
it("rejects completed submissions, five slots and daily attempt exhaustion", async () => {
  accepted = [{ id: "review" }];
  await expect(run()).rejects.toMatchObject({ code: "conflict" });
  accepted = [];
  slots = Array(5).fill({ id: "slot" });
  await expect(run()).rejects.toMatchObject({ code: "bad_request" });
  slots = [];
  recent = Array(15).fill({ id: "attempt" });
  await expect(run()).rejects.toMatchObject({ code: "unavailable" });
  const quotaQuery = query.mock.calls.at(-1)![0] as Prisma.Sql;
  expect(quotaQuery.values).toEqual([
    "store",
    "shopper",
    new Date(now.getTime() - 86_400_000),
    15,
  ]);
  expect(createMedia).not.toHaveBeenCalled();
});
it("propagates owner/outbox failures to roll the entire reservation back", async () => {
  createOwner.mockRejectedValueOnce(new Error("owner failed"));
  await expect(run()).rejects.toThrow("owner failed");
  expect(mocks.enqueue).not.toHaveBeenCalled();
  mocks.enqueue.mockRejectedValue(new Error("queue failed"));
  await expect(run()).rejects.toThrow("queue failed");
});
