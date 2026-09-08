import { Prisma } from "@prisma/client";

export function mergeRedemptionMetadataTimestamp(
  metadata: Prisma.JsonValue,
  field: "cancelledAt",
  value: Date,
): Prisma.InputJsonObject {
  const existing =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? metadata
      : {};

  return {
    ...existing,
    [field]: value.toISOString(),
  } as Prisma.InputJsonObject;
}

export function readRedemptionMetadataDate(
  metadata: unknown,
  field: "cancelledAt",
): Date | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const value = (metadata as Record<string, unknown>)[field];
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
