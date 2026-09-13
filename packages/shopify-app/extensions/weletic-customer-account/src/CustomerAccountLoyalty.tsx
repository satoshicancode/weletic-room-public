/** @jsxImportSource preact */
import type { Api } from "@shopify/ui-extensions/customer-account.page.render";
import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  hubActivityLabel,
  hubDate,
  hubEarningActionLabel,
  hubErrorText,
  hubLocale,
  hubNumber,
  hubRequestError,
  hubText,
} from "./localization";

declare const shopify: Api;

const API_BASE_URL = "https://shopify.weletic.com/api/customer-account/loyalty";
const CUSTOMER_REQUEST_TIMEOUT_MS = 10_000;

export function formatCustomerTierDestination(
  tier: { name: string } | null,
  locale?: string,
) {
  if (tier) return tier.name;
  if (!locale) return hubText("noTier");
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
  return hubDate(date, locale);
}

export function formatCustomerPointsExpiry(
  policy: { nextExpiryDate?: unknown; days?: unknown; months?: unknown },
  pointName: string,
) {
  if (policy.nextExpiryDate != null && policy.nextExpiryDate !== "") {
    const date =
      typeof policy.nextExpiryDate === "string"
        ? formatCustomerRewardDate(policy.nextExpiryDate)
        : null;
    return date
      ? hubText("expiryOn", { name: pointName, date })
      : hubText("expiryUnavailable");
  }
  const validInterval = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0;
  // The customer summary serializes disabled day-based expiry as zero.
  if (policy.days != null && policy.days !== 0) {
    return validInterval(policy.days)
      ? hubText("expiryDays", { name: pointName, days: hubNumber(policy.days) })
      : hubText("expiryUnavailable");
  }
  return validInterval(policy.months)
    ? hubText("expiryMonths", {
        name: pointName,
        months: hubNumber(policy.months),
      })
    : hubText("expiryUnavailable");
}

export function formatSavedCustomerBirthday(birthday: {
  birthMonth?: unknown;
  birthDay?: unknown;
  nextEligibleYear?: unknown;
}) {
  const { birthMonth: month, birthDay: day, nextEligibleYear: year } = birthday;
  if (
    typeof month !== "number" ||
    !Number.isInteger(month) ||
    month < 1 ||
    month > 12 ||
    typeof day !== "number" ||
    !Number.isInteger(day) ||
    day < 1 ||
    day > [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
  ) {
    return hubText("birthdayDetailsUnavailable");
  }
  return hubText("birthdaySaved", {
    month: hubNumber(month),
    day: hubNumber(day),
    year:
      typeof year === "number" &&
      Number.isInteger(year) &&
      year > 0 &&
      year <= 9999
        ? String(year)
        : hubText("yearUnavailable"),
  });
}

export function customerVipCompletionLabel(tier: LoyaltySummary["tier"]) {
  const tiers = tier?.allTiers;
  if (
    tier?.currentTier === null &&
    tier.nextTier === null &&
    Array.isArray(tiers) &&
    tiers.length === 0
  )
    return hubText("vipUnavailable");
  const current = tier?.currentTier;
  if (
    current &&
    typeof current.id === "string" &&
    current.id.length > 0 &&
    Number.isSafeInteger(current.tierOrder) &&
    tier?.nextTier === null &&
    Array.isArray(tiers) &&
    tiers.some(
      (item) => item?.id === current.id && item.tierOrder === current.tierOrder,
    ) &&
    tiers.every(
      (item) =>
        item &&
        Number.isSafeInteger(item.tierOrder) &&
        item.tierOrder <= current.tierOrder,
    )
  )
    return hubText("highestTier");
  return hubText("vipProgressUnavailable");
}

export function customerVipPeriodLabel(period: unknown) {
  switch (period) {
    case "rolling_12m":
      return hubText("periodRolling");
    case "calendar_year":
      return hubText("periodCalendar");
    case "lifetime":
      return hubText("periodLifetime");
    default:
      return hubText("periodUnknown");
  }
}

export function customerAccountStatusLabel(status: unknown) {
  switch (status) {
    case "active":
      return hubText("accountActive");
    case "suspended":
      return hubText("accountSuspended");
    case "closed":
      return hubText("accountClosed");
    default:
      return hubText("accountUnavailable");
  }
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
  pointNameSingular?: string,
  pointNamePlural?: string,
) {
  const amount = readExactSignedInteger(value) ?? BigInt(0);
  if (pointNameSingular === undefined && pointNamePlural === undefined) {
    return hubText(amount === BigInt(1) ? "pointAmount" : "pointsAmount", {
      points: hubNumber(amount),
    });
  }
  return `${hubNumber(amount)} ${amount === BigInt(1) ? pointNameSingular ?? "point" : pointNamePlural ?? "points"}`;
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
      error: hubText("limitsUnavailable"),
    };
  }
  if (requested === null) {
    return {
      valid: false,
      pointsRequested: null,
      error: hubText("wholePoints"),
    };
  }
  if (requested < minimum) {
    return {
      valid: false,
      pointsRequested: null,
      error: hubText("minimumPoints", { points: hubNumber(minimum) }),
    };
  }
  if (maximum !== null && requested > maximum) {
    return {
      valid: false,
      pointsRequested: null,
      error: hubText("maximumPoints", { points: hubNumber(maximum) }),
    };
  }
  if (requested > balance) {
    return {
      valid: false,
      pointsRequested: null,
      error: hubText("insufficientPoints"),
    };
  }
  if (requested % step !== BigInt(0)) {
    return {
      valid: false,
      pointsRequested: null,
      error: hubText("pointsStep", { points: hubNumber(step) }),
    };
  }
  return {
    valid: true,
    pointsRequested: requested.toString(),
    error: null,
  };
}

function storeCurrencyFormatter(currency: string, locale?: string) {
  if (!/^[A-Z]{3}$/i.test(currency)) return null;
  try {
    return new Intl.NumberFormat(hubLocale(locale), {
      style: "currency",
      currency,
    });
  } catch {
    return null;
  }
}

export function formatStoreCurrency(
  value: string | number,
  currency = "USD",
  locale?: string,
) {
  const formatter = storeCurrencyFormatter(currency, locale);
  if (
    !formatter ||
    (typeof value === "number" &&
      (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER))
  ) {
    return hubText("amountUnavailable");
  }
  const decimal = String(value);
  // Wire values are plain decimal strings. Bound parsing; never coerce a
  // malformed or imprecise transport value into a plausible monetary amount.
  const match =
    decimal.length <= 128 ? /^(-?)(\d+)(?:\.(\d+))?$/.exec(decimal) : null;
  if (!match) return hubText("amountUnavailable");
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  const fraction = match[3] || "";
  const scale = BigInt(`1${"0".repeat(digits)}`);
  let minorUnits =
    BigInt(match[2]) * scale +
    BigInt(fraction.slice(0, digits).padEnd(digits, "0") || "0");
  // Intl's default half-expand display rounding, performed on decimal digits.
  if (fraction.length > digits && fraction[digits] >= "5")
    minorUnits += BigInt(1);
  return formatStoreMinorCurrency(
    match[1] ? -minorUnits : minorUnits,
    currency,
    locale,
  );
}

export function formatStoreMinorCurrency(
  value: string | number | bigint,
  currency = "USD",
  locale?: string,
) {
  locale = hubLocale(locale);
  const minorUnits = readExactSignedInteger(value);
  const formatter = storeCurrencyFormatter(currency, locale);
  if (minorUnits === null || !formatter) return hubText("amountUnavailable");
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
      return hubText("typeAmount");
    case "percentage_off":
      return hubText("typePercentage");
    case "free_shipping":
      return hubText("typeShipping");
    case "free_product":
      return hubText("typeProduct");
    case "gift_card":
      return hubText("typeGiftCard");
    case "store_credit":
      return hubText("typeStoreCredit");
    default:
      return hubText("typeReward");
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
    terms.push(hubText("termsPos"));
  } else if (reward.salesChannel === "both") {
    terms.push(hubText("termsBoth"));
  }
  const minimumOrderAmount =
    reward.minOrderAmount == null
      ? null
      : readExactSignedInteger(reward.minOrderAmount);
  if (minimumOrderAmount !== null && minimumOrderAmount > BigInt(0)) {
    terms.push(
      hubText("termsMinimum", {
        amount: formatStoreMinorCurrency(minimumOrderAmount, currency, locale),
      }),
    );
  }
  if (reward.expiresInDays && reward.expiresInDays > 0) {
    terms.push(
      hubText("termsExpiry", { days: hubNumber(reward.expiresInDays) }),
    );
  }
  if (reward.usageLimitPerCustomer) {
    terms.push(
      hubText(
        reward.usageLimitPerCustomer === 1 ? "termsUseOne" : "termsUseMany",
        { uses: hubNumber(reward.usageLimitPerCustomer) },
      ),
    );
  }
  const targetCount =
    reward.entitlementCount ??
    (reward.entitledCollectionIds?.length || 0) +
      (reward.entitledProductIds?.length || 0) +
      (reward.entitledVariantIds?.length || 0);
  if (targetCount > 0) {
    terms.push(hubText("termsSelected"));
  } else if (reward.appliesToResource === "entire_order") {
    terms.push(hubText("termsEntire"));
  }
  if (
    reward.combinesWithProductDiscounts ||
    reward.combinesWithOrderDiscounts ||
    reward.combinesWithShippingDiscounts
  ) {
    terms.push(hubText("termsCombine"));
  }
  return terms;
}

function earningValueLabel(way: WayToEarn, singular: string, plural: string) {
  return way.triggerCode === "order_paid"
    ? hubText("earningPurchase", {
        multiplier: hubNumber(way.multiplier),
        pointsName: plural.toLowerCase(),
      })
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
    ? rewardName || hubText("couponReward")
    : formatCustomerPoints(points, singular, plural);
}

export function customerReferralOfferCopy(
  offer: CustomerReferralOffer,
  pointNameSingular = hubText("pointName"),
  pointNamePlural = hubText("pointsName"),
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
      ? hubText("referralBefore", { reward: friendReward })
      : hubText("referralAfter", { reward: friendReward });
  return {
    heading: hubText("referralHeading", {
      friend: friendReward,
      advocate: advocateReward,
    }),
    qualification: hubText("referralQualification", {
      friendTiming,
      reward: advocateReward,
    }),
    showPointsEarned: offer.advocateRewardKind === "points",
  };
}

export function customerReferralActivityRewardLabel(
  advocateRewardKind:
    | CustomerReferralOffer["advocateRewardKind"]
    | null
    | undefined,
  advocatePointsAwarded: string | number | bigint,
  pointNameSingular = hubText("pointName"),
  pointNamePlural = hubText("pointsName"),
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
    hubText("shareMessage", { program: programName }),
  );
  return {
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`,
    x: `https://x.com/intent/post?url=${encodedUrl}&text=${message}`,
    email: `mailto:?subject=${encodeURIComponent(hubText("shareSubject", { program: programName }))}&body=${message}%0A%0A${encodedUrl}`,
  };
}

export function customerRewardStatusLabel(status: CustomerReward["status"]) {
  switch (status) {
    case "available":
      return hubText("statusAvailable");
    case "used":
      return hubText("statusUsed");
    case "expired":
      return hubText("statusExpired");
    case "cancelled":
      return hubText("statusCancelled");
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
    const status = statusDate
      ? hubText("usedOn", { date: statusDate })
      : statusLabel;
    return reward.orderName
      ? hubText("usedOrder", { status, order: reward.orderName })
      : status;
  }
  if (reward.status === "expired") {
    return statusDate
      ? hubText("expiredOn", { date: statusDate })
      : statusLabel;
  }
  if (reward.status === "cancelled") {
    return statusDate
      ? hubText("cancelledOn", { date: statusDate })
      : statusLabel;
  }
  if (expiryDate) return hubText("expiresDate", { date: expiryDate });
  return issuedDate
    ? hubText("issuedDate", { status: statusLabel, date: issuedDate })
    : statusLabel;
}

export function normalizeIssuedRewardArtifact(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw hubRequestError("redeem");
  }
  const issued = value as Record<string, unknown>;
  if (issued.success !== undefined && issued.success !== true) {
    throw hubRequestError("redeem");
  }
  for (const key of ["artifactCode", "giftCardCode", "discountCode"]) {
    if (issued[key] != null && typeof issued[key] !== "string") {
      throw hubRequestError("redeem");
    }
  }
  const explicitKind = issued.artifactKind;
  if (
    explicitKind !== undefined &&
    explicitKind !== "discount_code" &&
    explicitKind !== "gift_card" &&
    explicitKind !== "store_credit"
  )
    throw hubRequestError("redeem");
  // Legacy responses may omit kind, but must contain a usable code. Empty
  // objects cannot prove issuance. Explicit kinds retain wallet-only support.
  const code =
    [issued.artifactCode, issued.giftCardCode, issued.discountCode].find(
      (candidate): candidate is string =>
        typeof candidate === "string" && candidate.trim().length > 0,
    ) ?? null;
  if (explicitKind === undefined && code === null)
    throw hubRequestError("redeem");
  const artifactKind: "discount_code" | "gift_card" | "store_credit" =
    explicitKind ?? "discount_code";
  return {
    artifactKind,
    artifactCode: artifactKind === "store_credit" ? null : code,
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
  // This is a DOM command target, not a persisted reward identity.
  const clipboardId = `weletic-reward-${crypto.randomUUID()}`;
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
      ? hubText("giftCode")
      : artifactKind === "store_credit"
        ? hubText("storeCredit")
        : hubText("discountCode");

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
              {hubText("legacyCurrent")}
            </s-text>
          ) : null}
        </s-stack>
      ) : reward.termsSource === "legacy" ||
        reward.termsSource === "unavailable" ? (
        <s-text color="subdued" type="small">
          {reward.termsSource === "unavailable"
            ? hubText("termsUnverified")
            : hubText("legacyUnavailable")}
        </s-text>
      ) : null}

      <s-stack direction="block" gap="small-100">
        <s-text color="subdued" type="small">
          {artifactLabel}
        </s-text>
        <s-text type="strong">
          {artifactKind === "store_credit"
            ? hubText("addedBalance")
            : artifactCode}
        </s-text>
        <s-text color="subdued" type="small">
          {hubText("redeemedPoints", {
            points: formatCustomerPoints(reward.pointsSpent),
          })}
        </s-text>
      </s-stack>

      {actionsEnabled && reward.status === "available" && artifactCode ? (
        <>
          <s-clipboard-item id={clipboardId} text={artifactCode} />
          <s-button-group
            accessibilityLabel={hubText("rewardActions", {
              reward: reward.rewardName,
            })}
          >
            <s-button
              slot="secondary-actions"
              command="--copy"
              commandFor={clipboardId}
              variant="secondary"
            >
              {hubText("copyCode")}
            </s-button>
            {reward.applyUrl ? (
              <s-button
                slot="primary-action"
                href={reward.applyUrl}
                target="_blank"
                variant="primary"
              >
                {hubText("useReward")}
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
            ? hubText("fromPoints", { points: hubNumber(minimum ?? BigInt(0)) })
            : hubText("pointsAmount", {
                points: hubNumber(pointsCost ?? BigInt(0)),
              })}
        </s-text>
        {!reward.canRedeem && pointsRemaining > BigInt(0) ? (
          <s-text color="subdued" type="small">
            {hubText("earnRemaining", { points: hubNumber(pointsRemaining) })}
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
          label={hubText("pointsToRedeem")}
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
        {hubText("redeem")}
      </s-button>
    </s-stack>
  );
}

async function readCustomerResponseJson(response: Response) {
  try {
    return await response.json();
  } catch (cause) {
    // Preserve HTTP authentication/permission/rate-limit status even when an
    // upstream failure has no JSON body. Successful malformed bodies still
    // reject, retaining mutation retry keys and the uncertain-outcome message.
    if (!response.ok) return null;
    throw cause;
  }
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
    setError(null);
    setActivityPagination((prev) => ({
      ...prev,
      [type]: { ...prev[type], loading: true },
    }));
    try {
      const nextPage = current.page + 1;
      const response = await authenticatedRequest(
        `/customer/activity?type=${type}&page=${nextPage}&limit=20`,
      );
      const payload = await readCustomerResponseJson(response);
      if (!response.ok) {
        throw hubRequestError(
          "activity",
          response.status,
          payload?.error?.message,
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
    } catch (cause) {
      setError(hubErrorText(cause, "activity"));
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
    const payload = await readCustomerResponseJson(response);
    if (!response.ok) {
      throw hubRequestError(
        "summary",
        response.status,
        payload?.error?.message,
      );
    }
    const data = payload?.data ?? payload;
    // Reject malformed wallet collections before rendering. Keep omitted/null
    // wallets compatible with older summaries, which represent an empty wallet.
    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      typeof data.isEnrolled !== "boolean" ||
      (data.rewardWallet != null &&
        (!Array.isArray(data.rewardWallet) ||
          data.rewardWallet.some(
            (reward: unknown) =>
              !reward ||
              typeof reward !== "object" ||
              Array.isArray(reward) ||
              !("status" in reward) ||
              typeof reward.status !== "string",
          )))
    ) {
      throw new Error("Invalid loyalty wallet summary");
    }
    setSummary(data);
  }

  function handleSummaryError(cause: unknown) {
    setError(hubErrorText(cause, "summary"));
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
      setError(hubText("cannotRedeem"));
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
      const payload = await readCustomerResponseJson(response);
      if (!response.ok) {
        throw hubRequestError(
          "redeem",
          response.status,
          payload?.error?.message,
        );
      }
      const issued = normalizeIssuedRewardArtifact(payload?.data ?? payload);
      // Validate the response before releasing this intent's retry key.
      // Only a usable successful response proves issuance reached the UI.
      // Transport failures and gateway/core errors retain the key so the next
      // click safely replays the same durable saga.
      if (shouldClearRedemptionIntentKey(response.status)) {
        redemptionIntentKeys.current.delete(intentId);
      }
      setIssuedReward(issued);
      // Coupon issuance has already succeeded. A stale summary must not turn
      // that success into a redemption error or hide the delivered code.
      await loadSummary().catch(() => undefined);
    } catch (cause) {
      setError(hubErrorText(cause, "redeem"));
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
      setError(hubText("cannotBirthday"));
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
      const payload = await readCustomerResponseJson(response);
      if (!response.ok) {
        throw hubRequestError(
          "birthday",
          response.status,
          payload?.error?.message,
        );
      }
      await loadSummary();
    } catch (cause) {
      setError(hubErrorText(cause, "birthday"));
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
      setError(hubText("cannotEarn"));
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
      const payload = await readCustomerResponseJson(response);
      if (!response.ok) {
        throw hubRequestError("earn", response.status, payload?.error?.message);
      }
      activityIntentKeys.current.delete(way.id);
      const result = payload.data || payload;
      const awardedPoints = readExactSignedInteger(result.pointsAwarded);
      setActivitySuccess(
        result.alreadyCompleted
          ? hubText("activityAlready", { activity: way.name })
          : awardedPoints === null
            ? hubText("activityAwardUnavailable")
            : hubText("activityAwarded", {
                points: hubNumber(awardedPoints),
                activity: way.name,
              }),
      );
      await loadSummary().catch(() => undefined);
    } catch (cause) {
      setError(hubErrorText(cause, "earn"));
    } finally {
      setClaimingActivity(null);
    }
  }

  if (error && !summary) {
    return (
      <s-page
        heading={hubText("hubTitle")}
        subheading={hubText("memberBenefits")}
      >
        <s-stack direction="block" gap="base">
          <s-banner tone="critical">{error}</s-banner>
          <s-button onClick={retrySummary} variant="primary">
            {hubText("retry")}
          </s-button>
        </s-stack>
      </s-page>
    );
  }
  if (!summary) {
    return (
      <s-page
        heading={hubText("hubTitle")}
        subheading={hubText("memberBenefits")}
      >
        <s-stack direction="block" gap="base">
          <s-section heading={hubText("pointsBalance")}>
            <s-skeleton-paragraph content={hubText("loadingPoints")} />
          </s-section>
          <s-section heading={hubText("yourRewards")}>
            <s-skeleton-paragraph content={hubText("loadingRewards")} />
          </s-section>
        </s-stack>
      </s-page>
    );
  }
  if (!summary.isEnrolled) {
    return (
      <s-page
        heading={hubText("hubTitle")}
        subheading={hubText("memberBenefits")}
      >
        <s-banner tone="info">{hubText("joinNotice")}</s-banner>
      </s-page>
    );
  }

  const points = summary.account?.pointsBalance || "0";
  const pending = summary.account?.pendingPoints || "0";
  const tier = summary.tier?.currentTier?.name || hubText("member");
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
  const programName = summary.program?.name || hubText("program");
  const pointNameSingular =
    summary.program?.pointNameSingular || hubText("pointName");
  const pointNamePlural =
    summary.program?.pointNamePlural || hubText("pointsName");
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
  const referralStats = hubText("referralStats", {
    qualified: hubNumber(summary.referral?.qualifiedReferrals || 0),
    invited: hubNumber(summary.referral?.totalReferrals || 0),
  });

  return (
    <s-page
      heading={hubText("hubTitle")}
      inlineSize="large"
      subheading={summary.program?.branding?.subtitle ?? hubText("subtitle")}
    >
      <s-stack direction="block" gap="base">
        {issuedReward ? (
          <s-banner tone="success">
            {issuedReward.artifactKind === "store_credit"
              ? hubText("issuedCredit")
              : issuedReward.artifactKind === "gift_card"
                ? issuedReward.artifactCode
                  ? hubText("issuedGiftCode", {
                      code: issuedReward.artifactCode,
                    })
                  : hubText("issuedGiftWallet")
                : issuedReward.artifactCode
                  ? hubText("issuedDiscountCode", {
                      code: issuedReward.artifactCode,
                    })
                  : hubText("issuedDiscountWallet")}
          </s-banner>
        ) : null}
        {activitySuccess ? (
          <s-banner tone="success">{activitySuccess}</s-banner>
        ) : null}
        {error ? <s-banner tone="critical">{error}</s-banner> : null}
        {!programIsActive ? (
          <s-banner tone="info">{hubText("paused")}</s-banner>
        ) : null}
        {programIsActive && !canParticipate ? (
          <s-banner tone="warning">
            {hubText("participationUnavailable", {
              status: customerAccountStatusLabel(summary.account?.status),
            })}
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
                    alt={hubText("heroAlt")}
                    aspectRatio="16/5"
                    inlineSize="fill"
                    objectFit="cover"
                    borderRadius="base"
                  />
                ) : null}
                <s-text color="subdued">
                  {summary.shopper?.firstName
                    ? hubText("welcomeNamed", {
                        name: summary.shopper.firstName,
                      })
                    : hubText("welcome")}
                </s-text>
              </s-stack>
            </s-section>

            <s-stack direction="block" gap="base">
              <s-section
                heading={hubText("balanceNamed", { name: pointNamePlural })}
              >
                <s-stack direction="block" gap="small-200">
                  <s-heading>
                    {formatCustomerPoints(
                      points,
                      pointNameSingular,
                      pointNamePlural,
                    )}
                  </s-heading>
                  <s-text color="subdued">
                    {hubText("pendingNamed", {
                      points: formatCustomerPoints(
                        pending,
                        pointNameSingular,
                        pointNamePlural,
                      ),
                    })}
                  </s-text>
                  <s-text color="subdued" type="small">
                    {hubText("lifetimeNamed", {
                      points: formatCustomerPoints(
                        summary.account?.lifetimePointsEarned || 0,
                        pointNameSingular,
                        pointNamePlural,
                      ),
                    })}
                  </s-text>
                  {summary.pointsExpiry?.enabled ? (
                    <s-banner tone="warning">
                      {formatCustomerPointsExpiry(
                        summary.pointsExpiry,
                        pointNamePlural,
                      )}
                    </s-banner>
                  ) : null}
                </s-stack>
              </s-section>

              <s-section heading={hubText("currentVip")}>
                <s-stack direction="block" gap="small-200">
                  <s-heading>{tier}</s-heading>
                  {summary.tier?.currentTier?.pointsMultiplier &&
                  summary.tier.currentTier.pointsMultiplier > 1 ? (
                    <s-badge icon="star">
                      {hubText("earningRate", {
                        multiplier: hubNumber(
                          summary.tier.currentTier.pointsMultiplier,
                        ),
                      })}
                    </s-badge>
                  ) : null}
                  {summary.tier?.tierExpiresAt ? (
                    <s-text color="subdued" type="small">
                      {hubText("attainedUntil", {
                        date:
                          formatCustomerRewardDate(
                            summary.tier.tierExpiresAt,
                          ) || "",
                      })}
                    </s-text>
                  ) : null}
                  {nextTier && tierProgress ? (
                    <>
                      <s-text>
                        {hubText("tierProgress", {
                          percent: hubNumber(tierProgress.percent),
                          tier: nextTier.name,
                        })}
                      </s-text>
                      <s-progress
                        value={tierProgress.percent}
                        max={100}
                        accessibilityLabel={hubText("progressToward", {
                          name: nextTier.name,
                        })}
                      />
                      {tierProgress.milestoneMode !== "points_earned" ? (
                        <s-text color="subdued" type="small">
                          {hubText("spendRemaining", {
                            amount: formatStoreMinorCurrency(
                              tierProgress.spendRemaining,
                              currency,
                            ),
                          })}
                        </s-text>
                      ) : null}
                      {tierProgress.milestoneMode !== "amount_spent" ? (
                        <s-text color="subdued" type="small">
                          {hubText("pointsToTier", {
                            points: formatCustomerPoints(
                              tierProgress.pointsRemaining,
                              pointNameSingular,
                              pointNamePlural,
                            ),
                            tier: nextTier.name,
                          })}
                        </s-text>
                      ) : null}
                    </>
                  ) : (
                    <s-text color="subdued">
                      {customerVipCompletionLabel(summary.tier)}
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

        <s-section heading={hubText("yourRewards")}>
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
                ? hubText("redeemWallet", {
                    name: pointNamePlural.toLowerCase(),
                  })
                : hubText("emptyWallet")}
            </s-text>
          )}
        </s-section>

        {canParticipate ? (
          <s-section
            heading={hubText("spendPoints", { name: pointNamePlural })}
          >
            <s-stack direction="block" gap="base">
              {nextReward &&
              nextRewardCost &&
              nextRewardCost > BigInt(0) &&
              nextRewardProgress ? (
                <s-stack direction="block" gap="small-200">
                  <s-text>
                    {hubText("pointsToReward", {
                      points: formatCustomerPoints(
                        nextRewardCost > exactPoints
                          ? nextRewardCost - exactPoints
                          : BigInt(0),
                        pointNameSingular,
                        pointNamePlural,
                      ),
                      reward: nextReward.name,
                    })}
                  </s-text>
                  <s-progress
                    value={nextRewardProgress.value}
                    max={nextRewardProgress.max}
                    accessibilityLabel={hubText("progressToward", {
                      name: nextReward.name,
                    })}
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
                <s-text color="subdued">{hubText("noRewards")}</s-text>
              )}
            </s-stack>
          </s-section>
        ) : null}

        {canParticipate ? (
          <s-section heading={hubText("waysToEarn", { name: pointNamePlural })}>
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
                          {hubEarningActionLabel(way.triggerCode)}
                        </s-button>
                        <s-text color="subdued" type="small">
                          {hubText("socialDisclaimer")}
                        </s-text>
                      </>
                    ) : null}
                  </s-stack>
                ))}
              </s-grid>
            ) : (
              <s-text color="subdued">{hubText("noEarningActions")}</s-text>
            )}
          </s-section>
        ) : null}

        {activeCampaigns.length > 0 ? (
          <s-section heading={hubText("bonusCampaigns")}>
            <s-stack direction="block" gap="base">
              {activeCampaigns.map((campaign) => (
                <s-banner key={campaign.id} tone="info">
                  {hubText(
                    campaign.description
                      ? "campaignDescription"
                      : "campaignDetails",
                    {
                      multiplier: hubNumber(campaign.multiplier),
                      name: campaign.name,
                      description: campaign.description || "",
                      date:
                        formatCustomerRewardDate(campaign.endAt) ||
                        hubText("dateUnavailable"),
                    },
                  )}
                </s-banner>
              ))}
            </s-stack>
          </s-section>
        ) : null}

        {referralOffer &&
        referralCopy &&
        summary.referral?.referralShareUrl &&
        shareLinks ? (
          <s-section heading={hubText("referFriend")}>
            <s-stack direction="block" gap="base">
              <s-heading>{referralCopy.heading}</s-heading>
              <s-text color="subdued">
                {referralOffer.minQualifyingOrderSubtotal
                  ? hubText("referralMinimum", {
                      qualification: referralCopy.qualification,
                      amount: formatStoreCurrency(
                        referralOffer.minQualifyingOrderSubtotal,
                        currency,
                      ),
                    })
                  : referralCopy.qualification}
              </s-text>
              <s-text>
                {referralCopy.showPointsEarned
                  ? hubText("referralStatsPoints", {
                      stats: referralStats,
                      points: formatCustomerPoints(
                        summary.referral.totalPointsEarned || 0,
                        pointNameSingular,
                        pointNamePlural,
                      ),
                    })
                  : referralStats}
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
                  {hubText("copyLink")}
                </s-button>
                <s-button href={shareLinks.facebook} target="_blank">
                  Facebook
                </s-button>
                <s-button href={shareLinks.x} target="_blank">
                  X
                </s-button>
                <s-button href={shareLinks.email}>{hubText("email")}</s-button>
              </s-stack>
            </s-stack>
          </s-section>
        ) : null}

        {(summary.tier?.allTiers || []).length > 0 ? (
          <s-section heading={hubText("vipTiers")}>
            <s-stack direction="block" gap="base">
              <s-text color="subdued">
                {hubText("qualificationPeriod", {
                  period: customerVipPeriodLabel(summary.program?.vipTimeframe),
                })}
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
                        <s-badge icon="check-circle">
                          {hubText("currentTier")}
                        </s-badge>
                      ) : null}
                    </s-stack>
                    <s-text color="subdued">
                      {hubText("earningRate", {
                        multiplier: hubNumber(tierDefinition.pointsMultiplier),
                      })}
                    </s-text>
                    {(readExactUnsignedInteger(
                      tierDefinition.minPointsThreshold,
                    ) ?? BigInt(0)) > BigInt(0) ? (
                      <s-text color="subdued" type="small">
                        {hubText("pointsRequired", {
                          points: formatCustomerPoints(
                            tierDefinition.minPointsThreshold,
                            pointNameSingular,
                            pointNamePlural,
                          ),
                        })}
                      </s-text>
                    ) : null}
                    {(readExactUnsignedInteger(
                      tierDefinition.minSpendThreshold,
                    ) ?? BigInt(0)) > BigInt(0) ? (
                      <s-text color="subdued" type="small">
                        {hubText("spendRequired", {
                          amount: formatStoreMinorCurrency(
                            tierDefinition.minSpendThreshold,
                            currency,
                          ),
                        })}
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

        <s-section heading={hubText("activity")}>
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
                {hubText("referrals")}
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
                              {/* Ledger reasons are internal audit text and may
                                  include order IDs or provider diagnostics. */}
                              {hubActivityLabel("points", activity.entryType)}
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
                          {hubText("loadMore")}
                        </s-button>
                      ) : null}
                    </s-stack>
                  ) : (
                    <s-text color="subdued">
                      {hubText("noPointsActivity")}
                    </s-text>
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
                                {hubActivityLabel("referrals", activity.status)}
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
                          {hubText("loadMore")}
                        </s-button>
                      ) : null}
                    </s-stack>
                  ) : (
                    <s-text color="subdued">
                      {hubText("noReferralActivity")}
                    </s-text>
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
                            {hubActivityLabel("vip", activity.changeReason)} ·{" "}
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
                          {hubText("loadMore")}
                        </s-button>
                      ) : null}
                    </s-stack>
                  ) : (
                    <s-text color="subdued">{hubText("noVipActivity")}</s-text>
                  );
                })()
              : null}
          </s-stack>
        </s-section>

        {canParticipate && summary.birthday?.enabled ? (
          <s-section heading={hubText("birthdayReward")}>
            {summary.birthday.isRegistered ? (
              <s-text>{formatSavedCustomerBirthday(summary.birthday)}</s-text>
            ) : (
              <s-stack direction="block" gap="base">
                <s-text color="subdued">{hubText("birthdayHelp")}</s-text>
                <s-stack direction="inline" gap="base">
                  <s-number-field
                    label={hubText("birthMonth")}
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
                    label={hubText("birthDay")}
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
                  {hubText("saveBirthday")}
                </s-button>
              </s-stack>
            )}
          </s-section>
        ) : null}

        {rewardHistory.length > 0 ? (
          <s-section heading={hubText("rewardHistory")}>
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
