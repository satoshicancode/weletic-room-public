import type { Api } from "@shopify/ui-extensions/customer-account.page.render";
import en from "../locales/en.default.json";

declare const shopify: Api;

type HubMessage = keyof typeof en.hub;

export function hubEarningActionLabel(trigger: string): string {
  switch (trigger) {
    case "facebook_like":
      return hubText("openFacebook");
    case "facebook_share":
      return hubText("shareFacebook");
    case "instagram_follow":
      return hubText("openInstagram");
    case "x_share":
      return hubText("shareX");
    case "x_follow":
      return hubText("openX");
    case "tiktok_follow":
      return hubText("openTikTok");
    case "link_click":
      return hubText("openLink");
    default:
      return hubText("openActivity");
  }
}

type HubOperation = "summary" | "activity" | "redeem" | "birthday" | "earn";

/** Only allowlisted local text may cross from request errors into the DOM. */
export class HubRequestError extends Error {}

export function hubRequestError(
  operation: HubOperation,
  status?: number,
  remoteMessage?: unknown,
): HubRequestError {
  let key: HubMessage;
  if (status === 401) key = "errorAuthentication";
  else if (status === 403) key = "errorPermission";
  else if (status === 429) key = "errorRateLimit";
  else if (
    operation === "redeem" &&
    status === 400 &&
    typeof remoteMessage === "string" &&
    /^Insufficient points balance: required \d+, available -?\d+\.$/.test(
      remoteMessage,
    )
  )
    key = "insufficientPoints";
  else if (
    operation === "redeem" &&
    status === 400 &&
    [
      "Reward is not available for this Shopify store.",
      "Reward is only available in Shopify POS.",
      "Incremental reward is not available.",
    ].includes(String(remoteMessage))
  )
    key = "errorRewardUnavailable";
  else if (operation === "birthday" && status === 422)
    key = "errorBirthdayInvalid";
  else if (
    operation === "birthday" &&
    status === 409 &&
    remoteMessage ===
      "Birthday is already registered. Contact support to correct it."
  )
    key = "errorBirthdayLocked";
  else
    key = {
      summary: "errorSummary",
      activity: "errorActivity",
      redeem: "errorRedemptionUncertain",
      birthday: "errorBirthday",
      earn: "errorEarningUncertain",
    }[operation] as HubMessage;
  return new HubRequestError(hubText(key));
}

export function hubErrorText(cause: unknown, operation: HubOperation): string {
  return cause instanceof HubRequestError
    ? cause.message
    : hubRequestError(operation).message;
}

const activityLabels: Record<
  "points" | "referrals" | "vip",
  Record<string, HubMessage>
> = {
  points: {
    EARN_ORDER: "ledgerOrder",
    EARN_REFERRAL: "ledgerReferral",
    EARN_BONUS: "ledgerBonus",
    REDEEM_REWARD: "ledgerRedeem",
    REFUND_REVERSAL: "ledgerRefund",
    MANUAL_ADJUSTMENT: "ledgerManual",
    EXPIRATION: "ledgerExpiry",
    BACKFILL: "ledgerImport",
    BACKFILL_CORRECTION: "ledgerCorrection",
    TIER_BONUS: "ledgerTier",
  },
  referrals: {
    pending: "refPending",
    qualified: "refQualified",
    rewarded: "refRewarded",
    cancelled: "refCancelled",
    fraud_blocked: "refBlocked",
  },
  vip: {
    threshold_reached: "tierThreshold",
    manual_override: "tierManual",
    annual_downgrade: "tierAnnual",
    bonus_promotion: "tierPromotion",
    grace_period_expired: "tierGrace",
    program_activation: "tierActivation",
  },
};

export function hubActivityLabel(
  kind: keyof typeof activityLabels,
  value: unknown,
): string {
  const labels = activityLabels[kind];
  if (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(labels, value)
  )
    return hubText(labels[value]);
  return hubText(
    kind === "points"
      ? "unknownPointsActivity"
      : kind === "referrals"
        ? "unknownReferralActivity"
        : "unknownVipActivity",
  );
}

/** Native host translations; English fallback keeps standalone helpers usable. */
export function hubText(
  key: HubMessage,
  values: Record<string, string | number> = {},
): string {
  if (typeof shopify !== "undefined" && shopify.i18n) {
    return shopify.i18n.translate(`hub.${key}`, values);
  }
  return en.hub[key].replace(/{{(\w+)}}/g, (_, name: string) => {
    if (!(name in values))
      throw new Error(`Missing translation value: ${name}`);
    return String(values[name]);
  });
}

export function hubNumber(value: number | bigint): string {
  return typeof shopify !== "undefined" && shopify.i18n
    ? shopify.i18n.formatNumber(value)
    : new Intl.NumberFormat("en").format(value);
}

/** Match the buyer's locale, not the JavaScript worker's default locale. */
export function hubLocale(locale?: string): string {
  return (
    locale ||
    (typeof shopify !== "undefined"
      ? shopify.localization?.language?.value?.isoCode
      : undefined) ||
    "en"
  );
}

export function hubDate(value: Date, locale?: string): string {
  if (!locale && typeof shopify !== "undefined" && shopify.i18n) {
    return shopify.i18n.formatDate(value, { dateStyle: "medium" });
  }
  return new Intl.DateTimeFormat(locale || "en", {
    dateStyle: "medium",
  }).format(value);
}
