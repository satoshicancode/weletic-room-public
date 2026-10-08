import type { MerchantReviewIncentiveDraftInput } from "@weletic/contracts/reviews/incentive-merchant-contract";

/** Presentation guard only; server policy remains authoritative. */
export function isCoreReviewIncentiveDraft(
  draft: MerchantReviewIncentiveDraftInput["draft"] | null | undefined,
) {
  return (
    draft?.kind === "none" ||
    (draft?.kind === "points" &&
      draft.photoBonusPoints === "0" &&
      draft.videoBonusPoints === "0")
  );
}
