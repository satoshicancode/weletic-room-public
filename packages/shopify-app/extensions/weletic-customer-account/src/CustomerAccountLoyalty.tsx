/** @jsxImportSource preact */
import type { Api } from "@shopify/ui-extensions/customer-account.page.render";
import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

declare const shopify: Api;

const API_BASE_URL = "https://shopify.weletic.com/api/customer-account/loyalty";
const CUSTOMER_REQUEST_TIMEOUT_MS = 10_000;

export function formatCustomerTierDestination(
  tier: { name: string } | null,
  locale = "en",
) {
  if (tier) return tier.name;
  const language = locale.toLowerCase().split(/[-_]/)[0];
  return language === "ja"
    ? "ランクなし"
    : language === "vi"
      ? "Chưa có hạng"
      : "No tier";
}

export interface CustomerSessionClaims {
  dest?: string;
  sub?: string;
  iss?: string;
  exp?: number;
}

export function validateCustomerSessionClaims(claims: CustomerSessionClaims): {
  valid: boolean;
  shopDomain?: string;
  customerId?: string;
  error?: string;
} {
  if (!claims.dest || typeof claims.dest !== "string") {
    return { valid: false, error: "Missing or invalid dest claim" };
  }
  if (!claims.sub || typeof claims.sub !== "string") {
    return { valid: false, error: "Missing or invalid sub claim" };
  }

  try {
    const shopDomain = new URL(
      claims.dest.startsWith("http") ? claims.dest : `https://${claims.dest}`,
    ).hostname.toLowerCase();
    const customerId = claims.sub.replace(/^gid:\/\/shopify\/Customer\//, "");
    const isShopifyDomain = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(
      shopDomain,
    );
    const isNumericCustomerId = /^\d+$/.test(customerId);
    return isShopifyDomain && isNumericCustomerId
      ? { valid: true, shopDomain, customerId }
      : { valid: false, error: "Malformed customer identity claims" };
  } catch {
    return { valid: false, error: "Malformed destination claim" };
  }
}

export function calculateBirthdayLockout(
  birthMonth: number,
  birthDay: number,
  submissionDate: Date = new Date(),
) {
  const currentYear = submissionDate.getFullYear();
  let targetBirthday = new Date(currentYear, birthMonth - 1, birthDay);
  if (targetBirthday.getTime() < submissionDate.getTime()) {
    targetBirthday = new Date(currentYear + 1, birthMonth - 1, birthDay);
  }
  const daysUntilBirthday = Math.ceil(
    (targetBirthday.getTime() - submissionDate.getTime()) / 86_400_000,
  );
  return {
    isLockedOut: daysUntilBirthday < 30,
    nextEligibleYear:
      daysUntilBirthday < 30 ? currentYear + 1 : targetBirthday.getFullYear(),
    daysUntilBirthday,
  };
}

export function calculateVipProgress(
  currentSpendMinor: number,
  nextMilestoneMinor: number,
) {
  if (nextMilestoneMinor <= 0) return { percent: 100, remainingMinor: 0 };
  return {
    percent: Math.min(
      100,
      Math.floor((currentSpendMinor / nextMilestoneMinor) * 100),
    ),
    remainingMinor: Math.max(0, nextMilestoneMinor - currentSpendMinor),
  };
}

export function getOrCreateRedemptionIntentKey(
  keys: Map<string, string>,
  rewardId: string,
  createKey = () => crypto.randomUUID(),
) {
  const existing = keys.get(rewardId);
  if (existing) return existing;

  const key = createKey();
  keys.set(rewardId, key);
  return key;
}

export function shouldClearRedemptionIntentKey(status: number) {
  return status >= 200 && status < 300;
}

type CustomerRewardTerms = {
  rewardType?:
    | "amount_off"
    | "percentage_off"
    | "free_shipping"
    | "free_product"
    | "gift_card"
    | "store_credit";
  salesChannel?: "online_store" | "pos" | "both" | null;
  minOrderAmount?: number | string | null;
  appliesToResource?: string | null;
  entitlementCount?: number;
  entitledCollectionIds?: unknown[];
  entitledProductIds?: unknown[];
  entitledVariantIds?: unknown[];
  combinesWithProductDiscounts?: boolean;
  combinesWithOrderDiscounts?: boolean;
  combinesWithShippingDiscounts?: boolean;
  usageLimitPerCustomer?: number | null;
  expiresInDays?: number | null;
};

type Reward = CustomerRewardTerms & {
  id: string;
  name: string;
  description?: string | null;
  pointsCost: string;
  canRedeem: boolean;
  exchangeType?: "fixed" | "incremental";
  pointsStep?: string | null;
  minPointsCost?: string | null;
  maxPointsCost?: string | null;
  discountValue?: string | null;
  maxDiscountValue?: string | null;
};

export type CustomerRewardTermsSnapshot = CustomerRewardTerms & {
  version: 1;
  rewardType: NonNullable<CustomerRewardTerms["rewardType"]>;
  salesChannel: CustomerRewardTerms["salesChannel"];
  currency: string;
  minOrderAmount: string | null;
  expiresInDays: number | null;
  usageLimitPerCustomer: number | null;
  appliesToResource: string | null;
  entitlementCount: number;
  combinesWithProductDiscounts: boolean;
  combinesWithOrderDiscounts: boolean;
  combinesWithShippingDiscounts: boolean;
};

type WayToEarn = {
  id: string;
  name: string;
  description?: string | null;
  triggerCode: string;
  multiplier: number;
  fixedPoints?: string | null;
  maxEventsPerCustomer?: number | null;
  limitInterval?: string | null;
  action?: {
    kind: "customer_intent";
    url: string;
    label: string;
    verification: "honor_system";
  } | null;
};

type CustomerTier = {
  id: string;
  name: string;
  slug: string;
  tierOrder: number;
  minSpendThreshold: string;
  minPointsThreshold: string;
  pointsMultiplier: number;
  entryBonusPoints: string;
  perks?: string[];
  iconUrl?: string | null;
  color?: string | null;
};

export type CustomerReward = {
  id: string;
  rewardDefinitionId?: string;
  rewardName: string;
  rewardDescription?: string | null;
  rewardType?: string;
  salesChannel?: CustomerRewardTerms["salesChannel"];
  termsSnapshot?: CustomerRewardTermsSnapshot | null;
  termsSource?: "issuance_snapshot" | "legacy" | "unavailable";
  pointsSpent: string;
  artifactKind?: "discount_code" | "gift_card" | "store_credit";
  artifactCode?: string | null;
  discountCode?: string | null;
  giftCardCode?: string | null;
  status: "available" | "used" | "expired" | "cancelled";
  issuedAt: string;
  statusDate?: string | null;
  expiresAt?: string | null;
  usedAt?: string | null;
  orderId?: string | null;
  orderName?: string | null;
  applyUrl?: string | null;
};

export type CustomerReferralOffer = {
  advocateRewardKind: "points" | "coupon";
  advocatePointsReward: string;
  advocateRewardName?: string | null;
  refereeRewardKind: "points" | "coupon";
  refereePointsReward: string;
  refereeRewardName?: string | null;
  minQualifyingOrderSubtotal?: string | null;
  maxReferralsPerAdvocate?: number | null;
};

type LoyaltySummary = {
  isEnrolled: boolean;
  shopper?: { firstName?: string | null };
  account?: {
    status?: string;
    canParticipate?: boolean;
    pointsBalance: string;
    pendingPoints: string;
    lifetimePointsEarned?: string;
    lifetimePointsRedeemed?: string;
    enrolledAt?: string;
    nextExpiryDate?: string | null;
  };
  program?: {
    isActive: boolean;
    name: string;
    pointNameSingular: string;
    pointNamePlural: string;
    pointsExpiryMonths: number;
    pointsExpiryDays?: number;
    pointsExpiryWarningDays?: number;
    pointsExpiryLastChanceDays?: number;
    vipMilestoneMode: "amount_spent" | "points_earned" | "both";
    vipTimeframe: "rolling_12m" | "calendar_year" | "lifetime";
    currency: string;
    branding?: {
      title?: string | null;
      subtitle?: string | null;
      heroImageUrl?: string | null;
      primaryColor?: string | null;
    };
  };
  tier?: {
    currentTier?: CustomerTier | null;
    nextTier?: CustomerTier | null;
    allTiers?: CustomerTier[];
    tierExpiresAt?: string | null;
    rollingSpend?: string;
    lifetimePoints?: string;
    perks?: string[];
    history?: Array<{
      id: string;
      fromTier?: { id: string; name: string } | null;
      toTier: { id: string; name: string } | null;
      changeReason: string;
      qualifyingSpendSnapshot?: string | null;
      qualifyingPointsSnapshot?: string | null;
      effectiveAt: string;
    }>;
    progress?: {
      milestoneMode: "amount_spent" | "points_earned" | "both";
      percent: number;
      spendRemaining: string;
      pointsRemaining: string;
    } | null;
  };
  rewards?: Reward[];
  rewardWallet?: CustomerReward[];
  referral?: {
    referralCode?: string | null;
    referralShareUrl?: string | null;
    totalReferrals?: number;
    qualifiedReferrals?: number;
    totalPointsEarned?: string;
    offer?: CustomerReferralOffer | null;
    activity?: Array<{
      id: string;
      status: string;
      refereeName: string;
      advocatePointsAwarded: string;
      refereePointsAwarded: string;
      rewardedAt?: string | null;
      createdAt: string;
    }>;
  };
  waysToEarn?: WayToEarn[];
  activeCampaigns?: Array<{
    id: string;
    name: string;
    description?: string | null;
    multiplier: number;
    endAt: string;
  }>;
  recentActivity?: Array<{
    id: string;
    entryType: string;
    pointsDelta: string;
    reason?: string | null;
    createdAt: string;
  }>;
  pointsExpiry?: {
    enabled: boolean;
    days?: number;
    months: number;
    warningDays?: number;
    lastChanceDays?: number;
    nextExpiryDate?: string | null;
  };
  birthday?: {
    enabled: boolean;
    isRegistered: boolean;
    birthMonth?: number | null;
    birthDay?: number | null;
    nextEligibleYear?: number | null;
  };
};

export function formatCustomerRewardDate(
  value: string | null | undefined,
  locale?: string,
) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date);
}

export function customerCanParticipate(
  programIsActive: boolean,
  account?: { status?: string; canParticipate?: boolean },
) {
  return (
    programIsActive &&
    account?.status === "active" &&
    account.canParticipate === true
  );
}

export function formatCustomerPoints(
  value: string | number | bigint,
  pointNameSingular = "point",
  pointNamePlural = "points",
) {
  const amount = readExactSignedInteger(value) ?? BigInt(0);
  return `${amount.toLocaleString()} ${amount === BigInt(1) ? pointNameSingular : pointNamePlural}`;
}

function readExactSignedInteger(value: string | number | bigint) {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    return null;
  }
  const normalized = String(value);
  return /^-?\d+$/.test(normalized) ? BigInt(normalized) : null;
}

function readExactUnsignedInteger(value: string | number | bigint) {
  const exact = readExactSignedInteger(value);
  return exact !== null && exact >= BigInt(0) ? exact : null;
}

function toSafeNumber(value: bigint | null) {
  return value !== null && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : undefined;
}

export function calculateExactCustomerProgress(
  current: string | number | bigint,
  target: string | number | bigint,
) {
  const currentValue = readExactUnsignedInteger(current);
  const targetValue = readExactUnsignedInteger(target);
  if (currentValue === null || targetValue === null) return null;
  if (targetValue === BigInt(0)) {
    return { value: 10_000, max: 10_000, percent: 100, remaining: "0" };
  }

  const cappedCurrent = currentValue < targetValue ? currentValue : targetValue;
  const basisPoints = (cappedCurrent * BigInt(10_000)) / targetValue;
  return {
    // basisPoints is bounded to 10,000 before conversion, so the progress
    // component never receives an unsafe Number even for huge point strings.
    value: Number(basisPoints),
    max: 10_000,
    percent: Number(basisPoints / BigInt(100)),
    remaining: (targetValue > currentValue
      ? targetValue - currentValue
      : BigInt(0)
    ).toString(),
  };
}

export type IncrementalPointsSelection =
  | {
      valid: true;
      pointsRequested: string;
      error: null;
    }
  | {
      valid: false;
      pointsRequested: null;
      error: string;
    };

export function validateIncrementalPointsSelection({
  pointsRequested,
  pointsBalance,
  pointsCost,
  minPointsCost,
  maxPointsCost,
  pointsStep,
}: {
  pointsRequested: string;
  pointsBalance: string | number | bigint;
  pointsCost: string;
  minPointsCost?: string | null;
  maxPointsCost?: string | null;
  pointsStep?: string | null;
}): IncrementalPointsSelection {
  const requested = readExactUnsignedInteger(pointsRequested);
  const balance = readExactUnsignedInteger(pointsBalance);
  const minimum = readExactUnsignedInteger(minPointsCost ?? pointsCost);
  const maximum =
    maxPointsCost == null ? null : readExactUnsignedInteger(maxPointsCost);
  const step = readExactUnsignedInteger(pointsStep ?? pointsCost);

  if (
    balance === null ||
    minimum === null ||
    (maximum === null && maxPointsCost != null) ||
    step === null ||
    minimum <= BigInt(0) ||
    step <= BigInt(0) ||
    (maximum !== null && maximum < minimum)
  ) {
    return {
      valid: false,
      pointsRequested: null,
      error: "This reward's point limits are unavailable.",
    };
  }
  if (requested === null) {
    return {
      valid: false,
      pointsRequested: null,
      error: "Enter a whole number of points.",
    };
  }
  if (requested < minimum) {
    return {
      valid: false,
      pointsRequested: null,
      error: `Redeem at least ${minimum.toLocaleString()} points.`,
    };
  }
  if (maximum !== null && requested > maximum) {
    return {
      valid: false,
      pointsRequested: null,
      error: `Redeem no more than ${maximum.toLocaleString()} points.`,
    };
  }
  if (requested > balance) {
    return {
      valid: false,
      pointsRequested: null,
      error: "You do not have enough points for this selection.",
    };
  }
  if (requested % step !== BigInt(0)) {
    return {
      valid: false,
      pointsRequested: null,
      error: `Redeem points in increments of ${step.toLocaleString()}.`,
    };
  }
  return {
    valid: true,
    pointsRequested: requested.toString(),
    error: null,
  };
}

function formatStoreCurrency(
  value: string | number,
  currency = "USD",
  locale?: string,
) {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
  }).format(Number(value || 0));
}

export function formatStoreMinorCurrency(
  value: string | number | bigint,
  currency = "USD",
  locale?: string,
) {
  const minorUnits = readExactSignedInteger(value) ?? BigInt(0);
  const formatter = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
  });
  const fractionDigits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  const scale = BigInt(`1${"0".repeat(fractionDigits)}`);
  const absoluteMinorUnits = minorUnits < BigInt(0) ? -minorUnits : minorUnits;
  const wholeUnits = absoluteMinorUnits / scale;
  const fractionUnits = absoluteMinorUnits % scale;
  const groupedWholeUnits = wholeUnits.toLocaleString(locale);
  const exactFraction = fractionUnits.toString().padStart(fractionDigits, "0");
  let wroteInteger = false;

  return formatter
    .formatToParts(minorUnits < BigInt(0) ? -1 : 1)
    .map((part) => {
      if (part.type === "integer") {
        if (wroteInteger) return "";
        wroteInteger = true;
        return groupedWholeUnits;
      }
      if (part.type === "group") return "";
      if (part.type === "fraction") return exactFraction;
      return part.value;
    })
    .join("");
}

export function customerRewardTypeLabel(
  rewardType?: CustomerRewardTerms["rewardType"],
) {
  switch (rewardType) {
    case "amount_off":
      return "Amount off";
    case "percentage_off":
      return "Percentage off";
    case "free_shipping":
      return "Free shipping";
    case "free_product":
      return "Free product";
    case "gift_card":
      return "Gift card";
    case "store_credit":
      return "Store credit";
    default:
      return "Reward";
  }
}

export function isOnlineStoreReward(reward: Reward) {
  return (
    reward.salesChannel === "online_store" || reward.salesChannel === "both"
  );
}

export function customerRewardTerms<TReward extends CustomerRewardTerms>(
  reward: TReward,
  currency = "USD",
  locale?: string,
) {
  const terms: string[] = [];
  if (reward.salesChannel === "pos") {
    terms.push("Available in Shopify POS");
  } else if (reward.salesChannel === "both") {
    terms.push("Available online and in Shopify POS");
  }
  const minimumOrderAmount =
    reward.minOrderAmount == null
      ? null
      : readExactSignedInteger(reward.minOrderAmount);
  if (minimumOrderAmount !== null && minimumOrderAmount > BigInt(0)) {
    terms.push(
      `Minimum purchase ${formatStoreMinorCurrency(minimumOrderAmount, currency, locale)}`,
    );
  }
  if (reward.expiresInDays && reward.expiresInDays > 0) {
    terms.push(`Expires ${reward.expiresInDays} days after redemption`);
  }
  if (reward.usageLimitPerCustomer) {
    terms.push(
      `${reward.usageLimitPerCustomer} use${reward.usageLimitPerCustomer === 1 ? "" : "s"} per customer`,
    );
  }
  const targetCount =
    reward.entitlementCount ??
    (reward.entitledCollectionIds?.length || 0) +
      (reward.entitledProductIds?.length || 0) +
      (reward.entitledVariantIds?.length || 0);
  if (targetCount > 0) {
    terms.push("Applies to selected products or collections");
  } else if (reward.appliesToResource === "entire_order") {
    terms.push("Applies to the entire eligible order");
  }
  if (
    reward.combinesWithProductDiscounts ||
    reward.combinesWithOrderDiscounts ||
    reward.combinesWithShippingDiscounts
  ) {
    terms.push("Can combine with selected Shopify discounts");
  }
  return terms;
}

function earningValueLabel(way: WayToEarn, singular: string, plural: string) {
  return way.triggerCode === "order_paid"
    ? `${way.multiplier}× ${plural.toLowerCase()} on eligible purchases`
    : formatCustomerPoints(way.fixedPoints || 0, singular, plural);
}

function referralRewardLabel(
  kind: "points" | "coupon",
  points: string,
  rewardName: string | null | undefined,
  singular: string,
  plural: string,
) {
  return kind === "coupon"
    ? rewardName || "a coupon reward"
    : formatCustomerPoints(points, singular, plural);
}

export function customerReferralOfferCopy(
  offer: CustomerReferralOffer,
  pointNameSingular = "Point",
  pointNamePlural = "Points",
) {
  const friendReward = referralRewardLabel(
    offer.refereeRewardKind,
    offer.refereePointsReward,
    offer.refereeRewardName,
    pointNameSingular,
    pointNamePlural,
  );
  const advocateReward = referralRewardLabel(
    offer.advocateRewardKind,
    offer.advocatePointsReward,
    offer.advocateRewardName,
    pointNameSingular,
    pointNamePlural,
  );
  const friendTiming =
    offer.refereeRewardKind === "coupon"
      ? `Your friend can claim ${friendReward} before their first eligible order.`
      : `Your friend receives ${friendReward} after completing their first eligible order.`;
  return {
    heading: `Give ${friendReward}, get ${advocateReward}`,
    qualification: `${friendTiming} You receive ${advocateReward} when they qualify.`,
    showPointsEarned: offer.advocateRewardKind === "points",
  };
}

export function customerReferralActivityRewardLabel(
  advocateRewardKind:
    | CustomerReferralOffer["advocateRewardKind"]
    | null
    | undefined,
  advocatePointsAwarded: string | number | bigint,
  pointNameSingular = "Point",
  pointNamePlural = "Points",
) {
  return advocateRewardKind === "coupon"
    ? null
    : formatCustomerPoints(
        advocatePointsAwarded,
        pointNameSingular,
        pointNamePlural,
      );
}

function referralShareLinks(url: string, programName: string) {
  const encodedUrl = encodeURIComponent(url);
  const message = encodeURIComponent(
    `Join me in ${programName} and claim your welcome reward.`,
  );
  return {
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`,
    x: `https://x.com/intent/post?url=${encodedUrl}&text=${message}`,
    email: `mailto:?subject=${encodeURIComponent(`Your ${programName} invitation`)}&body=${message}%0A%0A${encodedUrl}`,
  };
}

export function customerRewardStatusLabel(status: CustomerReward["status"]) {
  switch (status) {
    case "available":
      return "Available";
    case "used":
      return "Used";
    case "expired":
      return "Expired";
    case "cancelled":
      return "Cancelled";
  }
}

export function customerRewardStatusDetail(
  reward: CustomerReward,
  locale?: string,
) {
  const issuedDate = formatCustomerRewardDate(reward.issuedAt, locale);
  const expiryDate = formatCustomerRewardDate(reward.expiresAt, locale);
  const statusDate = formatCustomerRewardDate(reward.statusDate, locale);
  const statusLabel = customerRewardStatusLabel(reward.status);

  if (reward.status === "used") {
    return `Used${statusDate ? ` on ${statusDate}` : ""}${reward.orderName ? ` · Order ${reward.orderName}` : ""}`;
  }
  if (reward.status === "expired") {
    return `Expired${statusDate ? ` on ${statusDate}` : ""}`;
  }
  if (reward.status === "cancelled") {
    return `Cancelled${statusDate ? ` on ${statusDate}` : ""}`;
  }
  if (expiryDate) return `Expires ${expiryDate}`;
  return `${statusLabel}${issuedDate ? ` · Issued ${issuedDate}` : ""}`;
}

export function normalizeIssuedRewardArtifact(issued: {
  artifactKind?: "discount_code" | "gift_card" | "store_credit";
  artifactCode?: string | null;
  giftCardCode?: string | null;
  discountCode?: string | null;
}) {
  const artifactKind = issued.artifactKind || "discount_code";
  return {
    artifactKind,
    artifactCode:
      artifactKind === "store_credit"
        ? null
        : issued.artifactCode ||
          issued.giftCardCode ||
          issued.discountCode ||
          null,
  };
}

export function CustomerRewardCard({
  reward,
  rewardDefinition,
  currency = "USD",
  actionsEnabled = true,
}: {
  reward: CustomerReward;
  rewardDefinition?: Reward;
  currency?: string;
  actionsEnabled?: boolean;
}) {
  const clipboardId = `weletic-reward-${reward.id}`;
  const statusLabel = customerRewardStatusLabel(reward.status);
  const statusDetail = customerRewardStatusDetail(reward);
  const showStatusDetail = statusDetail !== statusLabel;
  const useLegacyDefinition =
    !reward.termsSnapshot && reward.termsSource !== "unavailable";
  const termsDefinition =
    reward.termsSnapshot ??
    (useLegacyDefinition ? rewardDefinition : undefined);
  const termsCurrency = reward.termsSnapshot?.currency || currency;
  const terms = termsDefinition
    ? customerRewardTerms(termsDefinition, termsCurrency)
    : [];
  const artifactKind = reward.artifactKind || "discount_code";
  const artifactCode =
    artifactKind === "store_credit"
      ? null
      : reward.artifactCode ||
        reward.giftCardCode ||
        reward.discountCode ||
        null;
  const artifactLabel =
    artifactKind === "gift_card"
      ? "Gift card code"
      : artifactKind === "store_credit"
        ? "Shopify store credit"
        : "Discount code";

  return (
    <s-stack
      direction="block"
      gap="base"
      border="base"
      borderRadius="base"
      padding="base"
      accessibilityRole="list-item"
    >
      <s-stack direction="block" gap="small-200">
        <s-text type="strong">{reward.rewardName}</s-text>
        {reward.rewardDescription ? (
          <s-text color="subdued">{reward.rewardDescription}</s-text>
        ) : null}
        <s-badge
          icon={reward.status === "available" ? "check-circle" : "clock"}
          color={reward.status === "available" ? "base" : "subdued"}
        >
          {statusLabel}
        </s-badge>
        {showStatusDetail ? (
          <s-text color="subdued">{statusDetail}</s-text>
        ) : null}
      </s-stack>

      {termsDefinition ? (
        <s-stack direction="block" gap="small-100">
          <s-text color="subdued" type="small">
            {customerRewardTypeLabel(termsDefinition.rewardType)}
          </s-text>
          {terms.map((term) => (
            <s-text key={term} color="subdued" type="small">
              {term}
            </s-text>
          ))}
          {useLegacyDefinition && rewardDefinition ? (
            <s-text color="subdued" type="small">
              Original terms are unavailable for this legacy reward; current
              reward terms are shown.
            </s-text>
          ) : null}
        </s-stack>
      ) : reward.termsSource === "legacy" ||
        reward.termsSource === "unavailable" ? (
        <s-text color="subdued" type="small">
          {reward.termsSource === "unavailable"
            ? "Original reward terms could not be verified and are unavailable."
            : "Original terms are unavailable for this legacy reward."}
        </s-text>
      ) : null}

      <s-stack direction="block" gap="small-100">
        <s-text color="subdued" type="small">
          {artifactLabel}
        </s-text>
        <s-text type="strong">
          {artifactKind === "store_credit"
            ? "Added to your customer balance"
            : artifactCode}
        </s-text>
        <s-text color="subdued" type="small">
          {formatCustomerPoints(reward.pointsSpent)} redeemed
        </s-text>
      </s-stack>

      {actionsEnabled && reward.status === "available" && artifactCode ? (
        <>
          <s-clipboard-item id={clipboardId} text={artifactCode} />
          <s-button-group
            accessibilityLabel={`Actions for ${reward.rewardName}`}
          >
            <s-button
              slot="secondary-actions"
              command="--copy"
              commandFor={clipboardId}
              variant="secondary"
            >
              Copy code
            </s-button>
            {reward.applyUrl ? (
              <s-button
                slot="primary-action"
                href={reward.applyUrl}
                target="_blank"
                variant="primary"
              >
                Use reward
              </s-button>
            ) : null}
          </s-button-group>
        </>
      ) : null}
    </s-stack>
  );
}

export function RedeemRewardCard({
  reward,
  pointsBalance,
  redeeming,
  onRedeem,
  selectedPoints: selectedPointsProp,
  onPointsChange,
  currency = "USD",
}: {
  reward: Reward;
  pointsBalance: string | number | bigint;
  redeeming: string | null;
  onRedeem: (reward: Reward, pointsRequested?: string) => void;
  selectedPoints?: string;
  onPointsChange?: (points: string) => void;
  currency?: string;
}) {
  const balance = readExactUnsignedInteger(pointsBalance) ?? BigInt(0);
  const pointsCost = readExactUnsignedInteger(reward.pointsCost);
  const minimum = readExactUnsignedInteger(
    reward.minPointsCost ?? reward.pointsCost,
  );
  const configuredMaximum = reward.maxPointsCost
    ? readExactUnsignedInteger(reward.maxPointsCost)
    : null;
  const maximum =
    configuredMaximum !== null && configuredMaximum < balance
      ? configuredMaximum
      : balance;
  const step = readExactUnsignedInteger(reward.pointsStep ?? reward.pointsCost);
  const selectedPoints =
    selectedPointsProp ?? minimum?.toString() ?? reward.pointsCost;
  const incrementalSelection = validateIncrementalPointsSelection({
    pointsRequested: selectedPoints,
    pointsBalance,
    pointsCost: reward.pointsCost,
    minPointsCost: reward.minPointsCost,
    maxPointsCost: reward.maxPointsCost,
    pointsStep: reward.pointsStep,
  });
  const requiredCost =
    reward.exchangeType === "incremental" ? minimum : pointsCost;
  const pointsRemaining =
    requiredCost !== null && requiredCost > balance
      ? requiredCost - balance
      : BigInt(0);
  const terms = customerRewardTerms(reward, currency);
  const minimumNumber = toSafeNumber(minimum);
  const maximumNumber = toSafeNumber(maximum);
  const stepNumber = toSafeNumber(step);
  const hasExactStepperBounds =
    minimumNumber !== undefined &&
    maximumNumber !== undefined &&
    stepNumber !== undefined;

  return (
    <s-stack
      direction="block"
      gap="base"
      border="base"
      borderRadius="base"
      padding="base"
      accessibilityRole="list-item"
    >
      <s-stack direction="block" gap="small-200">
        <s-text type="strong">{reward.name}</s-text>
        {reward.description ? (
          <s-text color="subdued">{reward.description}</s-text>
        ) : null}
        <s-badge>{customerRewardTypeLabel(reward.rewardType)}</s-badge>
        <s-text>
          {reward.exchangeType === "incremental"
            ? `From ${(minimum ?? BigInt(0)).toLocaleString()} points`
            : `${(pointsCost ?? BigInt(0)).toLocaleString()} points`}
        </s-text>
        {!reward.canRedeem && pointsRemaining > BigInt(0) ? (
          <s-text color="subdued" type="small">
            Earn {pointsRemaining.toLocaleString()} more points to redeem.
          </s-text>
        ) : null}
      </s-stack>
      {terms.length > 0 ? (
        <s-stack direction="block" gap="small-100">
          {terms.map((term) => (
            <s-text key={term} color="subdued" type="small">
              {term}
            </s-text>
          ))}
        </s-stack>
      ) : null}
      {reward.exchangeType === "incremental" ? (
        <s-number-field
          label="Points to redeem"
          min={minimumNumber}
          max={maximumNumber}
          step={stepNumber}
          controls={hasExactStepperBounds ? "auto" : "none"}
          value={selectedPoints}
          error={incrementalSelection.error || undefined}
          onInput={(event) =>
            onPointsChange?.(
              (event.currentTarget as EventTarget & { value?: string }).value ??
                "",
            )
          }
        />
      ) : null}
      <s-button
        disabled={
          !reward.canRedeem ||
          redeeming !== null ||
          pointsCost === null ||
          (reward.exchangeType === "incremental"
            ? !incrementalSelection.valid
            : pointsCost > balance)
        }
        loading={redeeming === reward.id}
        onClick={() => {
          if (reward.exchangeType === "incremental") {
            if (!incrementalSelection.valid) return;
            onRedeem(reward, incrementalSelection.pointsRequested);
            return;
          }
          onRedeem(reward);
        }}
        variant={reward.canRedeem ? "primary" : "secondary"}
      >
        Redeem
      </s-button>
    </s-stack>
  );
}

async function authenticatedRequest(path: string, init?: RequestInit) {
  const method = init?.method?.toUpperCase() || "GET";
  if (method !== "GET" && method !== "HEAD") {
    const token = await shopify.sessionToken.get();
    return fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: {
        ...init?.headers,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
  }

  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(
        new Error("Rewards are taking too long to load. Please try again."),
      );
    }, CUSTOMER_REQUEST_TIMEOUT_MS);
  });

  try {
    const requestPromise = (async () => {
      const token = await shopify.sessionToken.get();
      return fetch(`${API_BASE_URL}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          ...init?.headers,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });
    })();
    return await Promise.race([requestPromise, timeoutPromise]);
  } finally {
    clearTimeout(timeout!);
  }
}

export default function extension() {
  render(<CustomerAccountLoyalty />, document.body);
}

export function CustomerAccountLoyalty() {
  const [summary, setSummary] = useState<LoyaltySummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [redeeming, setRedeeming] = useState<string | null>(null);
  const [issuedReward, setIssuedReward] = useState<{
    artifactKind: "discount_code" | "gift_card" | "store_credit";
    artifactCode: string | null;
  } | null>(null);
  const [birthMonth, setBirthMonth] = useState("1");
  const [birthDay, setBirthDay] = useState("1");
  const [savingBirthday, setSavingBirthday] = useState(false);
  const [claimingActivity, setClaimingActivity] = useState<string | null>(null);
  const [activitySuccess, setActivitySuccess] = useState<string | null>(null);
  const [activityView, setActivityView] = useState<
    "points" | "referrals" | "vip"
  >("points");
  const [extraActivities, setExtraActivities] = useState<{
    points: Array<NonNullable<LoyaltySummary["recentActivity"]>[number]>;
    referrals: Array<
      NonNullable<NonNullable<LoyaltySummary["referral"]>["activity"]>[number]
    >;
    vip: Array<
      NonNullable<NonNullable<LoyaltySummary["tier"]>["history"]>[number]
    >;
  }>({
    points: [],
    referrals: [],
    vip: [],
  });
  const [activityPagination, setActivityPagination] = useState<{
    points: { page: number; hasMore: boolean; loading: boolean };
    referrals: { page: number; hasMore: boolean; loading: boolean };
    vip: { page: number; hasMore: boolean; loading: boolean };
  }>({
    points: { page: 1, hasMore: true, loading: false },
    referrals: { page: 1, hasMore: true, loading: false },
    vip: { page: 1, hasMore: true, loading: false },
  });

  async function loadMoreActivity(type: "points" | "referrals" | "vip") {
    const current = activityPagination[type];
    if (current.loading || !current.hasMore) return;
    setActivityPagination((prev) => ({
      ...prev,
      [type]: { ...prev[type], loading: true },
    }));
    try {
      const nextPage = current.page + 1;
      const response = await authenticatedRequest(
        `/customer/activity?type=${type}&page=${nextPage}&limit=20`,
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(
          payload?.error?.message || "Failed to load more activity",
        );
      }
      const data = payload.data || payload;
      const newItems = data.activities || [];
      setExtraActivities((prev) => ({
        ...prev,
        [type]: [...prev[type], ...newItems],
      }));
      setActivityPagination((prev) => ({
        ...prev,
        [type]: {
          page: nextPage,
          hasMore: Boolean(data.pagination?.hasMore),
          loading: false,
        },
      }));
    } catch {
      setActivityPagination((prev) => ({
        ...prev,
        [type]: { ...prev[type], loading: false },
      }));
    }
  }
  const [rewardPointSelections, setRewardPointSelections] = useState<
    Record<string, string>
  >({});
  const redemptionIntentKeys = useRef(new Map<string, string>());
  const activityIntentKeys = useRef(new Map<string, string>());

  async function loadSummary() {
    setError(null);
    const response = await authenticatedRequest("/customer");
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload?.error?.message || "Unable to load rewards");
    }
    setSummary(payload.data || payload);
  }

  function handleSummaryError(cause: unknown) {
    setError(cause instanceof Error ? cause.message : "Unable to load rewards");
  }

  useEffect(() => {
    loadSummary().catch(handleSummaryError);
  }, []);

  async function retrySummary() {
    try {
      await loadSummary();
    } catch (cause) {
      handleSummaryError(cause);
    }
  }

  async function redeem(reward: Reward, pointsRequested?: string) {
    if (
      !customerCanParticipate(
        summary?.program?.isActive === true,
        summary?.account,
      )
    ) {
      setError("This loyalty account cannot redeem rewards right now.");
      return;
    }
    setRedeeming(reward.id);
    setError(null);
    const intentId = `${reward.id}:${pointsRequested ?? reward.pointsCost}`;
    const idempotencyKey = getOrCreateRedemptionIntentKey(
      redemptionIntentKeys.current,
      intentId,
    );
    try {
      const response = await authenticatedRequest("/customer/redeem", {
        method: "POST",
        body: JSON.stringify({
          rewardDefinitionId: reward.id,
          ...(pointsRequested !== undefined ? { pointsRequested } : {}),
          idempotencyKey,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error?.message || "Unable to redeem reward");
      }
      // Only a successful response proves the issued coupon reached the UI.
      // Transport failures and gateway/core errors retain the key so the next
      // click safely replays the same durable saga.
      if (shouldClearRedemptionIntentKey(response.status)) {
        redemptionIntentKeys.current.delete(intentId);
      }
      const issued = payload.data || payload;
      setIssuedReward(normalizeIssuedRewardArtifact(issued));
      // Coupon issuance has already succeeded. A stale summary must not turn
      // that success into a redemption error or hide the delivered code.
      await loadSummary().catch(() => undefined);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to redeem reward",
      );
    } finally {
      setRedeeming(null);
    }
  }

  async function saveBirthday() {
    if (
      !customerCanParticipate(
        summary?.program?.isActive === true,
        summary?.account,
      )
    ) {
      setError("This loyalty account cannot update earning details right now.");
      return;
    }
    setSavingBirthday(true);
    setError(null);
    try {
      const response = await authenticatedRequest("/customer/birthday", {
        method: "POST",
        body: JSON.stringify({
          birthMonth: Number(birthMonth),
          birthDay: Number(birthDay),
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error?.message || "Unable to save birthday");
      }
      await loadSummary();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to save birthday",
      );
    } finally {
      setSavingBirthday(false);
    }
  }

  async function claimActivity(way: WayToEarn) {
    if (!way.action) return;
    if (
      !customerCanParticipate(
        summary?.program?.isActive === true,
        summary?.account,
      )
    ) {
      setError("This loyalty account cannot earn points right now.");
      return;
    }
    setClaimingActivity(way.id);
    setActivitySuccess(null);
    setError(null);
    const claimKey = getOrCreateRedemptionIntentKey(
      activityIntentKeys.current,
      way.id,
    );
    try {
      const response = await authenticatedRequest("/customer/activity/claim", {
        method: "POST",
        body: JSON.stringify({ ruleId: way.id, claimKey }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(
          payload?.error?.message || "Unable to complete earning action",
        );
      }
      activityIntentKeys.current.delete(way.id);
      const result = payload.data || payload;
      setActivitySuccess(
        result.alreadyCompleted
          ? `${way.name} was already completed for this earning period.`
          : `${result.pointsAwarded} points added for ${way.name}.`,
      );
      await loadSummary().catch(() => undefined);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to complete earning action",
      );
    } finally {
      setClaimingActivity(null);
    }
  }

  if (error && !summary) {
    return (
      <s-page heading="Loyalty Hub" subheading="Your member benefits">
        <s-stack direction="block" gap="base">
          <s-banner tone="critical">{error}</s-banner>
          <s-button onClick={retrySummary} variant="primary">
            Try again
          </s-button>
        </s-stack>
      </s-page>
    );
  }
  if (!summary) {
    return (
      <s-page heading="Loyalty Hub" subheading="Your member benefits">
        <s-stack direction="block" gap="base">
          <s-section heading="Points balance">
            <s-skeleton-paragraph content="0 points · Member" />
          </s-section>
          <s-section heading="Your rewards">
            <s-skeleton-paragraph content="Your available rewards are loading" />
          </s-section>
        </s-stack>
      </s-page>
    );
  }
  if (!summary.isEnrolled) {
    return (
      <s-page heading="Loyalty Hub" subheading="Your member benefits">
        <s-banner tone="info">
          Your loyalty account will appear after you join this store’s rewards
          program.
        </s-banner>
      </s-page>
    );
  }

  const points = summary.account?.pointsBalance || "0";
  const pending = summary.account?.pendingPoints || "0";
  const tier = summary.tier?.currentTier?.name || "Member";
  const wallet = summary.rewardWallet || [];
  const programIsActive = summary.program?.isActive === true;
  const canParticipate = customerCanParticipate(
    programIsActive,
    summary.account,
  );
  const rewardCatalog = canParticipate
    ? (summary.rewards || []).filter(isOnlineStoreReward)
    : [];
  const waysToEarn = canParticipate ? summary.waysToEarn || [] : [];
  const activeCampaigns = canParticipate ? summary.activeCampaigns || [] : [];
  const availableRewards = wallet.filter(
    (reward) => reward.status === "available",
  );
  const rewardHistory = wallet.filter(
    (reward) => reward.status !== "available",
  );
  const exactPoints = readExactUnsignedInteger(points) ?? BigInt(0);
  const nextTier = summary.tier?.nextTier;
  const legacySpendProgress = nextTier
    ? calculateExactCustomerProgress(
        summary.tier?.rollingSpend || "0",
        nextTier.minSpendThreshold || "0",
      )
    : null;
  const tierProgress =
    summary.tier?.progress ||
    (legacySpendProgress
      ? {
          milestoneMode: "amount_spent" as const,
          percent: legacySpendProgress.percent,
          spendRemaining: legacySpendProgress.remaining,
          pointsRemaining: "0",
        }
      : null);
  const programName = summary.program?.name || "Loyalty Program";
  const pointNameSingular = summary.program?.pointNameSingular || "Point";
  const pointNamePlural = summary.program?.pointNamePlural || "Points";
  const currency = summary.program?.currency || "USD";
  const rewardDefinitionById = new Map(
    rewardCatalog.map((reward) => [reward.id, reward]),
  );
  const nextReward = [...rewardCatalog]
    .sort((left, right) => {
      const leftCost = readExactUnsignedInteger(
        left.minPointsCost ?? left.pointsCost,
      );
      const rightCost = readExactUnsignedInteger(
        right.minPointsCost ?? right.pointsCost,
      );
      if (leftCost === null) return 1;
      if (rightCost === null) return -1;
      return leftCost < rightCost ? -1 : leftCost > rightCost ? 1 : 0;
    })
    .find((reward) => {
      const cost = readExactUnsignedInteger(
        reward.minPointsCost ?? reward.pointsCost,
      );
      return cost !== null && cost > exactPoints;
    });
  const nextRewardCost = nextReward
    ? readExactUnsignedInteger(
        nextReward.minPointsCost ?? nextReward.pointsCost,
      )
    : null;
  const nextRewardProgress = nextRewardCost
    ? calculateExactCustomerProgress(points, nextRewardCost)
    : null;
  const referralOffer = canParticipate ? summary.referral?.offer : null;
  const referralCopy = referralOffer
    ? customerReferralOfferCopy(
        referralOffer,
        pointNameSingular,
        pointNamePlural,
      )
    : null;
  const shareLinks =
    referralOffer && summary.referral?.referralShareUrl
      ? referralShareLinks(summary.referral.referralShareUrl, programName)
      : null;

  return (
    <s-page
      heading="Loyalty Hub"
      inlineSize="large"
      subheading={
        summary.program?.branding?.subtitle ??
        "Earn points, unlock rewards, and enjoy member benefits."
      }
    >
      <s-stack direction="block" gap="base">
        {issuedReward ? (
          <s-banner tone="success">
            {issuedReward.artifactKind === "store_credit"
              ? "Reward issued. Store credit was added to your Shopify customer balance."
              : issuedReward.artifactKind === "gift_card"
                ? issuedReward.artifactCode
                  ? `Reward issued. Your gift card code is ${issuedReward.artifactCode}.`
                  : "Reward issued. Your gift card is available in Your rewards."
                : issuedReward.artifactCode
                  ? `Reward issued. Your discount code is ${issuedReward.artifactCode}.`
                  : "Reward issued. Your discount is available in Your rewards."}
          </s-banner>
        ) : null}
        {activitySuccess ? (
          <s-banner tone="success">{activitySuccess}</s-banner>
        ) : null}
        {error ? <s-banner tone="critical">{error}</s-banner> : null}
        {!programIsActive ? (
          <s-banner tone="info">
            This loyalty program is currently paused. Rewards already in your
            wallet remain visible.
          </s-banner>
        ) : null}
        {programIsActive && !canParticipate ? (
          <s-banner tone="warning">
            Your loyalty account is currently{" "}
            {summary.account?.status || "unavailable"}. Existing wallet rewards
            remain visible, but earning, redemption, and referrals are
            unavailable.
          </s-banner>
        ) : null}

        <s-query-container>
          <s-grid
            gridTemplateColumns="@container (inline-size > 760px) 2fr 1fr, 1fr"
            gap="base"
            alignItems="start"
          >
            <s-section
              heading={summary.program?.branding?.title || programName}
            >
              <s-stack direction="block" gap="small-200">
                {summary.program?.branding?.heroImageUrl ? (
                  <s-image
                    src={summary.program.branding.heroImageUrl}
                    alt="Loyalty program rewards"
                    aspectRatio="16/5"
                    inlineSize="fill"
                    objectFit="cover"
                    borderRadius="base"
                  />
                ) : null}
                <s-text color="subdued">
                  Welcome
                  {summary.shopper?.firstName
                    ? `, ${summary.shopper.firstName}`
                    : ""}
                  . Your points, VIP status, coupons, and member activity are
                  all available here.
                </s-text>
              </s-stack>
            </s-section>

            <s-stack direction="block" gap="base">
              <s-section heading={`${pointNamePlural} balance`}>
                <s-stack direction="block" gap="small-200">
                  <s-heading>
                    {formatCustomerPoints(
                      points,
                      pointNameSingular,
                      pointNamePlural,
                    )}
                  </s-heading>
                  <s-text color="subdued">
                    {formatCustomerPoints(
                      pending,
                      pointNameSingular,
                      pointNamePlural,
                    )}{" "}
                    pending
                  </s-text>
                  <s-text color="subdued" type="small">
                    {formatCustomerPoints(
                      summary.account?.lifetimePointsEarned || 0,
                      pointNameSingular,
                      pointNamePlural,
                    )}{" "}
                    earned since joining
                  </s-text>
                  {summary.pointsExpiry?.enabled ? (
                    <s-banner tone="warning">
                      {summary.pointsExpiry.nextExpiryDate
                        ? `${pointNamePlural} may expire on ${formatCustomerRewardDate(summary.pointsExpiry.nextExpiryDate)}.`
                        : summary.pointsExpiry.days
                          ? `${pointNamePlural} expire after ${summary.pointsExpiry.days} days without qualifying activity.`
                          : `${pointNamePlural} expire after ${summary.pointsExpiry.months} months without qualifying activity.`}
                    </s-banner>
                  ) : null}
                </s-stack>
              </s-section>

              <s-section heading="Current VIP tier">
                <s-stack direction="block" gap="small-200">
                  <s-heading>{tier}</s-heading>
                  {summary.tier?.currentTier?.pointsMultiplier &&
                  summary.tier.currentTier.pointsMultiplier > 1 ? (
                    <s-badge icon="star">
                      {summary.tier.currentTier.pointsMultiplier}× earning rate
                    </s-badge>
                  ) : null}
                  {summary.tier?.tierExpiresAt ? (
                    <s-text color="subdued" type="small">
                      Attained until{" "}
                      {formatCustomerRewardDate(summary.tier.tierExpiresAt)}
                    </s-text>
                  ) : null}
                  {nextTier && tierProgress ? (
                    <>
                      <s-text>
                        {tierProgress.percent}% toward {nextTier.name}
                      </s-text>
                      <s-progress
                        value={tierProgress.percent}
                        max={100}
                        accessibilityLabel={`Progress toward ${nextTier.name}`}
                      />
                      {tierProgress.milestoneMode !== "points_earned" ? (
                        <s-text color="subdued" type="small">
                          {formatStoreMinorCurrency(
                            tierProgress.spendRemaining,
                            currency,
                          )}{" "}
                          more qualifying spend
                        </s-text>
                      ) : null}
                      {tierProgress.milestoneMode !== "amount_spent" ? (
                        <s-text color="subdued" type="small">
                          {formatCustomerPoints(
                            tierProgress.pointsRemaining,
                            pointNameSingular,
                            pointNamePlural,
                          )}{" "}
                          more to reach {nextTier.name}
                        </s-text>
                      ) : null}
                    </>
                  ) : (
                    <s-text color="subdued">
                      You are in the highest current tier.
                    </s-text>
                  )}
                  {(summary.tier?.perks || []).map((perk) => (
                    <s-badge key={perk} icon="check-circle">
                      {perk}
                    </s-badge>
                  ))}
                </s-stack>
              </s-section>
            </s-stack>
          </s-grid>
        </s-query-container>

        <s-section heading="Your rewards">
          {availableRewards.length > 0 ? (
            <s-grid
              gridTemplateColumns="repeat(auto-fit, minmax(240px, 1fr))"
              gap="base"
              accessibilityRole="unordered-list"
            >
              {availableRewards.map((reward) => (
                <CustomerRewardCard
                  key={reward.id}
                  reward={reward}
                  rewardDefinition={
                    reward.rewardDefinitionId
                      ? rewardDefinitionById.get(reward.rewardDefinitionId)
                      : undefined
                  }
                  currency={currency}
                  actionsEnabled={canParticipate}
                />
              ))}
            </s-grid>
          ) : (
            <s-text color="subdued">
              {canParticipate
                ? `Redeem your ${pointNamePlural.toLowerCase()} below to add a reward to your wallet.`
                : "You do not have any issued rewards in your wallet."}
            </s-text>
          )}
        </s-section>

        {canParticipate ? (
          <s-section heading={`Spend ${pointNamePlural}`}>
            <s-stack direction="block" gap="base">
              {nextReward &&
              nextRewardCost &&
              nextRewardCost > BigInt(0) &&
              nextRewardProgress ? (
                <s-stack direction="block" gap="small-200">
                  <s-text>
                    {formatCustomerPoints(
                      nextRewardCost > exactPoints
                        ? nextRewardCost - exactPoints
                        : BigInt(0),
                      pointNameSingular,
                      pointNamePlural,
                    )}{" "}
                    until {nextReward.name}
                  </s-text>
                  <s-progress
                    value={nextRewardProgress.value}
                    max={nextRewardProgress.max}
                    accessibilityLabel={`Progress toward ${nextReward.name}`}
                  />
                </s-stack>
              ) : null}
              {rewardCatalog.length > 0 ? (
                <s-grid
                  gridTemplateColumns="repeat(auto-fit, minmax(240px, 1fr))"
                  gap="base"
                  accessibilityRole="unordered-list"
                >
                  {rewardCatalog.map((reward) => (
                    <RedeemRewardCard
                      key={reward.id}
                      reward={reward}
                      pointsBalance={points}
                      redeeming={redeeming}
                      onRedeem={redeem}
                      currency={currency}
                      selectedPoints={
                        rewardPointSelections[reward.id] ??
                        reward.minPointsCost ??
                        reward.pointsCost
                      }
                      onPointsChange={(selected) =>
                        setRewardPointSelections((current) => ({
                          ...current,
                          [reward.id]: selected,
                        }))
                      }
                    />
                  ))}
                </s-grid>
              ) : (
                <s-text color="subdued">
                  There are no rewards available to redeem right now.
                </s-text>
              )}
            </s-stack>
          </s-section>
        ) : null}

        {canParticipate ? (
          <s-section heading={`Ways to earn ${pointNamePlural}`}>
            {waysToEarn.length > 0 ? (
              <s-grid
                gridTemplateColumns="repeat(auto-fit, minmax(240px, 1fr))"
                gap="base"
              >
                {waysToEarn.map((way) => (
                  <s-stack
                    key={way.id}
                    direction="block"
                    gap="small-200"
                    border="base"
                    borderRadius="base"
                    padding="base"
                  >
                    <s-text type="strong">{way.name}</s-text>
                    <s-text color="subdued">
                      {earningValueLabel(
                        way,
                        pointNameSingular,
                        pointNamePlural,
                      )}
                    </s-text>
                    {way.description ? (
                      <s-text color="subdued" type="small">
                        {way.description}
                      </s-text>
                    ) : null}
                    {way.action ? (
                      <>
                        <s-button
                          href={way.action.url}
                          target="_blank"
                          loading={claimingActivity === way.id}
                          disabled={claimingActivity !== null}
                          onClick={() => claimActivity(way)}
                          variant="secondary"
                        >
                          {way.action.label}
                        </s-button>
                        <s-text color="subdued" type="small">
                          Points are awarded when this signed customer action is
                          opened. The social network does not confirm
                          completion.
                        </s-text>
                      </>
                    ) : null}
                  </s-stack>
                ))}
              </s-grid>
            ) : (
              <s-text color="subdued">No earning actions are active.</s-text>
            )}
          </s-section>
        ) : null}

        {activeCampaigns.length > 0 ? (
          <s-section heading="Bonus campaigns">
            <s-stack direction="block" gap="base">
              {activeCampaigns.map((campaign) => (
                <s-banner key={campaign.id} tone="info">
                  {campaign.multiplier}× {campaign.name}
                  {campaign.description ? ` — ${campaign.description}` : ""}.
                  Ends {formatCustomerRewardDate(campaign.endAt)}.
                </s-banner>
              ))}
            </s-stack>
          </s-section>
        ) : null}

        {referralOffer &&
        referralCopy &&
        summary.referral?.referralShareUrl &&
        shareLinks ? (
          <s-section heading="Refer a friend">
            <s-stack direction="block" gap="base">
              <s-heading>{referralCopy.heading}</s-heading>
              <s-text color="subdued">
                {referralCopy.qualification}
                {referralOffer.minQualifyingOrderSubtotal
                  ? ` Minimum qualifying subtotal: ${formatStoreCurrency(referralOffer.minQualifyingOrderSubtotal, currency)}.`
                  : ""}
              </s-text>
              <s-text>
                {summary.referral.qualifiedReferrals || 0} of{" "}
                {summary.referral.totalReferrals || 0} invited friends have
                qualified
                {referralCopy.showPointsEarned
                  ? ` · ${formatCustomerPoints(
                      summary.referral.totalPointsEarned || 0,
                      pointNameSingular,
                      pointNamePlural,
                    )} earned`
                  : ""}
              </s-text>
              <s-clipboard-item
                id="weletic-referral-link"
                text={summary.referral.referralShareUrl}
              />
              <s-stack direction="inline" gap="small-200">
                <s-button
                  command="--copy"
                  commandFor="weletic-referral-link"
                  variant="primary"
                >
                  Copy link
                </s-button>
                <s-button href={shareLinks.facebook} target="_blank">
                  Facebook
                </s-button>
                <s-button href={shareLinks.x} target="_blank">
                  X
                </s-button>
                <s-button href={shareLinks.email}>Email</s-button>
              </s-stack>
            </s-stack>
          </s-section>
        ) : null}

        {(summary.tier?.allTiers || []).length > 0 ? (
          <s-section heading="VIP tiers">
            <s-stack direction="block" gap="base">
              <s-text color="subdued">
                Qualification uses{" "}
                {summary.program?.vipTimeframe.replaceAll("_", " ") ||
                  "the configured period"}
                .
              </s-text>
              <s-grid
                gridTemplateColumns="repeat(auto-fit, minmax(240px, 1fr))"
                gap="base"
              >
                {(summary.tier?.allTiers || []).map((tierDefinition) => (
                  <s-stack
                    key={tierDefinition.id}
                    direction="block"
                    gap="small-200"
                    border="base"
                    borderRadius="base"
                    padding="base"
                  >
                    <s-stack
                      direction="inline"
                      gap="small-200"
                      alignItems="center"
                    >
                      <s-text type="strong">{tierDefinition.name}</s-text>
                      {tierDefinition.id === summary.tier?.currentTier?.id ? (
                        <s-badge icon="check-circle">Current tier</s-badge>
                      ) : null}
                    </s-stack>
                    <s-text color="subdued">
                      {tierDefinition.pointsMultiplier}× earning rate
                    </s-text>
                    {(readExactUnsignedInteger(
                      tierDefinition.minPointsThreshold,
                    ) ?? BigInt(0)) > BigInt(0) ? (
                      <s-text color="subdued" type="small">
                        {formatCustomerPoints(
                          tierDefinition.minPointsThreshold,
                          pointNameSingular,
                          pointNamePlural,
                        )}{" "}
                        required
                      </s-text>
                    ) : null}
                    {(readExactUnsignedInteger(
                      tierDefinition.minSpendThreshold,
                    ) ?? BigInt(0)) > BigInt(0) ? (
                      <s-text color="subdued" type="small">
                        {formatStoreMinorCurrency(
                          tierDefinition.minSpendThreshold,
                          currency,
                        )}{" "}
                        qualifying spend required
                      </s-text>
                    ) : null}
                    {(tierDefinition.perks || []).map((perk) => (
                      <s-text key={perk} color="subdued" type="small">
                        {perk}
                      </s-text>
                    ))}
                  </s-stack>
                ))}
              </s-grid>
            </s-stack>
          </s-section>
        ) : null}

        <s-section heading="Activity">
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="small-200">
              <s-button
                variant={activityView === "points" ? "primary" : "secondary"}
                onClick={() => setActivityView("points")}
              >
                {pointNamePlural}
              </s-button>
              <s-button
                variant={activityView === "referrals" ? "primary" : "secondary"}
                onClick={() => setActivityView("referrals")}
              >
                Referrals
              </s-button>
              <s-button
                variant={activityView === "vip" ? "primary" : "secondary"}
                onClick={() => setActivityView("vip")}
              >
                VIP
              </s-button>
            </s-stack>

            {activityView === "points"
              ? (() => {
                  const initial = summary.recentActivity || [];
                  const seen = new Set(initial.map((a) => a.id));
                  const combined = [
                    ...initial,
                    ...extraActivities.points.filter((a) => !seen.has(a.id)),
                  ];
                  return combined.length > 0 ? (
                    <s-stack direction="block" gap="base">
                      {combined.map((activity) => (
                        <s-stack
                          key={activity.id}
                          direction="inline"
                          gap="base"
                          justifyContent="space-between"
                        >
                          <s-stack direction="block" gap="small-100">
                            <s-text type="strong">
                              {activity.reason ||
                                activity.entryType.replaceAll("_", " ")}
                            </s-text>
                            <s-text color="subdued" type="small">
                              {formatCustomerRewardDate(activity.createdAt)}
                            </s-text>
                          </s-stack>
                          <s-text type="strong">
                            {/^[1-9]\d*$/.test(activity.pointsDelta) ? "+" : ""}
                            {formatCustomerPoints(
                              activity.pointsDelta,
                              pointNameSingular,
                              pointNamePlural,
                            )}
                          </s-text>
                        </s-stack>
                      ))}
                      {activityPagination.points.hasMore &&
                      combined.length >= 20 ? (
                        <s-button
                          onClick={() => loadMoreActivity("points")}
                          loading={activityPagination.points.loading}
                          disabled={activityPagination.points.loading}
                          variant="secondary"
                        >
                          Load more
                        </s-button>
                      ) : null}
                    </s-stack>
                  ) : (
                    <s-text color="subdued">No points activity yet.</s-text>
                  );
                })()
              : null}

            {activityView === "referrals"
              ? (() => {
                  const initial = summary.referral?.activity || [];
                  const seen = new Set(initial.map((a) => a.id));
                  const combined = [
                    ...initial,
                    ...extraActivities.referrals.filter((a) => !seen.has(a.id)),
                  ];
                  return combined.length > 0 ? (
                    <s-stack direction="block" gap="base">
                      {combined.map((activity) => {
                        const rewardLabel = customerReferralActivityRewardLabel(
                          summary.referral?.offer?.advocateRewardKind,
                          activity.advocatePointsAwarded,
                          pointNameSingular,
                          pointNamePlural,
                        );
                        return (
                          <s-stack
                            key={activity.id}
                            direction="inline"
                            gap="base"
                            justifyContent="space-between"
                          >
                            <s-stack direction="block" gap="small-100">
                              <s-text type="strong">
                                {activity.refereeName} ·{" "}
                                {activity.status.replaceAll("_", " ")}
                              </s-text>
                              <s-text color="subdued" type="small">
                                {formatCustomerRewardDate(
                                  activity.rewardedAt || activity.createdAt,
                                )}
                              </s-text>
                            </s-stack>
                            {rewardLabel ? (
                              <s-text>{rewardLabel}</s-text>
                            ) : null}
                          </s-stack>
                        );
                      })}
                      {activityPagination.referrals.hasMore &&
                      combined.length >= 20 ? (
                        <s-button
                          onClick={() => loadMoreActivity("referrals")}
                          loading={activityPagination.referrals.loading}
                          disabled={activityPagination.referrals.loading}
                          variant="secondary"
                        >
                          Load more
                        </s-button>
                      ) : null}
                    </s-stack>
                  ) : (
                    <s-text color="subdued">No referral activity yet.</s-text>
                  );
                })()
              : null}

            {activityView === "vip"
              ? (() => {
                  const initial = summary.tier?.history || [];
                  const seen = new Set(initial.map((a) => a.id));
                  const combined = [
                    ...initial,
                    ...extraActivities.vip.filter((a) => !seen.has(a.id)),
                  ];
                  return combined.length > 0 ? (
                    <s-stack direction="block" gap="base">
                      {combined.map((activity) => (
                        <s-stack
                          key={activity.id}
                          direction="block"
                          gap="small-100"
                        >
                          <s-text type="strong">
                            {activity.fromTier?.name
                              ? `${activity.fromTier.name} → `
                              : ""}
                            {formatCustomerTierDestination(
                              activity.toTier,
                              shopify.localization?.language?.value?.isoCode,
                            )}
                          </s-text>
                          <s-text color="subdued" type="small">
                            {activity.changeReason.replaceAll("_", " ")} ·{" "}
                            {formatCustomerRewardDate(activity.effectiveAt)}
                          </s-text>
                        </s-stack>
                      ))}
                      {activityPagination.vip.hasMore &&
                      combined.length >= 20 ? (
                        <s-button
                          onClick={() => loadMoreActivity("vip")}
                          loading={activityPagination.vip.loading}
                          disabled={activityPagination.vip.loading}
                          variant="secondary"
                        >
                          Load more
                        </s-button>
                      ) : null}
                    </s-stack>
                  ) : (
                    <s-text color="subdued">No VIP activity yet.</s-text>
                  );
                })()
              : null}
          </s-stack>
        </s-section>

        {canParticipate && summary.birthday?.enabled ? (
          <s-section heading="Birthday reward">
            {summary.birthday.isRegistered ? (
              <s-text>
                Birthday saved as {summary.birthday.birthMonth}/
                {summary.birthday.birthDay}. Next eligible year:{" "}
                {summary.birthday.nextEligibleYear || "upcoming"}.
              </s-text>
            ) : (
              <s-stack direction="block" gap="base">
                <s-text color="subdued">
                  Save your month and day at least 30 days early. It can only be
                  changed by support.
                </s-text>
                <s-stack direction="inline" gap="base">
                  <s-number-field
                    label="Birth month"
                    min={1}
                    max={12}
                    value={birthMonth}
                    onInput={(event) =>
                      setBirthMonth(
                        String(
                          (
                            event.currentTarget as EventTarget & {
                              value?: string;
                            }
                          ).value || "1",
                        ),
                      )
                    }
                  />
                  <s-number-field
                    label="Birth day"
                    min={1}
                    max={31}
                    value={birthDay}
                    onInput={(event) =>
                      setBirthDay(
                        String(
                          (
                            event.currentTarget as EventTarget & {
                              value?: string;
                            }
                          ).value || "1",
                        ),
                      )
                    }
                  />
                </s-stack>
                <s-button
                  disabled={savingBirthday}
                  loading={savingBirthday}
                  onClick={saveBirthday}
                  variant="primary"
                >
                  Save birthday
                </s-button>
              </s-stack>
            )}
          </s-section>
        ) : null}

        {rewardHistory.length > 0 ? (
          <s-section heading="Reward history">
            <s-stack
              direction="block"
              gap="base"
              accessibilityRole="unordered-list"
            >
              {rewardHistory.map((reward) => (
                <CustomerRewardCard
                  key={reward.id}
                  reward={reward}
                  rewardDefinition={
                    reward.rewardDefinitionId
                      ? rewardDefinitionById.get(reward.rewardDefinitionId)
                      : undefined
                  }
                  currency={currency}
                />
              ))}
            </s-stack>
          </s-section>
        ) : null}
      </s-stack>
    </s-page>
  );
}
