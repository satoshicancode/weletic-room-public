import { OPEN_REVIEW_DISCLOSURE_REVISION } from "./open-submission-contract";

/** Internal read projection. Never put content evidence in a Flow payload. */
export const openReviewFlowSourceSelection = {
  storeId: true,
  reviewId: true,
  shopperId: true,
  installationGeneration: true,
  source: true,
  contentDigest: true,
  settingsRevision: true,
  disclosureRevision: true,
  redactedAt: true,
} as const;

type OpenSource = {
  storeId: string;
  reviewId: string;
  shopperId: string;
  installationGeneration: string;
  source: string;
  contentDigest: string | null;
  settingsRevision: number;
  disclosureRevision: string;
  redactedAt: Date | null;
};

/** The current store fence is separate from immutable submission provenance.
 * Submitted events bind to the original generation; a later publication may
 * use the then-current generation without rewriting the original submission.
 */
export function hasOpenReviewFlowOwnership(
  storeId: string,
  review: {
    id: string;
    shopperId: string;
    requestId: string | null;
    verifiedPurchase: boolean;
    incentivized: boolean;
    openSubmission: OpenSource | null;
  },
  submittedGeneration?: string,
) {
  const source = review.openSubmission;
  return !!(
    review.requestId === null &&
    review.verifiedPurchase === false &&
    review.incentivized === false &&
    source &&
    source.storeId === storeId &&
    source.reviewId === review.id &&
    source.shopperId === review.shopperId &&
    source.redactedAt === null &&
    source.contentDigest &&
    /^[a-f0-9]{64}$/.test(source.contentDigest) &&
    source.installationGeneration.length > 0 &&
    source.installationGeneration.length <= 64 &&
    (!submittedGeneration ||
      source.installationGeneration === submittedGeneration) &&
    ["app_proxy", "customer_account"].includes(source.source) &&
    Number.isInteger(source.settingsRevision) &&
    source.settingsRevision > 0 &&
    source.settingsRevision <= 2_147_483_647 &&
    source.disclosureRevision === OPEN_REVIEW_DISCLOSURE_REVISION
  );
}
