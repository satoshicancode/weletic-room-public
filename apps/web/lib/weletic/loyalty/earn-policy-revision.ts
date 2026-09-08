import { createWeleticId } from "@/lib/weletic/ids";
import {
  normalizeEligibleCollectionIds,
  normalizeEligibleSkus,
} from "@/lib/weletic/loyalty/bonus-campaign-policy";
import { lockLoyaltyProgramRow } from "@/lib/weletic/loyalty/program-write-fence";
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";

export const LOYALTY_EARN_POLICY_SCHEMA_VERSION = 1 as const;

export class LoyaltyEarnPolicyRevisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoyaltyEarnPolicyRevisionError";
  }
}

type JsonObject = Record<string, unknown>;

export type LoyaltyEarnPolicySnapshotV1 = {
  schemaVersion: typeof LOYALTY_EARN_POLICY_SCHEMA_VERSION;
  program: {
    id: string;
    storeId: string;
    status: "draft" | "test" | "active" | "disabled";
    pointsPerCurrencyUnit: string;
    holdingPeriodDays: number;
    pointsExpiryMonths: number;
    pointsExpiryDays: number;
    pointsExpiryWarningDays: number;
    pointsExpiryLastChanceDays: number;
    pointsExpiryWarningEnabled: boolean;
    pointsExpiryLastChanceEnabled: boolean;
    pointsExpiryPolicyAnchorAt: string | null;
    pointsExpiryPolicyVersion: number;
    vipMilestoneMode: "amount_spent" | "points_earned" | "both";
    vipTimeframe: "rolling_12m" | "calendar_year" | "lifetime";
    vipDowngradeGraceDays: number;
    vipAutoDowngradeEnabled: boolean;
  };
  earningRules: Array<{
    id: string;
    triggerCode: string;
    ruleType: "multiplier" | "fixed_points";
    priority: number;
    multiplier: string;
    fixedPoints: string | null;
    minOrderSubtotal: string | null;
    maxPointsPerEvent: string | null;
    maxEventsPerCustomer: number | null;
    limitInterval: string | null;
    eligibleTierIds: string[];
    conditions: Prisma.JsonValue | null;
    excludeDiscountedItems: boolean;
    excludeTaxesAndShipping: boolean;
    startAt: string | null;
    endAt: string | null;
    isActive: boolean;
    createdAt: string;
  }>;
  bonusCampaigns: Array<{
    id: string;
    multiplier: string;
    startAt: string;
    endAt: string;
    isActive: boolean;
    eligibleTierIds: string[];
    eligibleSkus?: string[];
    eligibleCollectionIds?: string[];
    createdAt: string;
  }>;
  tiers: Array<{
    id: string;
    tierOrder: number;
    minSpendThreshold: string;
    minPointsThreshold: string;
    pointsMultiplier: string;
    entryBonusPoints: string;
    gracePeriodDays: number | null;
    criteria: Prisma.JsonValue | null;
    createdAt: string;
  }>;
};

export type ParsedLoyaltyEarnPolicy = {
  schemaVersion: typeof LOYALTY_EARN_POLICY_SCHEMA_VERSION;
  program: Omit<
    LoyaltyEarnPolicySnapshotV1["program"],
    "pointsPerCurrencyUnit" | "pointsExpiryPolicyAnchorAt"
  > & {
    pointsPerCurrencyUnit: Prisma.Decimal;
    pointsExpiryPolicyAnchorAt: Date | null;
  };
  earningRules: Array<
    Omit<
      LoyaltyEarnPolicySnapshotV1["earningRules"][number],
      | "multiplier"
      | "fixedPoints"
      | "minOrderSubtotal"
      | "maxPointsPerEvent"
      | "startAt"
      | "endAt"
      | "createdAt"
    > & {
      multiplier: Prisma.Decimal;
      fixedPoints: bigint | null;
      minOrderSubtotal: Prisma.Decimal | null;
      maxPointsPerEvent: bigint | null;
      startAt: Date | null;
      endAt: Date | null;
      createdAt: Date;
    }
  >;
  bonusCampaigns: Array<
    Omit<
      LoyaltyEarnPolicySnapshotV1["bonusCampaigns"][number],
      "multiplier" | "startAt" | "endAt" | "createdAt"
    > & {
      multiplier: Prisma.Decimal;
      startAt: Date;
      endAt: Date;
      createdAt: Date;
    }
  >;
  tiers: Array<
    Omit<
      LoyaltyEarnPolicySnapshotV1["tiers"][number],
      | "minSpendThreshold"
      | "minPointsThreshold"
      | "pointsMultiplier"
      | "entryBonusPoints"
      | "createdAt"
    > & {
      minSpendThreshold: bigint;
      minPointsThreshold: bigint;
      pointsMultiplier: Prisma.Decimal;
      entryBonusPoints: bigint;
      createdAt: Date;
    }
  >;
};

type PolicyProgramProjection = {
  id: string;
  storeId: string;
  status: string;
  pointsPerCurrencyUnit: Prisma.Decimal | string | number;
  holdingPeriodDays: number;
  pointsExpiryMonths: number;
  pointsExpiryDays: number;
  pointsExpiryWarningDays: number;
  pointsExpiryLastChanceDays: number;
  pointsExpiryWarningEnabled: boolean;
  pointsExpiryLastChanceEnabled: boolean;
  pointsExpiryPolicyAnchorAt?: Date | string | null;
  pointsExpiryPolicyVersion: number;
  vipMilestoneMode: string;
  vipTimeframe: string;
  vipDowngradeGraceDays: number;
  vipAutoDowngradeEnabled: boolean;
  earningRules: Array<Record<string, any>>;
  bonusCampaigns: Array<Record<string, any>>;
  tiers: Array<Record<string, any>>;
};

function isPlainObject(value: unknown): value is JsonObject {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
  );
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  if (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return JSON.stringify(value);
  }
  throw new LoyaltyEarnPolicyRevisionError(
    "Loyalty earn policy contains a non-canonical JSON value.",
  );
}

function cloneJson(value: unknown, field: string): Prisma.JsonValue | null {
  if (value === null || value === undefined) return null;
  try {
    return JSON.parse(canonicalJson(value)) as Prisma.JsonValue;
  } catch (error) {
    if (error instanceof LoyaltyEarnPolicyRevisionError) throw error;
    throw new LoyaltyEarnPolicyRevisionError(
      `Loyalty earn policy field '${field}' is not valid JSON.`,
    );
  }
}

function exactId(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    throw new LoyaltyEarnPolicyRevisionError(
      `Loyalty earn policy field '${field}' is invalid.`,
    );
  }
  return value;
}

function exactDate(value: unknown, field: string): Date {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new LoyaltyEarnPolicyRevisionError(
      `Loyalty earn policy field '${field}' is not a valid timestamp.`,
    );
  }
  return date;
}

function exactInteger(
  value: unknown,
  field: string,
  { minimum = 0 }: { minimum?: number } = {},
): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new LoyaltyEarnPolicyRevisionError(
      `Loyalty earn policy field '${field}' is not a safe integer.`,
    );
  }
  return Number(value);
}

function exactBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new LoyaltyEarnPolicyRevisionError(
      `Loyalty earn policy field '${field}' must be a boolean.`,
    );
  }
  return value;
}

function decimalString(value: unknown, field: string): string {
  try {
    const decimal = new Prisma.Decimal(value as Prisma.Decimal.Value);
    if (!decimal.isFinite()) throw new Error("not finite");
    return decimal.toString();
  } catch {
    throw new LoyaltyEarnPolicyRevisionError(
      `Loyalty earn policy field '${field}' is not a decimal.`,
    );
  }
}

function positiveDecimalString(value: unknown, field: string): string {
  const normalized = decimalString(value, field);
  if (!new Prisma.Decimal(normalized).gt(0)) {
    throw new LoyaltyEarnPolicyRevisionError(
      `Loyalty earn policy field '${field}' must be greater than zero.`,
    );
  }
  return normalized;
}

function nonNegativeDecimalString(value: unknown, field: string): string {
  const normalized = decimalString(value, field);
  if (new Prisma.Decimal(normalized).lt(0)) {
    throw new LoyaltyEarnPolicyRevisionError(
      `Loyalty earn policy field '${field}' must not be negative.`,
    );
  }
  return normalized;
}

function bigintString(value: unknown, field: string): string {
  try {
    return BigInt(value as string | number | bigint).toString();
  } catch {
    throw new LoyaltyEarnPolicyRevisionError(
      `Loyalty earn policy field '${field}' is not an integer.`,
    );
  }
}

function positiveBigintString(value: unknown, field: string): string {
  const normalized = bigintString(value, field);
  if (BigInt(normalized) <= BigInt(0)) {
    throw new LoyaltyEarnPolicyRevisionError(
      `Loyalty earn policy field '${field}' must be greater than zero.`,
    );
  }
  return normalized;
}

function nonNegativeBigintString(value: unknown, field: string): string {
  const normalized = bigintString(value, field);
  if (BigInt(normalized) < BigInt(0)) {
    throw new LoyaltyEarnPolicyRevisionError(
      `Loyalty earn policy field '${field}' must not be negative.`,
    );
  }
  return normalized;
}

function nullablePositiveBigintString(value: unknown, field: string) {
  return value === null || value === undefined
    ? null
    : positiveBigintString(value, field);
}

function nullableNonNegativeDecimalString(value: unknown, field: string) {
  return value === null || value === undefined
    ? null
    : nonNegativeDecimalString(value, field);
}

function stringArray(value: unknown, field: string): string[] {
  if (value === null || value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.some(
      (entry) => typeof entry !== "string" || !entry || entry !== entry.trim(),
    )
  ) {
    throw new LoyaltyEarnPolicyRevisionError(
      `Loyalty earn policy field '${field}' must be an array of exact IDs.`,
    );
  }
  return Array.from(new Set(value)).sort();
}

function optionalCampaignTargetList({
  campaign,
  field,
  normalize,
}: {
  campaign: Record<string, unknown>;
  field: "eligibleSkus" | "eligibleCollectionIds";
  normalize: (value: unknown) => string[];
}): string[] | undefined {
  if (!Object.prototype.hasOwnProperty.call(campaign, field)) {
    return undefined;
  }
  try {
    return normalize(campaign[field]);
  } catch (error) {
    throw new LoyaltyEarnPolicyRevisionError(
      `Loyalty earn policy field 'bonusCampaign.${field}' is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new LoyaltyEarnPolicyRevisionError(
      `Loyalty earn policy field '${field}' has an unsupported value.`,
    );
  }
  return value as T;
}

function compareDecimalDescending(left: string, right: string) {
  return new Prisma.Decimal(right).cmp(new Prisma.Decimal(left));
}

export function buildLoyaltyEarnPolicySnapshot(
  program: PolicyProgramProjection,
): {
  snapshot: LoyaltyEarnPolicySnapshotV1;
  fingerprint: string;
} {
  const snapshot: LoyaltyEarnPolicySnapshotV1 = {
    schemaVersion: LOYALTY_EARN_POLICY_SCHEMA_VERSION,
    program: {
      id: exactId(program.id, "program.id"),
      storeId: exactId(program.storeId, "program.storeId"),
      status: oneOf(
        program.status,
        ["draft", "test", "active", "disabled"] as const,
        "program.status",
      ),
      pointsPerCurrencyUnit: positiveDecimalString(
        program.pointsPerCurrencyUnit,
        "program.pointsPerCurrencyUnit",
      ),
      holdingPeriodDays: exactInteger(
        program.holdingPeriodDays,
        "program.holdingPeriodDays",
      ),
      pointsExpiryMonths: exactInteger(
        program.pointsExpiryMonths,
        "program.pointsExpiryMonths",
      ),
      pointsExpiryDays: exactInteger(
        program.pointsExpiryDays,
        "program.pointsExpiryDays",
      ),
      pointsExpiryWarningDays: exactInteger(
        program.pointsExpiryWarningDays,
        "program.pointsExpiryWarningDays",
      ),
      pointsExpiryLastChanceDays: exactInteger(
        program.pointsExpiryLastChanceDays,
        "program.pointsExpiryLastChanceDays",
      ),
      pointsExpiryWarningEnabled: exactBoolean(
        program.pointsExpiryWarningEnabled,
        "program.pointsExpiryWarningEnabled",
      ),
      pointsExpiryLastChanceEnabled: exactBoolean(
        program.pointsExpiryLastChanceEnabled,
        "program.pointsExpiryLastChanceEnabled",
      ),
      pointsExpiryPolicyAnchorAt: program.pointsExpiryPolicyAnchorAt
        ? exactDate(
            program.pointsExpiryPolicyAnchorAt,
            "program.pointsExpiryPolicyAnchorAt",
          ).toISOString()
        : null,
      pointsExpiryPolicyVersion: exactInteger(
        program.pointsExpiryPolicyVersion,
        "program.pointsExpiryPolicyVersion",
      ),
      vipMilestoneMode: oneOf(
        program.vipMilestoneMode,
        ["amount_spent", "points_earned", "both"] as const,
        "program.vipMilestoneMode",
      ),
      vipTimeframe: oneOf(
        program.vipTimeframe,
        ["rolling_12m", "calendar_year", "lifetime"] as const,
        "program.vipTimeframe",
      ),
      vipDowngradeGraceDays: exactInteger(
        program.vipDowngradeGraceDays,
        "program.vipDowngradeGraceDays",
      ),
      vipAutoDowngradeEnabled: exactBoolean(
        program.vipAutoDowngradeEnabled,
        "program.vipAutoDowngradeEnabled",
      ),
    },
    earningRules: program.earningRules
      .filter((rule) => !rule.deletedAt)
      .map((rule) => {
        const triggerCode = exactId(
          rule.triggerCode,
          "earningRule.triggerCode",
        );
        const ruleType = oneOf(
          rule.ruleType,
          ["multiplier", "fixed_points"] as const,
          "earningRule.ruleType",
        );
        const fixedPoints = nullablePositiveBigintString(
          rule.fixedPoints,
          "earningRule.fixedPoints",
        );
        if (ruleType === "fixed_points" && fixedPoints === null) {
          throw new LoyaltyEarnPolicyRevisionError(
            "Fixed-points loyalty earning rules require positive fixedPoints.",
          );
        }
        const maxEventsPerCustomer =
          rule.maxEventsPerCustomer === null ||
          rule.maxEventsPerCustomer === undefined
            ? null
            : exactInteger(
                rule.maxEventsPerCustomer,
                "earningRule.maxEventsPerCustomer",
                { minimum: 1 },
              );
        const limitInterval =
          rule.limitInterval === null || rule.limitInterval === undefined
            ? null
            : oneOf(
                rule.limitInterval,
                ["lifetime", "monthly", "calendar_year"] as const,
                "earningRule.limitInterval",
              );
        if ((maxEventsPerCustomer === null) !== (limitInterval === null)) {
          throw new LoyaltyEarnPolicyRevisionError(
            "Loyalty earning limits require both maxEventsPerCustomer and limitInterval, or neither.",
          );
        }
        const excludeTaxesAndShipping = exactBoolean(
          rule.excludeTaxesAndShipping,
          "earningRule.excludeTaxesAndShipping",
        );
        if (triggerCode === "order_paid" && !excludeTaxesAndShipping) {
          throw new LoyaltyEarnPolicyRevisionError(
            "Order earning policies must exclude taxes and shipping for line-auditable refunds.",
          );
        }
        const startAt = rule.startAt
          ? exactDate(rule.startAt, "earningRule.startAt")
          : null;
        const endAt = rule.endAt
          ? exactDate(rule.endAt, "earningRule.endAt")
          : null;
        if (startAt && endAt && endAt < startAt) {
          throw new LoyaltyEarnPolicyRevisionError(
            "Loyalty earning rule endAt must not precede startAt.",
          );
        }

        return {
          id: exactId(rule.id, "earningRule.id"),
          triggerCode,
          ruleType,
          priority: exactInteger(rule.priority, "earningRule.priority", {
            minimum: Number.MIN_SAFE_INTEGER,
          }),
          multiplier: positiveDecimalString(
            rule.multiplier,
            "earningRule.multiplier",
          ),
          fixedPoints,
          minOrderSubtotal: nullableNonNegativeDecimalString(
            rule.minOrderSubtotal,
            "earningRule.minOrderSubtotal",
          ),
          maxPointsPerEvent: nullablePositiveBigintString(
            rule.maxPointsPerEvent,
            "earningRule.maxPointsPerEvent",
          ),
          maxEventsPerCustomer,
          limitInterval,
          eligibleTierIds: stringArray(
            rule.eligibleTierIds,
            "earningRule.eligibleTierIds",
          ),
          conditions: cloneJson(rule.conditions, "earningRule.conditions"),
          excludeDiscountedItems: exactBoolean(
            rule.excludeDiscountedItems,
            "earningRule.excludeDiscountedItems",
          ),
          excludeTaxesAndShipping,
          startAt: startAt?.toISOString() ?? null,
          endAt: endAt?.toISOString() ?? null,
          isActive: exactBoolean(rule.isActive, "earningRule.isActive"),
          createdAt: exactDate(
            rule.createdAt,
            "earningRule.createdAt",
          ).toISOString(),
        };
      })
      .sort(
        (left, right) =>
          right.priority - left.priority ||
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id),
      ),
    bonusCampaigns: program.bonusCampaigns
      .filter((campaign) => !campaign.deletedAt)
      .map((campaign) => {
        const startAt = exactDate(campaign.startAt, "bonusCampaign.startAt");
        const endAt = exactDate(campaign.endAt, "bonusCampaign.endAt");
        const eligibleSkus = optionalCampaignTargetList({
          campaign,
          field: "eligibleSkus",
          normalize: normalizeEligibleSkus,
        });
        const eligibleCollectionIds = optionalCampaignTargetList({
          campaign,
          field: "eligibleCollectionIds",
          normalize: normalizeEligibleCollectionIds,
        });
        if (endAt <= startAt) {
          throw new LoyaltyEarnPolicyRevisionError(
            "Loyalty bonus campaign endAt must be after startAt.",
          );
        }
        return {
          id: exactId(campaign.id, "bonusCampaign.id"),
          multiplier: positiveDecimalString(
            campaign.multiplier,
            "bonusCampaign.multiplier",
          ),
          startAt: startAt.toISOString(),
          endAt: endAt.toISOString(),
          isActive: exactBoolean(campaign.isActive, "bonusCampaign.isActive"),
          eligibleTierIds: stringArray(
            campaign.eligibleTierIds,
            "bonusCampaign.eligibleTierIds",
          ),
          ...(eligibleSkus === undefined ? {} : { eligibleSkus }),
          ...(eligibleCollectionIds === undefined
            ? {}
            : { eligibleCollectionIds }),
          createdAt: exactDate(
            campaign.createdAt,
            "bonusCampaign.createdAt",
          ).toISOString(),
        };
      })
      .sort(
        (left, right) =>
          compareDecimalDescending(left.multiplier, right.multiplier) ||
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id),
      ),
    tiers: program.tiers
      .filter((tier) => !tier.deletedAt)
      .map((tier) => ({
        id: exactId(tier.id, "tier.id"),
        tierOrder: exactInteger(tier.tierOrder, "tier.tierOrder", {
          minimum: 1,
        }),
        minSpendThreshold: nonNegativeBigintString(
          tier.minSpendThreshold,
          "tier.minSpendThreshold",
        ),
        minPointsThreshold: nonNegativeBigintString(
          tier.minPointsThreshold,
          "tier.minPointsThreshold",
        ),
        pointsMultiplier: positiveDecimalString(
          tier.pointsMultiplier,
          "tier.pointsMultiplier",
        ),
        entryBonusPoints: nonNegativeBigintString(
          tier.entryBonusPoints,
          "tier.entryBonusPoints",
        ),
        gracePeriodDays:
          tier.gracePeriodDays === null || tier.gracePeriodDays === undefined
            ? null
            : exactInteger(tier.gracePeriodDays, "tier.gracePeriodDays"),
        criteria: cloneJson(tier.criteria, "tier.criteria"),
        createdAt: exactDate(tier.createdAt, "tier.createdAt").toISOString(),
      }))
      .sort(
        (left, right) =>
          left.tierOrder - right.tierOrder || left.id.localeCompare(right.id),
      ),
  };

  const canonical = canonicalJson(snapshot);
  return {
    snapshot,
    fingerprint: createHash("sha256").update(canonical).digest("hex"),
  };
}

function objectValue(value: unknown, field: string): JsonObject {
  if (!isPlainObject(value)) {
    throw new LoyaltyEarnPolicyRevisionError(
      `Loyalty earn policy field '${field}' must be an object.`,
    );
  }
  return value;
}

function arrayValue(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new LoyaltyEarnPolicyRevisionError(
      `Loyalty earn policy field '${field}' must be an array.`,
    );
  }
  return value;
}

export function parseLoyaltyEarnPolicySnapshot(
  value: unknown,
): ParsedLoyaltyEarnPolicy {
  const root = objectValue(value, "snapshot");
  if (
    root.schemaVersion !== LOYALTY_EARN_POLICY_SCHEMA_VERSION ||
    Object.keys(root).some(
      (key) =>
        ![
          "schemaVersion",
          "program",
          "earningRules",
          "bonusCampaigns",
          "tiers",
        ].includes(key),
    )
  ) {
    throw new LoyaltyEarnPolicyRevisionError(
      "Unsupported loyalty earn policy snapshot schema.",
    );
  }
  const program = objectValue(root.program, "program");
  const serialized = buildLoyaltyEarnPolicySnapshot({
    ...program,
    earningRules: arrayValue(root.earningRules, "earningRules"),
    bonusCampaigns: arrayValue(root.bonusCampaigns, "bonusCampaigns"),
    tiers: arrayValue(root.tiers, "tiers"),
  } as PolicyProgramProjection).snapshot;

  return {
    schemaVersion: LOYALTY_EARN_POLICY_SCHEMA_VERSION,
    program: {
      ...serialized.program,
      pointsPerCurrencyUnit: new Prisma.Decimal(
        serialized.program.pointsPerCurrencyUnit,
      ),
      pointsExpiryPolicyAnchorAt: serialized.program.pointsExpiryPolicyAnchorAt
        ? new Date(serialized.program.pointsExpiryPolicyAnchorAt)
        : null,
    },
    earningRules: serialized.earningRules.map((rule) => ({
      ...rule,
      multiplier: new Prisma.Decimal(rule.multiplier),
      fixedPoints: rule.fixedPoints === null ? null : BigInt(rule.fixedPoints),
      minOrderSubtotal:
        rule.minOrderSubtotal === null
          ? null
          : new Prisma.Decimal(rule.minOrderSubtotal),
      maxPointsPerEvent:
        rule.maxPointsPerEvent === null ? null : BigInt(rule.maxPointsPerEvent),
      startAt: rule.startAt ? new Date(rule.startAt) : null,
      endAt: rule.endAt ? new Date(rule.endAt) : null,
      createdAt: new Date(rule.createdAt),
    })),
    bonusCampaigns: serialized.bonusCampaigns.map((campaign) => ({
      ...campaign,
      multiplier: new Prisma.Decimal(campaign.multiplier),
      startAt: new Date(campaign.startAt),
      endAt: new Date(campaign.endAt),
      createdAt: new Date(campaign.createdAt),
    })),
    tiers: serialized.tiers.map((tier) => ({
      ...tier,
      minSpendThreshold: BigInt(tier.minSpendThreshold),
      minPointsThreshold: BigInt(tier.minPointsThreshold),
      pointsMultiplier: new Prisma.Decimal(tier.pointsMultiplier),
      entryBonusPoints: BigInt(tier.entryBonusPoints),
      createdAt: new Date(tier.createdAt),
    })),
  };
}

export function verifyLoyaltyEarnPolicyRevisionSnapshot({
  revisionId,
  storeId,
  programId,
  schemaVersion,
  snapshot,
  fingerprint,
  expectedStoreId,
  expectedProgramId,
}: {
  revisionId: string;
  storeId: string;
  programId: string;
  schemaVersion: number;
  snapshot: Prisma.JsonValue;
  fingerprint: string;
  expectedStoreId: string;
  expectedProgramId: string;
}): ParsedLoyaltyEarnPolicy {
  const exactRevisionId = exactId(revisionId, "revisionId");
  const exactStoreId = exactId(expectedStoreId, "expectedStoreId");
  const exactProgramId = exactId(expectedProgramId, "expectedProgramId");
  if (
    storeId !== exactStoreId ||
    programId !== exactProgramId ||
    schemaVersion !== LOYALTY_EARN_POLICY_SCHEMA_VERSION
  ) {
    throw new LoyaltyEarnPolicyRevisionError(
      `Loyalty policy revision ${exactRevisionId} crosses a tenant boundary or uses an unsupported schema.`,
    );
  }

  const canonical = canonicalJson(snapshot);
  const actualFingerprint = createHash("sha256")
    .update(canonical)
    .digest("hex");
  if (actualFingerprint !== fingerprint) {
    throw new LoyaltyEarnPolicyRevisionError(
      `Loyalty policy revision ${exactRevisionId} failed its fingerprint check.`,
    );
  }

  const policy = parseLoyaltyEarnPolicySnapshot(snapshot);
  const normalizedSnapshot = buildLoyaltyEarnPolicySnapshot({
    ...policy.program,
    earningRules: policy.earningRules,
    bonusCampaigns: policy.bonusCampaigns,
    tiers: policy.tiers,
  }).snapshot;
  if (canonicalJson(normalizedSnapshot) !== canonical) {
    throw new LoyaltyEarnPolicyRevisionError(
      `Loyalty policy revision ${exactRevisionId} contains unknown or non-canonical nested fields.`,
    );
  }
  if (
    policy.program.id !== exactProgramId ||
    policy.program.storeId !== exactStoreId
  ) {
    throw new LoyaltyEarnPolicyRevisionError(
      `Loyalty policy revision ${exactRevisionId} crosses a tenant boundary.`,
    );
  }
  return policy;
}

function exactEffectiveAt(value: Date) {
  return exactDate(value, "effectiveAt");
}

function normalizedReason(value: string | null | undefined) {
  if (value === null || value === undefined) return null;
  const reason = value.trim();
  if (!reason || reason.length > 191) {
    throw new LoyaltyEarnPolicyRevisionError(
      "Loyalty earn policy revision reason is invalid.",
    );
  }
  return reason;
}

export async function publishLoyaltyEarnPolicyRevision({
  tx,
  storeId,
  programId,
  effectiveAt = new Date(),
  reason,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  programId: string;
  effectiveAt?: Date;
  reason?: string | null;
}) {
  const exactStoreId = exactId(storeId, "storeId");
  const exactProgramId = exactId(programId, "programId");
  const revisionEffectiveAt = exactEffectiveAt(effectiveAt);
  await lockLoyaltyProgramRow({
    tx,
    storeId: exactStoreId,
    mode: "lock_only",
  });

  const program = await tx.weleticLoyaltyProgram.findFirst({
    where: { id: exactProgramId, storeId: exactStoreId },
    include: {
      earningRules: { where: { deletedAt: null } },
      bonusCampaigns: { where: { deletedAt: null } },
      tiers: { where: { deletedAt: null } },
    },
  });
  if (!program) {
    throw new LoyaltyEarnPolicyRevisionError(
      `Loyalty program ${exactProgramId} is unavailable for store ${exactStoreId}.`,
    );
  }

  const head = await tx.weleticLoyaltyEarnPolicyRevision.findFirst({
    where: { storeId: exactStoreId, programId: exactProgramId },
    orderBy: [{ version: "desc" }],
  });
  const currentVersion = program.earnPolicyVersion ?? 0;
  if ((head?.version ?? 0) !== currentVersion) {
    throw new LoyaltyEarnPolicyRevisionError(
      `Loyalty program ${exactProgramId} has an inconsistent policy revision head.`,
    );
  }
  if (head) {
    verifyLoyaltyEarnPolicyRevisionSnapshot({
      revisionId: head.id,
      storeId: head.storeId,
      programId: head.programId,
      schemaVersion: head.schemaVersion,
      snapshot: head.snapshot,
      fingerprint: head.fingerprint,
      expectedStoreId: exactStoreId,
      expectedProgramId: exactProgramId,
    });
  }
  if (head && revisionEffectiveAt < head.effectiveAt) {
    throw new LoyaltyEarnPolicyRevisionError(
      "Loyalty earn policy revisions cannot be backdated.",
    );
  }

  const { snapshot, fingerprint } = buildLoyaltyEarnPolicySnapshot(program);
  if (head?.fingerprint === fingerprint) return head;

  const nextVersion = currentVersion + 1;
  const claimed = await tx.weleticLoyaltyProgram.updateMany({
    where: {
      id: exactProgramId,
      storeId: exactStoreId,
      earnPolicyVersion: currentVersion,
    },
    data: { earnPolicyVersion: nextVersion },
  });
  if (claimed.count !== 1) {
    throw new LoyaltyEarnPolicyRevisionError(
      `Loyalty program ${exactProgramId} policy revision claim was lost.`,
    );
  }

  return tx.weleticLoyaltyEarnPolicyRevision.create({
    data: {
      id: createWeleticId("wpolicy_"),
      storeId: exactStoreId,
      programId: exactProgramId,
      version: nextVersion,
      effectiveAt: revisionEffectiveAt,
      schemaVersion: LOYALTY_EARN_POLICY_SCHEMA_VERSION,
      snapshot: snapshot as unknown as Prisma.InputJsonValue,
      fingerprint,
      reason: normalizedReason(reason),
    },
  });
}

export async function resolveLoyaltyEarnPolicyRevisionAt({
  tx,
  storeId,
  programId,
  occurredAt,
  preferredRevisionId,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  programId: string;
  occurredAt: Date;
  preferredRevisionId?: string | null;
}): Promise<{
  revision: Awaited<
    ReturnType<
      Prisma.TransactionClient["weleticLoyaltyEarnPolicyRevision"]["findFirst"]
    >
  > & {};
  policy: ParsedLoyaltyEarnPolicy;
} | null> {
  const exactStoreId = exactId(storeId, "storeId");
  const exactProgramId = exactId(programId, "programId");
  const eventTime = exactDate(occurredAt, "occurredAt");
  const revision = preferredRevisionId
    ? await tx.weleticLoyaltyEarnPolicyRevision.findFirst({
        where: {
          id: exactId(preferredRevisionId, "preferredRevisionId"),
          storeId: exactStoreId,
          programId: exactProgramId,
        },
      })
    : await tx.weleticLoyaltyEarnPolicyRevision.findFirst({
        where: {
          storeId: exactStoreId,
          programId: exactProgramId,
          effectiveAt: { lte: eventTime },
        },
        orderBy: [{ effectiveAt: "desc" }, { version: "desc" }],
      });
  if (!revision) {
    if (preferredRevisionId) {
      throw new LoyaltyEarnPolicyRevisionError(
        `Bound loyalty policy revision ${preferredRevisionId} is unavailable.`,
      );
    }
    return null;
  }
  if (revision.effectiveAt > eventTime) {
    throw new LoyaltyEarnPolicyRevisionError(
      `Loyalty policy revision ${revision.id} is invalid for this order event.`,
    );
  }
  const policy = verifyLoyaltyEarnPolicyRevisionSnapshot({
    revisionId: revision.id,
    storeId: revision.storeId,
    programId: revision.programId,
    schemaVersion: revision.schemaVersion,
    snapshot: revision.snapshot,
    fingerprint: revision.fingerprint,
    expectedStoreId: exactStoreId,
    expectedProgramId: exactProgramId,
  });
  return { revision, policy };
}
