import { hasPublicReviewPhotoOwnership } from "@/lib/weletic/reviews/media-public-ownership";
import { expect, it } from "vitest";

type Review = Parameters<typeof hasPublicReviewPhotoOwnership>[1];
type Media = Parameters<typeof hasPublicReviewPhotoOwnership>[2];
const source = {
  storeId: "store",
  reviewId: "review",
  shopperId: "shopper",
  installationGeneration: "historical",
  source: "app_proxy",
  idempotencyKey: "submission",
  settingsRevision: 1,
  redactedAt: null,
  contentDigest: "content",
};
const owner = {
  storeId: "store",
  mediaId: "media",
  shopperId: "shopper",
  productId: "product",
  installationGeneration: "historical",
  source: "customer_account",
  submissionKey: "submission",
  settingsRevision: 1,
  redactedAt: null,
  contentDigest: "bytes",
  storageWriteState: "confirmed",
};
const review: Review = {
  id: "review",
  storeId: "store",
  shopperId: "shopper",
  productId: "product",
  requestId: null,
  openSubmission: source,
};
const media: Media = {
  id: "media",
  storeId: "store",
  reviewId: "review",
  requestId: null,
  status: "uploaded",
  objectKey: "weletic/reviews/store/media.webp",
  contentType: "image/webp",
  sizeBytes: 32,
  request: null,
  openOwnership: owner,
};
const check = (r = review, m = media) =>
  hasPublicReviewPhotoOwnership("store", r, m);

it("allows coherent historical confirmed ownership across authenticated surfaces", () => {
  expect(check()).toBe(true);
});
it.each([
  { storeId: "other" },
  { mediaId: "other" },
  { shopperId: "other" },
  { productId: "other" },
  { installationGeneration: "different" },
  { submissionKey: "other" },
  { settingsRevision: 2 },
  { redactedAt: new Date() },
  { contentDigest: null },
  { source: "invitation" },
  { storageWriteState: "ambiguous" },
  { storageWriteState: "in_flight" },
  { storageWriteState: "not_started" },
])("rejects incompatible ownership %j", (patch) => {
  expect(
    check(review, { ...media, openOwnership: { ...owner, ...patch } }),
  ).toBe(false);
});
it.each([
  { storeId: "other" },
  { reviewId: "other" },
  { shopperId: "other" },
  { installationGeneration: "" },
  { idempotencyKey: "other" },
  { redactedAt: new Date() },
  { contentDigest: null },
  { source: "unknown" },
])("rejects missing/redacted or mismatched source %j", (patch) => {
  expect(check({ ...review, openSubmission: { ...source, ...patch } })).toBe(
    false,
  );
});
it.each([
  { storeId: "other" },
  { reviewId: "other" },
  { objectKey: "foreign/key.webp" },
  { contentType: "image/png" },
  { sizeBytes: 0 },
  { sizeBytes: 2097153 },
  { requestId: "mixed" },
  { status: "deletion_pending" as const },
])("rejects incoherent media %j", (patch) => {
  expect(check(review, { ...media, ...patch })).toBe(false);
});
it("requires provenance and owner, not merely an attached media row", () => {
  expect(check({ ...review, openSubmission: null })).toBe(false);
  expect(check(review, { ...media, openOwnership: null })).toBe(false);
  expect(check({ ...review, storeId: "foreign" })).toBe(false);
});
it("accepts only coherent exclusive invitation ownership", () => {
  const r = { ...review, requestId: "request", openSubmission: null };
  const m = {
    ...media,
    requestId: "request",
    openOwnership: null,
    request: {
      id: "request",
      storeId: "store",
      shopperId: "shopper",
      productId: "product",
    },
  };
  expect(check(r, m)).toBe(true);
  expect(check(r, { ...m, openOwnership: owner })).toBe(false);
  expect(check({ ...r, openSubmission: source }, m)).toBe(false);
  expect(check(r, { ...m, request: null })).toBe(false);
  for (const field of ["id", "storeId", "shopperId", "productId"])
    expect(
      check(r, { ...m, request: { ...m.request, [field]: "foreign" } }),
    ).toBe(false);
});
