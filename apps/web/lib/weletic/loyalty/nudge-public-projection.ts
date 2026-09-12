import {
  defaultLoyaltyNudgeSettings,
  loyaltyNudgeSettingsSchema,
} from "./nudge-contract";

/** Public presentation only. Never project arbitrary program metadata or grant
 * cart eligibility/redemption authority from these configuration values. */
export function projectPublicLoyaltyNudges(
  metadata: unknown,
  programActive: boolean,
) {
  const fallback = defaultLoyaltyNudgeSettings();
  if (
    !programActive ||
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata)
  )
    return fallback;
  const value = Object.hasOwn(metadata, "loyaltyNudges")
    ? (metadata as Record<string, unknown>).loyaltyNudges
    : undefined;
  const parsed = loyaltyNudgeSettingsSchema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}
