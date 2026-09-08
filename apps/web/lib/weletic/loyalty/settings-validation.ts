import { Prisma } from "@prisma/client";

const MAX_SIGNED_64_BIT_INTEGER = BigInt("9223372036854775807");

/** Transport-neutral validation shared by workspace and signed Shopify callers.
 * Authorization and accounting-currency checks belong to the caller's transaction.
 */
export class LoyaltySettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoyaltySettingsValidationError";
  }
}

export function readNullablePositiveBigInt(
  value: unknown,
  field: string,
): bigint | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    throw new LoyaltySettingsValidationError(
      `${field} must be a positive integer encoded as a decimal string.`,
    );
  }
  const parsed = BigInt(value);
  if (parsed > MAX_SIGNED_64_BIT_INTEGER) {
    throw new LoyaltySettingsValidationError(
      `${field} exceeds the supported 64-bit integer range.`,
    );
  }
  return parsed;
}

export function readPositiveDecimal(
  value: unknown,
  field: string,
): Prisma.Decimal | undefined {
  if (value === undefined) return undefined;
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && value.trim() === "")
  ) {
    throw new LoyaltySettingsValidationError(
      `${field} must be a positive decimal.`,
    );
  }
  try {
    const parsed = new Prisma.Decimal(value);
    if (!parsed.isFinite() || !parsed.gt(0)) throw new Error("not positive");
    return parsed;
  } catch {
    throw new LoyaltySettingsValidationError(
      `${field} must be a positive decimal.`,
    );
  }
}

export function readNonNegativeInteger(
  value: unknown,
  field: string,
  maximum?: number,
): number | undefined {
  if (value === undefined) return undefined;
  const requirement =
    maximum === undefined
      ? "a non-negative integer."
      : `a non-negative integer no greater than ${maximum}.`;
  if (
    typeof value !== "number" &&
    !(typeof value === "string" && value.trim() !== "")
  ) {
    throw new LoyaltySettingsValidationError(`${field} must be ${requirement}`);
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 0 ||
    (maximum !== undefined && parsed > maximum)
  ) {
    throw new LoyaltySettingsValidationError(`${field} must be ${requirement}`);
  }
  return parsed;
}
