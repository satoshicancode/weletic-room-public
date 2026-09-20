import { openPhotoUploadProof } from "@/lib/weletic/reviews/open-media-proof";
import { reconcileOpenReviewPhotoStorage } from "@/lib/weletic/reviews/open-media-reconciliation";
import { Prisma } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  query: vi.fn(),
  update: vi.fn(),
  head: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: mocks.transaction },
}));
vi.mock("@/lib/storage", () => ({
  storage: { headPrivateR2Object: mocks.head },
}));
const originalMedia = {
  id: "media",
  objectKey: "weletic/reviews/store/media.webp",
  sizeBytes: 12,
  contentType: "image/webp",
  requestId: null,
  reviewId: null,
  status: "reserved",
};
const originalOwner = {
  id: "owner",
  storageWriteState: "ambiguous",
  storageWriteToken: "ab".repeat(32),
  shopperId: "shopper",
  productId: "product",
  installationGeneration: "g1",
  source: "app_proxy",
  submissionKey: "submission",
  settingsRevision: 1,
};
let media: Record<string, unknown>;
let owner: Record<string, unknown>;
const tx = {
  $queryRaw: mocks.query,
  weleticOpenReviewMediaOwnership: { updateMany: mocks.update },
};
const metadata = {
  sizeBytes: 12,
  contentType: "image/webp",
  uploadProof: openPhotoUploadProof(
    "store",
    "media",
    originalOwner.storageWriteToken,
  ),
};
const run = () => reconcileOpenReviewPhotoStorage("store", "media");
beforeEach(() => {
  vi.resetAllMocks();
  media = { ...originalMedia };
  owner = { ...originalOwner };
  mocks.transaction.mockImplementation((fn) => fn(tx));
  mocks.query.mockImplementation((sql: Prisma.Sql) =>
    sql.strings.join("?").includes("FROM WeleticReviewMedia")
      ? [structuredClone(media)]
      : [structuredClone(owner)],
  );
  mocks.head.mockResolvedValue(metadata);
  mocks.update.mockResolvedValue({ count: 1 });
});
it("binds the opaque proof to domain/store/media/token without disclosing the token", () => {
  expect(metadata.uploadProof).toMatch(/^[a-f0-9]{64}$/);
  expect(metadata.uploadProof).not.toContain(originalOwner.storageWriteToken);
  expect(
    openPhotoUploadProof("other", "media", originalOwner.storageWriteToken),
  ).not.toBe(metadata.uploadProof);
  expect(
    openPhotoUploadProof("store", "other", originalOwner.storageWriteToken),
  ).not.toBe(metadata.uploadProof);
  expect(() => openPhotoUploadProof("store", "media", "legacy")).toThrow(
    "Invalid",
  );
});
it("confirms only a matching remote write without publishing or restoring content", async () => {
  expect(await run()).toEqual({ status: "confirmed" });
  expect(mocks.head).toHaveBeenCalledWith(originalMedia.objectKey);
  expect(mocks.transaction).toHaveBeenCalledTimes(2);
  expect(mocks.update).toHaveBeenCalledWith({
    where: {
      storeId: "store",
      mediaId: "media",
      id: "owner",
      storageWriteToken: originalOwner.storageWriteToken,
      storageWriteState: "ambiguous",
    },
    data: { storageWriteState: "confirmed" },
  });
  for (const [sql] of mocks.query.mock.calls)
    expect(sql.strings.join("?")).toContain("FOR UPDATE");
});
it.each([
  null,
  { ...metadata, uploadProof: null },
  { ...metadata, uploadProof: "cd".repeat(32) },
  { ...metadata, sizeBytes: 13 },
  { ...metadata, contentType: "image/png" },
])(
  "never treats missing/mismatched remote evidence as erasure or retry permission: %j",
  async (value) => {
    mocks.head.mockResolvedValue(value);
    expect(await run()).toEqual({ status: "unresolved" });
    expect(mocks.update).not.toHaveBeenCalled();
  },
);
it("provider errors do not change durable state", async () => {
  mocks.head.mockRejectedValue(new Error("timeout"));
  await expect(run()).rejects.toThrow("timeout");
  expect(mocks.update).not.toHaveBeenCalled();
});
it.each([
  { storageWriteToken: "cd".repeat(32) },
  { shopperId: "other" },
  { productId: "other" },
  { installationGeneration: "other" },
  { submissionKey: "other" },
  { settingsRevision: 2 },
  { storageWriteState: "not_started" },
])("rejects changed attempt/ownership during HEAD %j", async (patch) => {
  mocks.head.mockImplementation(async () => {
    Object.assign(owner, patch);
    return metadata;
  });
  await expect(run()).rejects.toThrow("changed during reconciliation");
  expect(mocks.update).not.toHaveBeenCalled();
});
it.each([{ reviewId: "review" }, { status: "deleted" }, { sizeBytes: 13 }])(
  "rejects changed media during HEAD %j",
  async (patch) => {
    mocks.head.mockImplementation(async () => {
      Object.assign(media, patch);
      return metadata;
    });
    await expect(run()).rejects.toThrow("changed during reconciliation");
    expect(mocks.update).not.toHaveBeenCalled();
  },
);
it("allows same-attempt timeout drift without overwriting concurrent confirmation", async () => {
  owner.storageWriteState = "in_flight";
  mocks.head.mockImplementation(async () => {
    owner.storageWriteState = "ambiguous";
    return metadata;
  });
  await run();
  expect(mocks.update.mock.calls[0][0].where.storageWriteState).toBe(
    "ambiguous",
  );
  mocks.update.mockClear();
  mocks.head.mockImplementation(async () => {
    owner.storageWriteState = "confirmed";
    return metadata;
  });
  await run();
  expect(mocks.update).not.toHaveBeenCalled();
});
it("preserves concurrent content erasure while retaining positive completion evidence", async () => {
  mocks.head.mockImplementation(async () => {
    owner.contentDigest = null;
    owner.redactedAt = new Date();
    return metadata;
  });
  await run();
  expect(mocks.update.mock.calls[0][0].data).toEqual({
    storageWriteState: "confirmed",
  });
});
it("fails closed on CAS loss and avoids remote reads for confirmed evidence", async () => {
  mocks.update.mockResolvedValue({ count: 0 });
  await expect(run()).rejects.toThrow("changed during reconciliation");
  mocks.head.mockClear();
  owner.storageWriteState = "confirmed";
  expect(await run()).toEqual({ status: "confirmed" });
  expect(mocks.head).not.toHaveBeenCalled();
});
