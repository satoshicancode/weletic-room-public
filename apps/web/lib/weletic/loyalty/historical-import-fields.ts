import { Prisma, type WeleticLoyaltyAccount } from "@prisma/client";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  historicalImportBirthdaySchema,
  type HistoricalImportRow,
} from "./historical-import-contract";
import { getNextBirthdayRewardSchedule } from "./non-purchase-earn";

const timestamp = z.string().datetime().nullable();
export const historicalImportFieldStateSchema = z
  .object({
    version: z.literal(1),
    storeId: z.string().min(1),
    programId: z.string().min(1),
    accountId: z.string().min(1),
    birthday: z.discriminatedUnion("present", [
      z.object({ present: z.literal(false) }).strict(),
      z.object({ present: z.literal(true), value: z.json() }).strict(),
    ]),
    currentTierId: z.string().nullable(),
    tierExpiresAt: timestamp,
    lastQualifyingActivityAt: timestamp,
    nextExpiryDate: timestamp,
    pointsExpiryPolicyVersion: z.number().int().nonnegative(),
    pointsExpiryJobsScheduledAt: timestamp,
  })
  .strict();

export type HistoricalImportFieldAccount = Pick<
  WeleticLoyaltyAccount,
  | "id"
  | "storeId"
  | "programId"
  | "metadata"
  | "currentTierId"
  | "tierExpiresAt"
  | "lastQualifyingActivityAt"
  | "nextExpiryDate"
  | "pointsExpiryPolicyVersion"
  | "pointsExpiryJobsScheduledAt"
>;

function metadataObject(value: Prisma.JsonValue | null): Prisma.JsonObject {
  if (value === null) return {};
  if (typeof value !== "object" || Array.isArray(value))
    throw new Error("Import account metadata unavailable");
  return value;
}

/** Month/day-only import follows the existing birthday route's 2000 anchor. */
export function planHistoricalImportBirthday({
  metadata: value,
  birthday,
  now,
}: {
  metadata: Prisma.JsonValue | null;
  birthday: HistoricalImportRow["birthday"];
  now: Date;
}) {
  const metadata = metadataObject(value);
  if (!birthday) return { metadata, schedule: null };
  const validated = historicalImportBirthdaySchema.parse(birthday);
  const birthDate = `2000-${String(validated.month).padStart(2, "0")}-${String(validated.day).padStart(2, "0")}`;
  if (
    Object.prototype.hasOwnProperty.call(metadata, "birthday") &&
    metadata.birthday !== null
  ) {
    const stored = metadata.birthday;
    if (
      !stored ||
      typeof stored !== "object" ||
      Array.isArray(stored) ||
      stored.birthDate !== birthDate ||
      typeof stored.registeredAt !== "string" ||
      Number.isNaN(Date.parse(stored.registeredAt))
    )
      throw new Error(
        "Historical import birthday conflicts with existing registration",
      );
    // Preserve registration age and existing schedule; importing is not a way
    // to overwrite a locked birthday or reissue an already scheduled reward.
    return { metadata, schedule: null };
  }
  const registeredAt = now.toISOString();
  const schedule = getNextBirthdayRewardSchedule({
    birthDate,
    registeredAt,
    now,
  });
  return {
    metadata: {
      ...metadata,
      birthday: {
        birthDate,
        registeredAt,
        nextEligibleYear: schedule.calendarYear,
      },
    } as Prisma.JsonObject,
    schedule: { ...schedule, birthDate, registeredAt },
  };
}

/** Capture only fields the import owns, never an entire metadata replacement. */
export function captureHistoricalImportFields(
  account: HistoricalImportFieldAccount,
) {
  const metadata = metadataObject(account.metadata);
  return historicalImportFieldStateSchema.parse({
    version: 1,
    storeId: account.storeId,
    programId: account.programId,
    accountId: account.id,
    birthday: Object.prototype.hasOwnProperty.call(metadata, "birthday")
      ? { present: true, value: metadata.birthday }
      : { present: false },
    currentTierId: account.currentTierId,
    tierExpiresAt: account.tierExpiresAt?.toISOString() ?? null,
    lastQualifyingActivityAt:
      account.lastQualifyingActivityAt?.toISOString() ?? null,
    nextExpiryDate: account.nextExpiryDate?.toISOString() ?? null,
    pointsExpiryPolicyVersion: account.pointsExpiryPolicyVersion,
    pointsExpiryJobsScheduledAt:
      account.pointsExpiryJobsScheduledAt?.toISOString() ?? null,
  });
}

/**
 * Pure rollback plan. Call with CURRENT locked fields before appending the
 * correction; apply the returned patch in that same transaction afterward.
 * Any owned-field change contains rollback. Unrelated metadata stays current.
 */
export function planHistoricalImportFieldRestoration({
  before,
  after,
  current,
}: {
  before: unknown;
  after: unknown;
  current: HistoricalImportFieldAccount;
}): Prisma.WeleticLoyaltyAccountUncheckedUpdateManyInput {
  try {
    const original = historicalImportFieldStateSchema.parse(before);
    const applied = historicalImportFieldStateSchema.parse(after);
    const actual = captureHistoricalImportFields(current);
    if (
      original.storeId !== actual.storeId ||
      original.programId !== actual.programId ||
      original.accountId !== actual.accountId ||
      !isDeepStrictEqual(applied, actual)
    )
      throw new Error("changed");
    const metadata = { ...metadataObject(current.metadata) };
    if (original.birthday.present) metadata.birthday = original.birthday.value;
    else delete metadata.birthday;
    const date = (value: string | null) =>
      value === null ? null : new Date(value);
    return {
      metadata: Object.keys(metadata).length
        ? (metadata as Prisma.InputJsonObject)
        : Prisma.DbNull,
      currentTierId: original.currentTierId,
      tierExpiresAt: date(original.tierExpiresAt),
      lastQualifyingActivityAt: date(original.lastQualifyingActivityAt),
      nextExpiryDate: date(original.nextExpiryDate),
      pointsExpiryPolicyVersion: original.pointsExpiryPolicyVersion,
      pointsExpiryJobsScheduledAt: date(original.pointsExpiryJobsScheduledAt),
    };
  } catch {
    throw new Error("Historical import field rollback requires containment");
  }
}
