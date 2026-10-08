/** Server-side release policy. Legacy runtimes remain explicit compatibility
 * environments; the public release preflight must select core-v1. */
export function isCoreLaunch(env = process.env): boolean {
  const profile = env.WELETIC_FEATURE_PROFILE;
  if (profile === undefined || profile === "legacy") return false;
  if (profile === "core-v1") return true;
  throw new Error("Unknown Weletic release profile");
}

export class CoreLaunchDeferredError extends Error {
  readonly code = "unavailable";
  constructor() {
    super("This capability is unavailable in the core launch.");
    this.name = "CoreLaunchDeferredError";
  }
}

export const CORE_FLOW_HANDLES: readonly string[] = Object.freeze([
  "weletic-points-earned",
  "weletic-reward-redeemed",
  "weletic-review-submitted",
  "weletic-review-published",
]);

const deferredActions = new Set([
  "activity_points_earn",
  "birthday_points_earn",
  "signup_points_earn",
  "customer_intent_points_earn",
  "judgeme_review_integration_activate",
  "judgeme_review_integration_prepare",
  "judgeme_review_points_earn",
  "loyalty_birthday_reward",
  "loyalty_nudges_write",
  "loyalty_points_expiry_schedule",
  "loyalty_inactivity_expiry",
  "loyalty_tier_evaluation",
  "loyalty_tier_review",
  "loyalty_tier_review_sweep",
  "loyalty_vip_campaign_write",
  "loyalty_referral_configuration_write",
  "loyalty_referral_code_provision",
  "loyalty_referral_link_provision",
  "referral_binding",
  "referral_friend_claim",
  "referral_friend_claim_adoption",
  "referral_friend_claim_precheck",
  "referral_friend_claim_review_approve",
  "referral_friend_qualification",
  "referral_qualification",
  "referral_fraud_review_unblock",
  "open_review_author",
  "loyalty_import_preparation",
  "loyalty_backfill_create",
]);

/** Cleanup, refund correction and existing financial promises are not grants
 * of permission to create new deferred benefits. Keep their fences separate. */
export function assertCoreLaunchOperationalAction(action: string) {
  if (isCoreLaunch() && deferredActions.has(action))
    throw new CoreLaunchDeferredError();
}

const deferredJobs = new Set([
  "TIER_REVIEW",
  "BIRTHDAY_REWARD",
  "INACTIVITY_EXPIRY",
  "HISTORICAL_IMPORT_COMMIT",
]);

export function assertCoreLaunchJob(jobType: string, payload: unknown) {
  if (!isCoreLaunch()) return;
  if (deferredJobs.has(jobType)) throw new CoreLaunchDeferredError();
  if (
    jobType === "REVIEW_REQUEST_EMAIL" &&
    payload &&
    typeof payload === "object" &&
    ("reminderId" in payload || "storeRequestId" in payload)
  )
    throw new CoreLaunchDeferredError();
  if (jobType === "FLOW_TRIGGER") {
    const handle =
      payload && typeof payload === "object" && "handle" in payload
        ? payload.handle
        : undefined;
    if (typeof handle !== "string" || !CORE_FLOW_HANDLES.includes(handle))
      throw new CoreLaunchDeferredError();
  }
}

export function assertCoreLaunchReward(reward: {
  rewardType: string;
  exchangeType?: string;
  purchaseType?: string;
}) {
  if (
    isCoreLaunch() &&
    (reward.rewardType !== "amount_off" ||
      reward.exchangeType !== "fixed" ||
      reward.purchaseType !== "one_time")
  )
    throw new CoreLaunchDeferredError();
}

export function assertCoreLaunchReviewAward(award: {
  kind: string;
  photoBonusPoints?: string;
  videoBonusPoints?: string;
}) {
  if (
    isCoreLaunch() &&
    award.kind !== "none" &&
    (award.kind !== "points" ||
      award.photoBonusPoints !== "0" ||
      award.videoBonusPoints !== "0")
  )
    throw new CoreLaunchDeferredError();
}
