import { createWeleticId } from "@/lib/weletic/ids";
import { Prisma, type WeleticLoyaltyProgram } from "@prisma/client";
import { publishLoyaltyEarnPolicyRevision } from "./earn-policy-revision";
import { calculateNextPointsExpiryDate } from "./points-expiry-policy";

export class LoyaltySettingsWriteError extends Error {
  readonly code: "conflict" | "bad_request";
  constructor({
    code,
    message,
  }: {
    code: "conflict" | "bad_request";
    message: string;
  }) {
    super(message);
    this.name = "LoyaltySettingsWriteError";
    this.code = code;
  }
}

type ProgramFields = Partial<
  Pick<
    WeleticLoyaltyProgram,
    | "name"
    | "status"
    | "pointNameSingular"
    | "pointNamePlural"
    | "pointsExpiryWarningEnabled"
    | "pointsExpiryLastChanceEnabled"
    | "killSwitchActive"
    | "vipMilestoneMode"
    | "vipTimeframe"
    | "vipAutoDowngradeEnabled"
  >
>;

/** Internal normalized input. Public callers must validate configuration and
 * authorize the operation before entering the fenced transaction.
 */
export type ValidatedLoyaltySettings = ProgramFields & {
  expectedStatus?: WeleticLoyaltyProgram["status"] | "not_configured";
  parsedPointsPerCurrencyUnit?: Prisma.Decimal;
  normalizedValuationCurrency?: string | null;
  parsedLiabilityNumerator?: bigint | null;
  parsedLiabilityDenominator?: bigint | null;
  valuationFieldsPresent?: boolean;
  parsedHoldingPeriodDays?: number;
  parsedExpiryDays?: number;
  parsedExpiryMonths?: number;
  parsedWarningDays?: number;
  parsedLastChanceDays?: number;
  parsedVipGraceDays?: number;
};

/** One existing settings writer; the caller owns authorization, fencing and
 * transaction lifetime. Never start a nested transaction or retry here.
 */
export async function writeValidatedLoyaltySettingsInTransaction(
  tx: Prisma.TransactionClient,
  storeId: string,
  input: ValidatedLoyaltySettings,
) {
  const {
    expectedStatus,
    name,
    status,
    pointNameSingular,
    pointNamePlural,
    parsedPointsPerCurrencyUnit,
    normalizedValuationCurrency,
    parsedLiabilityNumerator,
    parsedLiabilityDenominator,
    valuationFieldsPresent,
    parsedHoldingPeriodDays,
    parsedExpiryDays,
    parsedExpiryMonths,
    parsedWarningDays,
    parsedLastChanceDays,
    pointsExpiryWarningEnabled,
    pointsExpiryLastChanceEnabled,
    killSwitchActive,
    vipMilestoneMode,
    vipTimeframe,
    parsedVipGraceDays,
    vipAutoDowngradeEnabled,
  } = input;
  const existing = await tx.weleticLoyaltyProgram.findUnique({
    where: { storeId },
  });
  if (
    expectedStatus !== undefined &&
    expectedStatus !== (existing?.status ?? "not_configured")
  ) {
    throw new LoyaltySettingsWriteError({
      code: "conflict",
      message: "Loyalty status changed. Reload before toggling the module",
    });
  }
  const now = new Date();
  const nextExpiryDays =
    parsedExpiryDays !== undefined
      ? parsedExpiryDays
      : parsedExpiryMonths !== undefined
        ? 0
        : existing?.pointsExpiryDays || 0;
  const nextExpiryMonths =
    parsedExpiryMonths !== undefined
      ? parsedExpiryMonths
      : parsedExpiryDays !== undefined
        ? 0
        : existing?.pointsExpiryMonths || 0;
  const nextStatus = status ?? existing?.status ?? "draft";
  const nextKillSwitch =
    killSwitchActive !== undefined
      ? Boolean(killSwitchActive)
      : existing?.killSwitchActive || false;
  const currentEnabled = Boolean(
    existing &&
      existing.status === "active" &&
      !existing.killSwitchActive &&
      (existing.pointsExpiryDays > 0 || existing.pointsExpiryMonths > 0),
  );
  const nextEnabled =
    nextStatus === "active" &&
    !nextKillSwitch &&
    (nextExpiryDays > 0 || nextExpiryMonths > 0);
  const nextWarningDays =
    parsedWarningDays ?? existing?.pointsExpiryWarningDays ?? 30;
  const nextLastChanceDays =
    parsedLastChanceDays ?? existing?.pointsExpiryLastChanceDays ?? 3;
  const nextWarningEnabled =
    pointsExpiryWarningEnabled ?? existing?.pointsExpiryWarningEnabled ?? true;
  const nextLastChanceEnabled =
    pointsExpiryLastChanceEnabled ??
    existing?.pointsExpiryLastChanceEnabled ??
    true;
  if (
    nextWarningEnabled &&
    nextLastChanceEnabled &&
    nextLastChanceDays > nextWarningDays
  ) {
    throw new LoyaltySettingsWriteError({
      code: "bad_request",
      message:
        "The last-chance threshold cannot be earlier than the warning threshold.",
    });
  }
  const currentExpiryAt = existing
    ? calculateNextPointsExpiryDate({
        policy: existing,
        lastActivityAt: now,
        fallbackAt: now,
      })
    : null;
  const nextExpiryAt = calculateNextPointsExpiryDate({
    policy: {
      status: nextStatus,
      killSwitchActive: nextKillSwitch,
      pointsExpiryDays: nextExpiryDays,
      pointsExpiryMonths: nextExpiryMonths,
      pointsExpiryPolicyAnchorAt: existing?.pointsExpiryPolicyAnchorAt,
    },
    lastActivityAt: now,
    fallbackAt: now,
  });
  const expiryWindowReduced = Boolean(
    currentExpiryAt &&
      nextExpiryAt &&
      nextExpiryAt.getTime() < currentExpiryAt.getTime(),
  );
  const expiryPolicyChanged = Boolean(
    !existing ||
      existing.pointsExpiryDays !== nextExpiryDays ||
      existing.pointsExpiryMonths !== nextExpiryMonths ||
      existing.pointsExpiryWarningDays !== nextWarningDays ||
      existing.pointsExpiryLastChanceDays !== nextLastChanceDays ||
      existing.pointsExpiryWarningEnabled !== nextWarningEnabled ||
      existing.pointsExpiryLastChanceEnabled !== nextLastChanceEnabled ||
      (nextEnabled && !existing.pointsExpiryPolicyAnchorAt) ||
      currentEnabled !== nextEnabled,
  );
  const nextPolicyAnchorAt = !nextEnabled
    ? null
    : !currentEnabled || expiryWindowReduced
      ? now
      : existing?.pointsExpiryPolicyAnchorAt || now;
  const nextPolicyVersion =
    (existing?.pointsExpiryPolicyVersion || 0) + (expiryPolicyChanged ? 1 : 0);

  const saved = await tx.weleticLoyaltyProgram.upsert({
    where: { storeId },
    create: {
      id: createWeleticId("wprog_"),
      storeId,
      name: name || "Customer Loyalty Program",
      status: status ?? "draft",
      pointNameSingular: pointNameSingular || "Point",
      pointNamePlural: pointNamePlural || "Points",
      pointsPerCurrencyUnit:
        parsedPointsPerCurrencyUnit ?? new Prisma.Decimal(1),
      liabilityValuationCurrency: normalizedValuationCurrency ?? null,
      liabilityMinorUnitsNumerator: parsedLiabilityNumerator ?? null,
      liabilityPointsDenominator: parsedLiabilityDenominator ?? null,
      holdingPeriodDays: parsedHoldingPeriodDays ?? 0,
      pointsExpiryMonths: nextExpiryMonths,
      pointsExpiryDays: nextExpiryDays,
      pointsExpiryWarningDays: nextWarningDays,
      pointsExpiryLastChanceDays: nextLastChanceDays,
      pointsExpiryWarningEnabled: nextWarningEnabled,
      pointsExpiryLastChanceEnabled: nextLastChanceEnabled,
      pointsExpiryPolicyAnchorAt: nextPolicyAnchorAt,
      pointsExpiryPolicyVersion: nextPolicyVersion,
      killSwitchActive: Boolean(killSwitchActive),
      vipMilestoneMode: vipMilestoneMode || "amount_spent",
      vipTimeframe: vipTimeframe || "rolling_12m",
      vipDowngradeGraceDays: parsedVipGraceDays ?? 30,
      vipAutoDowngradeEnabled:
        vipAutoDowngradeEnabled === undefined ? true : vipAutoDowngradeEnabled,
    },
    update: {
      name: name !== undefined ? name : undefined,
      status: status !== undefined ? status : undefined,
      pointNameSingular:
        pointNameSingular !== undefined ? pointNameSingular : undefined,
      pointNamePlural:
        pointNamePlural !== undefined ? pointNamePlural : undefined,
      pointsPerCurrencyUnit: parsedPointsPerCurrencyUnit,
      liabilityValuationCurrency: valuationFieldsPresent
        ? normalizedValuationCurrency
        : undefined,
      liabilityMinorUnitsNumerator: valuationFieldsPresent
        ? parsedLiabilityNumerator
        : undefined,
      liabilityPointsDenominator: valuationFieldsPresent
        ? parsedLiabilityDenominator
        : undefined,
      holdingPeriodDays: parsedHoldingPeriodDays,
      pointsExpiryMonths: nextExpiryMonths,
      pointsExpiryDays: nextExpiryDays,
      pointsExpiryWarningDays:
        parsedWarningDays !== undefined ? parsedWarningDays : undefined,
      pointsExpiryLastChanceDays:
        parsedLastChanceDays !== undefined ? parsedLastChanceDays : undefined,
      pointsExpiryWarningEnabled,
      pointsExpiryLastChanceEnabled,
      pointsExpiryPolicyAnchorAt: nextPolicyAnchorAt,
      pointsExpiryPolicyVersion: nextPolicyVersion,
      killSwitchActive:
        killSwitchActive !== undefined ? Boolean(killSwitchActive) : undefined,
      vipMilestoneMode,
      vipTimeframe,
      vipDowngradeGraceDays: parsedVipGraceDays,
      vipAutoDowngradeEnabled,
    },
  });
  await publishLoyaltyEarnPolicyRevision({
    tx,
    storeId,
    programId: saved.id,
    reason: existing
      ? "loyalty_program_settings_updated"
      : "loyalty_program_initialized",
  });
  return saved;
}
