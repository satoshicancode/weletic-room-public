import { addDays, addMonths, subDays } from "date-fns";

export type PointsExpiryPolicy = {
  status?: string | null;
  killSwitchActive?: boolean | null;
  pointsExpiryDays?: number | null;
  pointsExpiryMonths?: number | null;
  pointsExpiryWarningDays?: number | null;
  pointsExpiryLastChanceDays?: number | null;
  pointsExpiryWarningEnabled?: boolean | null;
  pointsExpiryLastChanceEnabled?: boolean | null;
  pointsExpiryPolicyAnchorAt?: Date | null;
  activatedAt?: Date | null;
  createdAt?: Date | null;
  pointsExpiryPolicyVersion?: number | null;
};

export type PointsExpiryStage = "warning" | "last_chance" | "expire";

export function isPointsExpiryEnabled(policy: PointsExpiryPolicy) {
  return (
    policy.status === "active" &&
    policy.killSwitchActive !== true &&
    (Number(policy.pointsExpiryDays || 0) > 0 ||
      Number(policy.pointsExpiryMonths || 0) > 0)
  );
}

export function getPointsExpiryPolicyBaseDate({
  policy,
  lastActivityAt,
  fallbackAt,
}: {
  policy: PointsExpiryPolicy;
  lastActivityAt?: Date | null;
  fallbackAt?: Date;
}) {
  const candidates = [
    lastActivityAt,
    policy.pointsExpiryPolicyAnchorAt,
    policy.activatedAt,
    policy.createdAt,
  ].filter((value): value is Date => value instanceof Date);

  if (candidates.length === 0) return fallbackAt ?? null;
  return new Date(Math.max(...candidates.map((value) => value.getTime())));
}

export function calculateNextPointsExpiryDate({
  policy,
  lastActivityAt,
  fallbackAt,
}: {
  policy: PointsExpiryPolicy;
  lastActivityAt?: Date | null;
  fallbackAt?: Date;
}) {
  if (!isPointsExpiryEnabled(policy)) return null;

  const baseDate = getPointsExpiryPolicyBaseDate({
    policy,
    lastActivityAt,
    fallbackAt,
  });
  if (!baseDate) return null;

  const expiryDays = Number(policy.pointsExpiryDays || 0);
  if (expiryDays > 0) return addDays(baseDate, expiryDays);

  const expiryMonths = Number(policy.pointsExpiryMonths || 0);
  return expiryMonths > 0 ? addMonths(baseDate, expiryMonths) : null;
}

export function getPointsExpiryStageDate({
  policy,
  expiryAt,
  stage,
}: {
  policy: PointsExpiryPolicy;
  expiryAt: Date;
  stage: PointsExpiryStage;
}) {
  if (stage === "expire") return expiryAt;
  const thresholdDays =
    stage === "warning"
      ? Number(policy.pointsExpiryWarningDays ?? 30)
      : Number(policy.pointsExpiryLastChanceDays ?? 3);
  return subDays(expiryAt, Math.max(0, thresholdDays));
}

export function pointsExpiryDatesMatch(
  left: Date | string | null | undefined,
  right: Date | string | null | undefined,
) {
  if (!left || !right) return left == null && right == null;
  const leftTime = new Date(left).getTime();
  const rightTime = new Date(right).getTime();
  return Number.isFinite(leftTime) && leftTime === rightTime;
}

export function getPointsExpiryDurationLabel(policy: PointsExpiryPolicy) {
  const days = Number(policy.pointsExpiryDays || 0);
  if (days > 0) return `${days} day${days === 1 ? "" : "s"}`;

  const months = Number(policy.pointsExpiryMonths || 0);
  if (months === 12) return "1 year";
  if (months === 24) return "2 years";
  return `${months} month${months === 1 ? "" : "s"}`;
}
