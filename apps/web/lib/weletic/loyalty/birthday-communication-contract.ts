import type { WeleticPointsLedgerEntry } from "@prisma/client";
import { createHash } from "node:crypto";
import { z } from "zod";
import { loyaltyCommunicationPolicySchema } from "./communications-contract";

const identifier = z.string().min(1).max(191);
const points = z
  .string()
  .refine(
    (value) =>
      /^[1-9][0-9]{0,18}$/.test(value) &&
      BigInt(value) <= BigInt("9223372036854775807"),
  );

// Internal evidence of an existing annual award, not a birthday scheduler,
// customer profile, authorization contract or announcement of a future reward.
const base = z
  .object({
    version: z.literal(1),
    journey: z.literal("birthday"),
    source: z.literal("birthday_points_available"),
    storeId: identifier,
    programId: identifier,
    accountId: identifier,
    installationGeneration: z.string().min(1).max(64),
    ledgerEntryId: identifier,
    calendarYear: z.number().int().min(1).max(9999),
    occurredAt: z.string().datetime(),
    points,
    ledgerPoints: points,
    policyRevision: z.string().regex(/^[a-f0-9]{64}$/),
    policy: loyaltyCommunicationPolicySchema.refine(
      (value) => value.journey === "birthday",
    ),
  })
  .strict();

const exactPoints = (event: { points: string; ledgerPoints: string }) =>
  event.points === event.ledgerPoints;
export const birthdayCommunicationSchema = base.refine(exactPoints);
export const birthdayCommunicationJobSchema = base
  .extend({
    communicationDeliverySnapshot: z.string().max(1_000_000).optional(),
  })
  .strict()
  .refine(exactPoints);
export type BirthdayCommunication = z.infer<typeof birthdayCommunicationSchema>;

export function createBirthdayCommunication({
  storeId,
  programId,
  accountId,
  installationGeneration,
  calendarYear,
  ledger,
  policySnapshot,
}: {
  storeId: string;
  programId: string;
  accountId: string;
  installationGeneration: string;
  calendarYear: number;
  ledger: Pick<
    WeleticPointsLedgerEntry,
    | "id"
    | "storeId"
    | "accountId"
    | "entryType"
    | "referenceType"
    | "referenceId"
    | "idempotencyKey"
    | "grantId"
    | "pointsDelta"
    | "createdAt"
  >;
  policySnapshot: {
    storeId: string;
    programId: string;
    revision: string;
    policy: unknown;
  };
}): BirthdayCommunication {
  if (
    ledger.storeId !== storeId ||
    ledger.accountId !== accountId ||
    ledger.entryType !== "EARN_BONUS" ||
    ledger.referenceType !== "BIRTHDAY_REWARD" ||
    ledger.referenceId !== String(calendarYear) ||
    ledger.grantId ||
    ledger.idempotencyKey !== `birthday:${accountId}:${calendarYear}` ||
    policySnapshot.storeId !== storeId ||
    policySnapshot.programId !== programId
  )
    throw new Error("Birthday communication evidence unavailable");
  return birthdayCommunicationSchema.parse({
    version: 1,
    journey: "birthday",
    source: "birthday_points_available",
    storeId,
    programId,
    accountId,
    installationGeneration,
    calendarYear,
    ledgerEntryId: ledger.id,
    occurredAt: ledger.createdAt.toISOString(),
    points: ledger.pointsDelta.toString(),
    ledgerPoints: ledger.pointsDelta.toString(),
    policyRevision: policySnapshot.revision,
    policy: policySnapshot.policy,
  });
}

export function birthdayCommunicationKey(event: BirthdayCommunication) {
  const value = birthdayCommunicationSchema.parse(event);
  return `birthday-points:${createHash("sha256")
    .update(
      JSON.stringify([
        value.storeId,
        value.installationGeneration,
        value.accountId,
        value.calendarYear,
        value.ledgerEntryId,
      ]),
    )
    .digest("hex")}`;
}
