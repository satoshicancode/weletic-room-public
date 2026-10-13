import { DubApiError } from "@/lib/api/errors";

export const MAX_SINGLE_MANUAL_ADJUSTMENT_POINTS = BigInt("10000000000000000"); // 10^16

/** Shared by both owner-only manual adjustment entry points. */
export function validateManualAdjustmentInput(input: {
  accountId?: unknown;
  shopperId?: unknown;
  shopifyCustomerId?: unknown;
  pointsDelta?: unknown;
  reason?: unknown;
}) {
  const { accountId, shopperId, shopifyCustomerId, pointsDelta, reason } =
    input;
  const customerIdentifier =
    typeof shopifyCustomerId === "number" &&
    Number.isSafeInteger(shopifyCustomerId) &&
    shopifyCustomerId > 0
      ? String(shopifyCustomerId)
      : shopifyCustomerId;
  const identifiers = [accountId, shopperId, customerIdentifier];
  if (
    !identifiers.some(
      (value) => typeof value === "string" && value.trim().length > 0,
    ) ||
    identifiers.some(
      (value) => value != null && (typeof value !== "string" || !value.trim()),
    )
  ) {
    throw new DubApiError({
      code: "bad_request",
      message:
        "An explicit customer or loyalty account identifier is required.",
    });
  }
  // Unsafe JSON numbers have already lost precision; large amounts must be strings.
  if (
    !(
      (typeof pointsDelta === "number" && Number.isSafeInteger(pointsDelta)) ||
      (typeof pointsDelta === "string" && /^-?\d+$/.test(pointsDelta))
    ) ||
    BigInt(pointsDelta) === BigInt(0) ||
    BigInt(pointsDelta) < BigInt("-9223372036854775808") ||
    BigInt(pointsDelta) > BigInt("9223372036854775807")
  ) {
    throw new DubApiError({
      code: "bad_request",
      message:
        "A non-zero exact signed 64-bit integer 'pointsDelta' is required.",
    });
  }

  const deltaBigInt = BigInt(pointsDelta);
  const absDelta = deltaBigInt < BigInt(0) ? -deltaBigInt : deltaBigInt;
  if (absDelta > MAX_SINGLE_MANUAL_ADJUSTMENT_POINTS) {
    throw new DubApiError({
      code: "bad_request",
      message: `Manual points adjustment cannot exceed ${MAX_SINGLE_MANUAL_ADJUSTMENT_POINTS.toString()} points per single operation.`,
    });
  }

  if (reason !== undefined && reason !== null) {
    if (
      typeof reason !== "string" ||
      reason.trim().length < 3 ||
      reason.trim().length > 255
    ) {
      throw new DubApiError({
        code: "bad_request",
        message:
          "Adjustment reason must be between 3 and 255 characters when provided.",
      });
    }
  }
}
