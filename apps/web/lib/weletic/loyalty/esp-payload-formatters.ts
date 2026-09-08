export interface LoyaltyProfileAttributesInput {
  pointsBalance: number | string | bigint;
  vipTier?: string | null;
  referralLink?: string | null;
  memberStatus?: string | null;
  extraProperties?: Record<string, unknown>;
}

export const RESTRICTED_PII_KEYS = new Set([
  "email",
  "phone",
  "phonenumber",
  "telephone",
  "mobile",
  "name",
  "firstname",
  "lastname",
  "fullname",
  "birthdate",
  "birthday",
  "dob",
  "address",
  "address1",
  "address2",
  "city",
  "province",
  "zip",
  "postalcode",
  "country",
  "ssn",
  "taxid",
  "creditcard",
  "password",
  "token",
  "secret",
]);

export function isPiiPropertyKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return RESTRICTED_PII_KEYS.has(normalized);
}

export function sanitizeNonPiiProperties(
  props?: Record<string, unknown>,
): Record<string, unknown> {
  if (!props || typeof props !== "object") return {};
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (!isPiiPropertyKey(key)) sanitized[key] = value;
  }
  return sanitized;
}

function normalizeProfilePoints(value: number | string | bigint) {
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    return 0;
  }
  const numeric = Number(parsed);
  return Number.isSafeInteger(numeric) ? numeric : parsed.toString();
}

/** Pure formatter only; outbound ESP delivery is intentionally deferred. */
export function buildKlaviyoProfileAttributes(
  input: LoyaltyProfileAttributesInput,
): Record<string, unknown> {
  return {
    $points_balance: normalizeProfilePoints(input.pointsBalance),
    $vip_tier: input.vipTier ?? "None",
    $referral_link: input.referralLink ?? "",
    $member_status: input.memberStatus ?? "active",
    ...sanitizeNonPiiProperties(input.extraProperties),
  };
}

/** Pure formatter only; outbound ESP delivery is intentionally deferred. */
export function buildOmnisendProfileAttributes(
  input: LoyaltyProfileAttributesInput,
): Record<string, unknown> {
  return {
    points_balance: normalizeProfilePoints(input.pointsBalance),
    vip_tier: input.vipTier ?? "None",
    referral_link: input.referralLink ?? "",
    member_status: input.memberStatus ?? "active",
    ...sanitizeNonPiiProperties(input.extraProperties),
  };
}
