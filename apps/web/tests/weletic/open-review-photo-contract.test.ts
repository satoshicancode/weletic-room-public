import {
  openReviewPhotoEvidence,
  openReviewPhotoSchema,
} from "@/lib/weletic/reviews/open-media-contract";
import { openReviewOperationKey } from "@/lib/weletic/reviews/open-submission-contract";
import { expect, it } from "vitest";

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
const bytes = Buffer.from("synthetic raw bytes");
const normalized = Buffer.from("synthetic normalized bytes");
it("binds exact bytes to immutable upload and shared submission identities", () => {
  const first = openReviewPhotoEvidence(scope, input, bytes, normalized);
  expect(first.submissionKey).toBe(
    openReviewOperationKey(scope, input.submissionId),
  );
  expect(first).toEqual(
    openReviewPhotoEvidence(
      { ...scope, source: "customer_account" },
      input,
      bytes,
      normalized,
    ),
  );
  expect(first).toEqual(
    openReviewPhotoEvidence(
      scope,
      { ...input, submissionId: input.submissionId.toUpperCase() },
      bytes,
      normalized,
    ),
  );
  expect(
    Object.values(first).every((value) => /^[a-f0-9]{64}$/.test(value)),
  ).toBe(true);
  for (const patch of [
    { productId: "gid://shopify/Product/124" },
    { submissionId: input.uploadId },
    { expectedSettingsRevision: 2 },
  ]) {
    const changed = openReviewPhotoEvidence(
      scope,
      { ...input, ...patch },
      bytes,
      normalized,
    );
    expect(changed.idempotencyKey).toBe(first.idempotencyKey);
    expect(changed.contentDigest).not.toBe(first.contentDigest);
  }
  expect(
    openReviewPhotoEvidence(
      scope,
      input,
      Buffer.from("other bytes"),
      normalized,
    ).contentDigest,
  ).not.toBe(first.contentDigest);
  expect(
    openReviewPhotoEvidence(scope, input, bytes, Buffer.from("other encoding"))
      .contentDigest,
  ).not.toBe(first.contentDigest);
  expect(
    openReviewPhotoEvidence(
      { ...scope, shopperId: "other" },
      input,
      bytes,
      normalized,
    ).idempotencyKey,
  ).not.toBe(first.idempotencyKey);
});
it.each([
  "storeId",
  "shopperId",
  "customerId",
  "source",
  "objectKey",
  "requestId",
  "status",
  "reviewId",
])("rejects caller authority %s", (key) => {
  expect(
    openReviewPhotoSchema.safeParse({ ...input, [key]: "forged" }).success,
  ).toBe(false);
});
it("rejects stale generations, invalid IDs and oversized normalized output", () => {
  expect(() =>
    openReviewPhotoEvidence(
      { ...scope, installationGeneration: "old" },
      input,
      bytes,
      normalized,
    ),
  ).toThrow("Installation changed");
  expect(
    openReviewPhotoSchema.safeParse({ ...input, productId: "123" }).success,
  ).toBe(false);
  expect(() =>
    openReviewPhotoEvidence(
      scope,
      input,
      bytes,
      Buffer.alloc(2 * 1024 * 1024 + 1),
    ),
  ).toThrow("size");
  expect(() =>
    openReviewPhotoEvidence(scope, input, Buffer.alloc(0), normalized),
  ).toThrow("size");
});
