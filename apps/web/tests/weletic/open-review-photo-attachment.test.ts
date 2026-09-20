import { attachOpenReviewPhotos } from "@/lib/weletic/reviews/open-media-attachment";
import { Prisma } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";

const query = vi.fn();
const update = vi.fn();
const tx = {
  $queryRaw: query,
  $executeRaw: update,
} as unknown as Prisma.TransactionClient;
const scope = {
  storeId: "store",
  shopperId: "shopper",
  installationGeneration: "g1",
  source: "app_proxy" as const,
};
const mediaId = "wrevmedia_one";
let settings: object[];
let media: object[];
let owners: object[];
const owner = {
  mediaId,
  shopperId: "shopper",
  productId: "product",
  installationGeneration: "g1",
  submissionKey: "submission",
  settingsRevision: 2,
  source: "customer_account",
  redactedAt: null,
  contentDigest: "digest",
  storageWriteState: "confirmed",
};
const run = (mediaIds = [mediaId]) =>
  attachOpenReviewPhotos({
    tx,
    scope,
    productId: "product",
    submissionKey: "submission",
    settingsRevision: 2,
    reviewId: "review",
    mediaIds,
  });
beforeEach(() => {
  vi.resetAllMocks();
  settings = [{ photoUploadsEnabled: true }];
  media = [
    {
      id: mediaId,
      objectKey: `weletic/reviews/store/${mediaId}.webp`,
      contentType: "image/webp",
      sizeBytes: 12,
    },
  ];
  owners = [{ ...owner }];
  query.mockImplementation((sql: Prisma.Sql) => {
    const statement = sql.strings.join("?");
    if (statement.includes("FROM WeleticReviewSettings")) return settings;
    if (statement.includes("FROM WeleticReviewMedia")) return media;
    if (statement.includes("FROM WeleticOpenReviewMediaOwnership"))
      return owners;
    throw new Error("Unexpected query");
  });
  update.mockResolvedValue(1);
});
it("attaches confirmed exact ownership with current locking reads and expiry CAS", async () => {
  await run();
  expect(query).toHaveBeenCalledTimes(3);
  const mediaRead = query.mock.calls[1][0] as Prisma.Sql;
  expect(mediaRead.strings.join("?")).toContain(
    "requestId IS NULL AND reviewId IS NULL AND status = 'uploaded'",
  );
  expect(mediaRead.strings.join("?")).toContain(
    "uploadExpiresAt > CURRENT_TIMESTAMP(3)",
  );
  expect(mediaRead.strings.join("?")).toContain("ORDER BY id FOR UPDATE");
  const write = update.mock.calls[0][0] as Prisma.Sql;
  expect(write.values).toEqual(["review", "store", mediaId]);
  expect(write.strings.join("?")).toContain(
    "uploadExpiresAt > CURRENT_TIMESTAMP(3)",
  );
});
it("does no photo work for text-only submissions", async () => {
  await run([]);
  expect(query).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
});
it.each([{ rows: [] }, { rows: [{ photoUploadsEnabled: false }] }])(
  "fails closed on photo setting %j",
  async ({ rows }) => {
    settings = rows;
    await expect(run()).rejects.toMatchObject({ code: "disabled" });
    expect(update).not.toHaveBeenCalled();
  },
);
it.each([
  { shopperId: "foreign" },
  { productId: "foreign" },
  { installationGeneration: "old" },
  { submissionKey: "other" },
  { settingsRevision: 1 },
  { source: "invitation" },
  { redactedAt: new Date() },
  { contentDigest: null },
  { storageWriteState: "in_flight" },
  { storageWriteState: "ambiguous" },
  { storageWriteState: "not_started" },
  { mediaId: "foreign" },
])("rejects incompatible or unsettled owner %j", async (patch) => {
  owners = [{ ...owner, ...patch }];
  await expect(run()).rejects.toMatchObject({ code: "not_found" });
  expect(update).not.toHaveBeenCalled();
});
it("rejects missing ownership, unavailable media and duplicate selection", async () => {
  owners = [];
  await expect(run()).rejects.toMatchObject({ code: "not_found" });
  media = [];
  await expect(run()).rejects.toMatchObject({ code: "not_found" });
  await expect(run([mediaId, mediaId])).rejects.toMatchObject({
    code: "bad_request",
  });
  expect(update).not.toHaveBeenCalled();
});
it.each([
  { objectKey: "foreign/key" },
  { contentType: "image/png" },
  { sizeBytes: 0 },
  { sizeBytes: 2 * 1024 * 1024 + 1 },
])("rejects non-normalized media %j", async (patch) => {
  media = [{ ...media[0], ...patch }];
  await expect(run()).rejects.toMatchObject({ code: "not_found" });
  expect(update).not.toHaveBeenCalled();
});
it("fails the enclosing transaction if attachment CAS loses expiry or ownership", async () => {
  update.mockResolvedValue(0);
  await expect(run()).rejects.toMatchObject({ code: "conflict" });
});
