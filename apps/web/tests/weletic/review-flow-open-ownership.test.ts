import { hasOpenReviewFlowOwnership } from "@/lib/weletic/reviews/flow-open-ownership";
import { expect, it } from "vitest";

const row = () => ({
  id: "review",
  shopperId: "shopper",
  requestId: null as string | null,
  verifiedPurchase: false,
  incentivized: false,
  openSubmission: {
    storeId: "store",
    reviewId: "review",
    shopperId: "shopper",
    installationGeneration: "original",
    source: "app_proxy",
    contentDigest: "a".repeat(64) as string | null,
    settingsRevision: 1,
    disclosureRevision: "open_unverified_unrewarded_v1",
    redactedAt: null as Date | null,
  },
});
it("binds submitted events to original ownership but permits later publication", () => {
  expect(hasOpenReviewFlowOwnership("store", row(), "original")).toBe(true);
  expect(hasOpenReviewFlowOwnership("store", row(), "new-installation")).toBe(
    false,
  );
  expect(hasOpenReviewFlowOwnership("store", row())).toBe(true);
});
it.each([
  { storeId: "foreign" },
  { reviewId: "foreign" },
  { shopperId: "foreign" },
  { redactedAt: new Date() },
  { contentDigest: null },
  { contentDigest: "invalid" },
  { source: "import" },
  { settingsRevision: 0 },
  { settingsRevision: 2_147_483_648 },
  { disclosureRevision: "verified" },
  { installationGeneration: "" },
])("rejects invalid or erased provenance %j", (change) => {
  const review = row();
  Object.assign(review.openSubmission, change);
  expect(hasOpenReviewFlowOwnership("store", review)).toBe(false);
});
it.each([
  { requestId: "invitation" },
  { verifiedPurchase: true },
  { incentivized: true },
  { openSubmission: null },
])("rejects mixed or fabricated authority %j", (change) => {
  expect(hasOpenReviewFlowOwnership("store", { ...row(), ...change })).toBe(
    false,
  );
});
