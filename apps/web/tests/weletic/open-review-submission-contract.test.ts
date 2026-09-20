import {
  classifyOpenReviewReplay,
  OPEN_REVIEW_DISCLOSURE_REVISION,
  openReviewSubmissionEvidence,
  openReviewSubmissionSchema,
} from "@/lib/weletic/reviews/open-submission-contract";
import { openReviewProvenanceExportSelection } from "@/lib/weletic/reviews/open-submission-privacy";
import { describe, expect, it } from "vitest";

const scope = {
  storeId: "store",
  shopperId: "shopper",
  installationGeneration: "generation",
  source: "app_proxy" as const,
};
const input = {
  submissionId: "12345678-1234-4123-8123-123456789012",
  productId: "gid://shopify/Product/123",
  expectedInstallationGeneration: "generation",
  expectedSettingsRevision: 1,
  locale: "en",
  disclosureRevision: OPEN_REVIEW_DISCLOSURE_REVISION,
  rating: 1,
  title: "Honest feedback",
  body: "The product did not meet my expectations.",
  displayName: "Shopper",
  mediaIds: ["wrevmedia_b", "wrevmedia_a"],
  publishConsent: true,
};

describe("open submission contract and private provenance", () => {
  it("exports only owned metadata, never operation/content hashes or identity", () => {
    expect(openReviewProvenanceExportSelection("store")).toEqual({
      where: { storeId: "store" },
      select: {
        source: true,
        settingsRevision: true,
        disclosureRevision: true,
        locale: true,
        createdAt: true,
        redactedAt: true,
      },
    });
  });
  it.each([
    "customerId",
    "shopperId",
    "storeId",
    "source",
    "verifiedPurchase",
    "incentivized",
    "rewardId",
    "orderId",
    "token",
    "status",
  ])("rejects caller authority field %s", (key) => {
    expect(
      openReviewSubmissionSchema.safeParse({ ...input, [key]: "forged" })
        .success,
    ).toBe(false);
  });
  it.each(["en", "ja", "vi"])(
    "accepts disclosed unverified participation in %s",
    (locale) => {
      expect(
        openReviewSubmissionSchema.parse({ ...input, locale }).rating,
      ).toBe(1);
    },
  );
  it("requires publication consent and the current disclosure", () => {
    expect(
      openReviewSubmissionSchema.safeParse({ ...input, publishConsent: false })
        .success,
    ).toBe(false);
    expect(
      openReviewSubmissionSchema.safeParse({
        ...input,
        disclosureRevision: "old",
      }).success,
    ).toBe(false);
  });
  it("rejects duplicate photos and caller-selected non-product identities", () => {
    expect(
      openReviewSubmissionSchema.safeParse({
        ...input,
        mediaIds: ["wrevmedia_a", "wrevmedia_a"],
      }).success,
    ).toBe(false);
    expect(
      openReviewSubmissionSchema.safeParse({
        ...input,
        productId: "gid://shopify/Customer/123",
      }).success,
    ).toBe(false);
  });
  it("rejects non-random-version operation IDs", () => {
    expect(
      openReviewSubmissionSchema.safeParse({
        ...input,
        submissionId: "12345678-1234-1123-8123-123456789012",
      }).success,
    ).toBe(false);
  });
  it("normalizes content whitespace and media order for stable replay", () => {
    expect(
      openReviewSubmissionEvidence(scope, {
        ...input,
        title: ` ${input.title} `,
        mediaIds: [...input.mediaIds].reverse(),
      }),
    ).toEqual(openReviewSubmissionEvidence(scope, input));
  });
  it("keeps operation identity across surfaces without duplicate acceptance", () => {
    expect(
      openReviewSubmissionEvidence(
        { ...scope, source: "customer_account" },
        input,
      ),
    ).toEqual(openReviewSubmissionEvidence(scope, input));
  });
  it.each(["storeId", "shopperId"] as const)(
    "separates operations by %s",
    (key) => {
      expect(
        openReviewSubmissionEvidence({ ...scope, [key]: "other" }, input)
          .idempotencyKey,
      ).not.toBe(openReviewSubmissionEvidence(scope, input).idempotencyKey);
    },
  );
  it("rejects stale installation and separates accepted generations", () => {
    expect(() =>
      openReviewSubmissionEvidence(
        { ...scope, installationGeneration: "new" },
        input,
      ),
    ).toThrow("installation changed");
    expect(
      openReviewSubmissionEvidence(
        { ...scope, installationGeneration: "new" },
        { ...input, expectedInstallationGeneration: "new" },
      ).idempotencyKey,
    ).not.toBe(openReviewSubmissionEvidence(scope, input).idempotencyKey);
  });
  it.each([
    { rating: 5 },
    { title: "Other title" },
    { body: "A different valid submission body." },
    { displayName: "Other" },
    { locale: "ja" },
    { expectedSettingsRevision: 2 },
    { productId: "gid://shopify/Product/456" },
    { mediaIds: [] },
  ])("rejects changed content under the same operation: %j", (patch) => {
    const original = openReviewSubmissionEvidence(scope, input);
    const changed = openReviewSubmissionEvidence(scope, { ...input, ...patch });
    expect(original.idempotencyKey).toBe(changed.idempotencyKey);
    expect(
      classifyOpenReviewReplay({ ...original, redactedAt: null }, changed),
    ).toBe("conflict");
  });
  it("accepts exact replay but never revives erased provenance", () => {
    const evidence = openReviewSubmissionEvidence(scope, input);
    expect(
      classifyOpenReviewReplay({ ...evidence, redactedAt: null }, evidence),
    ).toBe("duplicate");
    expect(
      classifyOpenReviewReplay(
        { ...evidence, redactedAt: new Date() },
        evidence,
      ),
    ).toBe("suppressed");
    expect(
      classifyOpenReviewReplay(
        { ...evidence, contentDigest: null, redactedAt: null },
        evidence,
      ),
    ).toBe("suppressed");
  });
});
