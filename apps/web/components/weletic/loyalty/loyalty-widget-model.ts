type LoyaltyRecord = Record<string, any>;

export type LoyaltyInteger = string | number | bigint;

export interface LoyaltyReferralDisplay {
  advocateRewardKind: "points" | "coupon";
  advocateRewardText: string;
  friendRewardKind: "points" | "coupon";
  friendRewardText: string;
}

export interface LoyaltyWidgetDisplayModel {
  currency: string;
  earningRules: LoyaltyRecord[];
  referralOffer: LoyaltyReferralDisplay | null;
  rewards: LoyaltyRecord[];
  tiers: LoyaltyRecord[];
}

function readExactInteger(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? BigInt(value) : null;
  }
  if (typeof value !== "string" || !/^-?\d+$/.test(value.trim())) {
    return null;
  }
  return BigInt(value.trim());
}

function positiveInteger(value: unknown) {
  const parsed = readExactInteger(value);
  return parsed !== null && parsed > BigInt(0) ? parsed : null;
}

export function unwrapLoyaltyPayload<T>(payload: T | { data: T }): T {
  if (
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    Object.prototype.hasOwnProperty.call(payload, "data")
  ) {
    return (payload as { data: T }).data;
  }
  return payload as T;
}

export function formatLoyaltyInteger(value: unknown): string {
  return (readExactInteger(value) ?? BigInt(0)).toLocaleString("en-US");
}

export function isLoyaltyIntegerAtLeast(
  value: unknown,
  minimum: unknown,
): boolean {
  const parsedValue = readExactInteger(value);
  const parsedMinimum = readExactInteger(minimum);
  return (
    parsedValue !== null &&
    parsedMinimum !== null &&
    parsedValue >= parsedMinimum
  );
}

export function formatLoyaltyPoints(
  value: unknown,
  pointNameSingular = "Point",
  pointNamePlural = "Points",
): string {
  const amount = readExactInteger(value) ?? BigInt(0);
  return `${amount.toLocaleString("en-US")} ${
    amount === BigInt(1) ? pointNameSingular : pointNamePlural
  }`;
}

export function formatLoyaltyMinorCurrency(
  value: unknown,
  currency = "USD",
  locale = "en-US",
): string {
  const minorUnits = readExactInteger(value);
  if (minorUnits === null) return "—";

  const normalizedCurrency = (currency || "USD").toUpperCase();
  let formatter: Intl.NumberFormat;
  try {
    formatter = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: normalizedCurrency,
    });
  } catch {
    return `${normalizedCurrency} ${formatLoyaltyInteger(minorUnits)}`;
  }

  const fractionDigits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  const scale = BigInt(`1${"0".repeat(fractionDigits)}`);
  const absoluteMinorUnits = minorUnits < BigInt(0) ? -minorUnits : minorUnits;
  const wholeUnits = absoluteMinorUnits / scale;
  const fractionUnits = absoluteMinorUnits % scale;
  const exactFraction = fractionUnits.toString().padStart(fractionDigits, "0");
  let wroteInteger = false;

  return formatter
    .formatToParts(minorUnits < BigInt(0) ? -1 : 1)
    .map((part) => {
      if (part.type === "integer") {
        if (wroteInteger) return "";
        wroteInteger = true;
        return wholeUnits.toLocaleString(locale);
      }
      if (part.type === "group") return "";
      if (part.type === "fraction") return exactFraction;
      return part.value;
    })
    .join("");
}

export function isOnlineStoreLoyaltyReward(reward: LoyaltyRecord): boolean {
  return (
    (reward?.salesChannel === "online_store" ||
      reward?.salesChannel === "both") &&
    (reward?.status === undefined || reward.status === "active")
  );
}

function isEarningRuleVisible(rule: LoyaltyRecord, now: Date): boolean {
  if (rule?.isActive === false) return false;
  const startAt = rule?.startAt ? new Date(rule.startAt) : null;
  const endAt = rule?.endAt ? new Date(rule.endAt) : null;
  return (
    (!startAt || (!Number.isNaN(startAt.getTime()) && startAt <= now)) &&
    (!endAt || (!Number.isNaN(endAt.getTime()) && endAt > now))
  );
}

function isPreviewCouponReward(reward: LoyaltyRecord | undefined): boolean {
  return Boolean(
    reward &&
      isOnlineStoreLoyaltyReward(reward) &&
      reward.exchangeType === "fixed" &&
      [
        "amount_off",
        "percentage_off",
        "free_shipping",
        "free_product",
      ].includes(reward.rewardType),
  );
}

function rewardLabel({
  kind,
  points,
  directName,
  rewardDefinitionId,
  rewardById,
  pointNameSingular,
  pointNamePlural,
}: {
  kind: unknown;
  points: unknown;
  directName: unknown;
  rewardDefinitionId: unknown;
  rewardById: Map<string, LoyaltyRecord>;
  pointNameSingular: string;
  pointNamePlural: string;
}): { kind: "points" | "coupon"; text: string } | null {
  if (kind === "points") {
    const amount = positiveInteger(points);
    return amount === null
      ? null
      : {
          kind,
          text: formatLoyaltyPoints(amount, pointNameSingular, pointNamePlural),
        };
  }
  if (kind !== "coupon") return null;

  const directRewardName =
    typeof directName === "string" && directName.trim()
      ? directName.trim()
      : null;
  if (directRewardName) return { kind, text: directRewardName };

  const reward =
    typeof rewardDefinitionId === "string"
      ? rewardById.get(rewardDefinitionId)
      : undefined;
  return isPreviewCouponReward(reward) && reward?.name
    ? { kind, text: String(reward.name) }
    : null;
}

export function buildLoyaltyWidgetDisplayModel({
  currency = "USD",
  earningRules = [],
  rewards = [],
  tiers = [],
  referralRule,
  pointNameSingular = "Point",
  pointNamePlural = "Points",
  now = new Date(),
}: {
  currency?: string;
  earningRules?: LoyaltyRecord[];
  rewards?: LoyaltyRecord[];
  tiers?: LoyaltyRecord[];
  referralRule?: LoyaltyRecord | null;
  pointNameSingular?: string;
  pointNamePlural?: string;
  now?: Date;
}): LoyaltyWidgetDisplayModel {
  const visibleRewards = rewards.filter(isOnlineStoreLoyaltyReward);
  const rewardById = new Map(
    visibleRewards.map((reward) => [String(reward.id), reward]),
  );
  const friendReward = referralRule
    ? rewardLabel({
        kind: referralRule.refereeRewardKind ?? referralRule.friendRewardKind,
        points:
          referralRule.refereePointsReward ?? referralRule.friendPointsReward,
        directName:
          referralRule.refereeRewardName ?? referralRule.friendRewardName,
        rewardDefinitionId:
          referralRule.refereeRewardDefinitionId ??
          referralRule.friendRewardDefinitionId,
        rewardById,
        pointNameSingular,
        pointNamePlural,
      })
    : null;
  const advocateReward = referralRule
    ? rewardLabel({
        kind: referralRule.advocateRewardKind,
        points: referralRule.advocatePointsReward,
        directName: referralRule.advocateRewardName,
        rewardDefinitionId: referralRule.advocateRewardDefinitionId,
        rewardById,
        pointNameSingular,
        pointNamePlural,
      })
    : null;
  const referralOffer =
    referralRule?.isActive !== false && friendReward && advocateReward
      ? {
          friendRewardKind: friendReward.kind,
          friendRewardText: friendReward.text,
          advocateRewardKind: advocateReward.kind,
          advocateRewardText: advocateReward.text,
        }
      : null;

  return {
    currency: (currency || "USD").toUpperCase(),
    earningRules: earningRules.filter((rule) =>
      isEarningRuleVisible(rule, now),
    ),
    rewards: visibleRewards,
    tiers,
    referralOffer,
  };
}
