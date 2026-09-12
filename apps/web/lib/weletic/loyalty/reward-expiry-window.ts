/** The preserved reference specifies a three-day reminder and no timing editor.
 * Use an elapsed interval before the authoritative expiry instant, not the
 * server's local calendar. This does not choose the merchant's display timezone.
 */
export const REWARD_EXPIRY_REMINDER_LEAD_MS = 3 * 24 * 60 * 60 * 1000;

/** Scheduling evidence only: callers must separately prove receipt ownership,
 * original generation, reward usability, admission, privacy and enabled policy.
 * Late issuance/downtime may catch up only while the reward is still unexpired.
 */
export function rewardExpiryReminderWindow({
  issuedAt,
  expiresAt,
}: {
  issuedAt: Date | null;
  expiresAt: Date | null;
}): { dueAt: Date; expiresAt: Date } | null {
  if (!issuedAt || !expiresAt) return null;
  const issued = issuedAt.getTime();
  const expiry = expiresAt.getTime();
  if (!Number.isFinite(issued) || !Number.isFinite(expiry) || expiry <= issued)
    return null;
  return {
    dueAt: new Date(Math.max(issued, expiry - REWARD_EXPIRY_REMINDER_LEAD_MS)),
    expiresAt: new Date(expiry),
  };
}

export function isRewardExpiryReminderDue({
  issuedAt,
  expiresAt,
  now,
}: {
  issuedAt: Date | null;
  expiresAt: Date | null;
  now: Date;
}): boolean {
  const window = rewardExpiryReminderWindow({ issuedAt, expiresAt });
  const current = now.getTime();
  return (
    !!window &&
    Number.isFinite(current) &&
    current >= window.dueAt.getTime() &&
    current < window.expiresAt.getTime()
  );
}
