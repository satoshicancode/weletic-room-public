export const MAX_REFERRALS_PER_ADVOCATE_LIMIT = 1_000_000;

/**
 * The referral rule shown before a merchant saves any configuration must be
 * identical to the rule created lazily by runtime qualification. Keep these
 * values serialization-friendly because both the admin API and Prisma write
 * path consume them.
 */
export const DEFAULT_REFERRAL_RULE_CONFIG = Object.freeze({
  advocatePointsReward: "500",
  refereePointsReward: "50",
  advocateRewardKind: "points" as const,
  refereeRewardKind: "points" as const,
  advocateRewardDefinitionId: null,
  refereeRewardDefinitionId: null,
  minQualifyingOrderSubtotal: "30",
  maxReferralsPerAdvocate: null,
  fraudCheckSameIp: true,
  purchaseType: "both" as const,
  subscriptionCadence: "first_payment" as const,
  subscriptionPaymentLimit: null,
  isActive: true,
});

export class InvalidReferralRuleConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidReferralRuleConfigurationError";
  }
}

export function parseMaxReferralsPerAdvocate(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value.trim())
        ? Number(value)
        : Number.NaN;
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > MAX_REFERRALS_PER_ADVOCATE_LIMIT
  ) {
    throw new InvalidReferralRuleConfigurationError(
      `Maximum referrals per advocate must be an integer from 1 to ${MAX_REFERRALS_PER_ADVOCATE_LIMIT}, or empty for unlimited.`,
    );
  }
  return parsed;
}
