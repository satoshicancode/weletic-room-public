export const MAX_BONUS_CAMPAIGN_DURATION_DAYS = 31;
export const MIN_BONUS_CAMPAIGN_MULTIPLIER = 1.5;
export const MAX_BONUS_CAMPAIGN_MULTIPLIER = 10;
export const MAX_BONUS_CAMPAIGN_TARGETS_PER_TYPE = 100;
export const MAX_BONUS_CAMPAIGN_SKU_LENGTH = 255;

export class BonusCampaignPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BonusCampaignPolicyError";
  }
}

export function parseBonusCampaignSchedule({
  startAt,
  endAt,
  multiplier,
}: {
  startAt: unknown;
  endAt: unknown;
  multiplier: unknown;
}) {
  const start = new Date(String(startAt || ""));
  const end = new Date(String(endAt || ""));
  const parsedMultiplier = Number(multiplier);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    throw new BonusCampaignPolicyError(
      "Campaign start and end must be valid timestamps.",
    );
  }
  if (end <= start) {
    throw new BonusCampaignPolicyError("Campaign end must be after its start.");
  }
  const maxDurationMs = MAX_BONUS_CAMPAIGN_DURATION_DAYS * 24 * 60 * 60 * 1000;
  if (end.getTime() - start.getTime() > maxDurationMs) {
    throw new BonusCampaignPolicyError(
      `Bonus campaigns can run for at most ${MAX_BONUS_CAMPAIGN_DURATION_DAYS} days.`,
    );
  }
  if (
    !Number.isFinite(parsedMultiplier) ||
    parsedMultiplier < MIN_BONUS_CAMPAIGN_MULTIPLIER ||
    parsedMultiplier > MAX_BONUS_CAMPAIGN_MULTIPLIER
  ) {
    throw new BonusCampaignPolicyError(
      `Campaign multiplier must be between ${MIN_BONUS_CAMPAIGN_MULTIPLIER} and ${MAX_BONUS_CAMPAIGN_MULTIPLIER}.`,
    );
  }
  return { startAt: start, endAt: end, multiplier: parsedMultiplier };
}

/** Campaign schedules are half-open windows: [startAt, endAt). */
export function bonusCampaignsOverlap(
  first: { startAt: Date; endAt: Date },
  second: { startAt: Date; endAt: Date },
) {
  return first.startAt < second.endAt && second.startAt < first.endAt;
}

export function normalizeEligibleTierIds(value: unknown) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 100) {
    throw new BonusCampaignPolicyError(
      "eligibleTierIds must be an array of at most 100 tier IDs.",
    );
  }
  const ids = [...new Set(value.map((item) => String(item).trim()))];
  if (ids.some((id) => !/^wtier_[A-Za-z0-9_-]{3,64}$/.test(id))) {
    throw new BonusCampaignPolicyError(
      "eligibleTierIds contains an invalid VIP tier ID.",
    );
  }
  return ids;
}

function normalizeTargetList({
  value,
  field,
  isValid,
  invalidMessage,
}: {
  value: unknown;
  field: "eligibleSkus" | "eligibleCollectionIds";
  isValid: (value: string) => boolean;
  invalidMessage: string;
}) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new BonusCampaignPolicyError(
      `${field} must be an array of at most ${MAX_BONUS_CAMPAIGN_TARGETS_PER_TYPE} identifiers.`,
    );
  }

  const identifiers = value.map((item) =>
    typeof item === "string" ? item.normalize("NFC").trim() : "",
  );
  if (identifiers.some((identifier) => !isValid(identifier))) {
    throw new BonusCampaignPolicyError(invalidMessage);
  }

  const normalized = [...new Set(identifiers)].sort();
  if (normalized.length > MAX_BONUS_CAMPAIGN_TARGETS_PER_TYPE) {
    throw new BonusCampaignPolicyError(
      `${field} must be an array of at most ${MAX_BONUS_CAMPAIGN_TARGETS_PER_TYPE} identifiers.`,
    );
  }
  return normalized;
}

/**
 * Shopify SKUs are merchant-defined identifiers. Preserve case while removing
 * surrounding whitespace and rejecting empty/control-character values.
 */
export function normalizeEligibleSkus(value: unknown): string[] {
  return normalizeTargetList({
    value,
    field: "eligibleSkus",
    isValid: (sku) =>
      sku.length > 0 &&
      sku.length <= MAX_BONUS_CAMPAIGN_SKU_LENGTH &&
      !/[\u0000-\u001f\u007f]/.test(sku),
    invalidMessage:
      "eligibleSkus contains an invalid SKU identifier (1-255 printable characters required).",
  });
}

/** Collection targets use the canonical Admin API GID captured on order lines. */
export function normalizeEligibleCollectionIds(value: unknown): string[] {
  return normalizeTargetList({
    value,
    field: "eligibleCollectionIds",
    isValid: (collectionId) =>
      /^gid:\/\/shopify\/Collection\/[1-9]\d*$/.test(collectionId),
    invalidMessage:
      "eligibleCollectionIds contains an invalid Shopify collection GID.",
  });
}

export interface NormalizedBonusCampaignTargets {
  eligibleSkus: string[];
  eligibleCollectionIds: string[];
}

export function normalizeBonusCampaignTargets(campaign: {
  eligibleSkus?: unknown;
  eligibleCollectionIds?: unknown;
}): NormalizedBonusCampaignTargets {
  return {
    eligibleSkus: normalizeEligibleSkus(campaign.eligibleSkus),
    eligibleCollectionIds: normalizeEligibleCollectionIds(
      campaign.eligibleCollectionIds,
    ),
  };
}

/**
 * Empty target lists preserve broadcast/VIP-only behavior. When one or both
 * lists are configured, a line matches if any captured SKU or collection does.
 * Missing line snapshots therefore fail as nonmatches.
 */
export function doesOrderLineMatchBonusCampaign({
  targets,
  line,
}: {
  targets: NormalizedBonusCampaignTargets;
  line: { sku?: unknown; collectionExternalIds?: unknown };
}): boolean {
  const hasSkuTargets = targets.eligibleSkus.length > 0;
  const hasCollectionTargets = targets.eligibleCollectionIds.length > 0;
  if (!hasSkuTargets && !hasCollectionTargets) return true;

  const capturedSku =
    typeof line.sku === "string" ? line.sku.normalize("NFC").trim() : null;
  if (
    hasSkuTargets &&
    capturedSku &&
    targets.eligibleSkus.includes(capturedSku)
  ) {
    return true;
  }

  if (hasCollectionTargets && Array.isArray(line.collectionExternalIds)) {
    const capturedCollectionIds = new Set(
      line.collectionExternalIds.filter(
        (identifier): identifier is string => typeof identifier === "string",
      ),
    );
    return targets.eligibleCollectionIds.some((identifier) =>
      capturedCollectionIds.has(identifier),
    );
  }

  return false;
}

/**
 * Asserts running campaign immutability.
 * Rejects mid-flight updates to economics, schedule, or targeting when
 * `startAt <= now < endAt && isActive !== false`.
 * Permitted updates include `name`, `description`, or early deactivation (`isActive: false`).
 */
export function assertRunningCampaignImmutability({
  existing,
  updates,
  now = new Date(),
}: {
  existing: {
    startAt: Date | string;
    endAt: Date | string;
    multiplier:
      | number
      | string
      | { toFixed?: () => string; toString?: () => string };
    isActive?: boolean;
    eligibleTierIds?: unknown;
    eligibleSkus?: unknown;
    eligibleCollectionIds?: unknown;
  };
  updates: {
    startAt?: unknown;
    endAt?: unknown;
    multiplier?: unknown;
    isActive?: unknown;
    name?: unknown;
    description?: unknown;
    eligibleTierIds?: unknown;
    eligibleSkus?: unknown;
    eligibleCollectionIds?: unknown;
  };
  now?: Date;
}) {
  const nowTime = now.getTime();
  const existingStart = new Date(existing.startAt).getTime();
  const existingEnd = new Date(existing.endAt).getTime();
  const isRunning =
    existing.isActive !== false &&
    existingStart <= nowTime &&
    existingEnd > nowTime;

  if (!isRunning) return;

  if (updates.multiplier !== undefined) {
    const newMul = Number(updates.multiplier);
    const oldMul = Number(existing.multiplier);
    if (!Number.isNaN(newMul) && !Number.isNaN(oldMul) && newMul !== oldMul) {
      throw new BonusCampaignPolicyError(
        "Active running campaigns cannot have their multiplier modified mid-flight.",
      );
    }
  }

  if (updates.startAt !== undefined) {
    const newStart = new Date(String(updates.startAt)).getTime();
    if (!Number.isNaN(newStart) && newStart !== existingStart) {
      throw new BonusCampaignPolicyError(
        "Active running campaigns cannot have their start date modified mid-flight.",
      );
    }
  }

  if (updates.endAt !== undefined) {
    const newEnd = new Date(String(updates.endAt)).getTime();
    if (!Number.isNaN(newEnd) && newEnd !== existingEnd) {
      throw new BonusCampaignPolicyError(
        "Active running campaigns cannot have their end date modified mid-flight.",
      );
    }
  }

  const immutableTargetFields = [
    {
      field: "eligibleTierIds" as const,
      normalize: normalizeEligibleTierIds,
    },
    { field: "eligibleSkus" as const, normalize: normalizeEligibleSkus },
    {
      field: "eligibleCollectionIds" as const,
      normalize: normalizeEligibleCollectionIds,
    },
  ];
  for (const { field, normalize } of immutableTargetFields) {
    if (updates[field] === undefined) continue;
    const previous = normalize(existing[field]);
    const proposed = normalize(updates[field]);
    if (JSON.stringify(previous) !== JSON.stringify(proposed)) {
      throw new BonusCampaignPolicyError(
        "Active running campaigns cannot have their targeting modified mid-flight.",
      );
    }
  }
}

/**
 * Asserts that a proposed bonus campaign schedule does not overlap with any existing active campaigns
 * for the store. Schedules are half-open windows: [startAt, endAt).
 */
export function assertNoCampaignOverlap({
  proposed,
  existingCampaigns,
}: {
  proposed: {
    id?: string;
    startAt: Date | string;
    endAt: Date | string;
    isActive?: boolean;
  };
  existingCampaigns: Array<{
    id?: string;
    startAt: Date | string;
    endAt: Date | string;
    isActive?: boolean;
    deletedAt?: Date | string | null;
  }>;
}) {
  if (proposed.isActive === false) return;

  const proposedStart = new Date(proposed.startAt);
  const proposedEnd = new Date(proposed.endAt);

  if (
    !Number.isFinite(proposedStart.getTime()) ||
    !Number.isFinite(proposedEnd.getTime())
  ) {
    throw new BonusCampaignPolicyError(
      "Campaign start and end must be valid timestamps.",
    );
  }
  if (proposedEnd <= proposedStart) {
    throw new BonusCampaignPolicyError("Campaign end must be after its start.");
  }

  for (const existing of existingCampaigns) {
    if (proposed.id && existing.id && proposed.id === existing.id) {
      continue;
    }
    if (existing.isActive === false || existing.deletedAt) {
      continue;
    }

    const existingStart = new Date(existing.startAt);
    const existingEnd = new Date(existing.endAt);

    if (
      bonusCampaignsOverlap(
        { startAt: proposedStart, endAt: proposedEnd },
        { startAt: existingStart, endAt: existingEnd },
      )
    ) {
      throw new BonusCampaignPolicyError(
        "Campaign schedule overlaps with an existing active campaign for this store.",
      );
    }
  }
}

/**
 * Checks if a customer tier is eligible for a bonus campaign.
 * Returns true for broadcast campaigns (eligibleTierIds is null, undefined, or empty),
 * or when customerTierId is contained in eligibleTierIds.
 */
export function isTierEligibleForBonusCampaign(
  campaign: { eligibleTierIds?: unknown },
  customerTierId?: string | null,
): boolean {
  const tiers = campaign.eligibleTierIds;
  if (tiers === null || tiers === undefined) return true;
  if (Array.isArray(tiers)) {
    if (tiers.length === 0) return true;
    if (!customerTierId) return false;
    return tiers.includes(customerTierId);
  }
  return true;
}

/**
 * Resolves the currently active bonus campaign for an order or customer event.
 */
export function resolveActiveBonusCampaign<
  T extends {
    id: string;
    startAt: Date | string;
    endAt: Date | string;
    isActive?: boolean;
    deletedAt?: Date | string | null;
    eligibleTierIds?: unknown;
    multiplier: unknown;
  },
>({
  campaigns,
  occurredAt = new Date(),
  customerTierId,
}: {
  campaigns: T[];
  occurredAt?: Date | string;
  customerTierId?: string | null;
}): T | null {
  const at = occurredAt instanceof Date ? occurredAt : new Date(occurredAt);
  const atTime = at.getTime();

  for (const campaign of campaigns) {
    if (campaign.isActive === false) continue;
    if (campaign.deletedAt) continue;

    const start = new Date(campaign.startAt).getTime();
    const end = new Date(campaign.endAt).getTime();

    if (atTime >= start && atTime < end) {
      if (isTierEligibleForBonusCampaign(campaign, customerTierId)) {
        return campaign;
      }
    }
  }

  return null;
}
