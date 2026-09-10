import { createHash } from "node:crypto";
import { z } from "zod";
import { birthdayCommunicationJobSchema } from "./birthday-communication-contract";
import { loyaltyCommunicationPolicySchema } from "./communications-contract";

const identifier = z.string().min(1).max(191);
const positivePoints = z
  .string()
  .refine(
    (value) =>
      /^[1-9][0-9]{0,18}$/.test(value) &&
      BigInt(value) <= BigInt("9223372036854775807"),
  );

// Internal event evidence, never a public write contract or recipient payload.
// Purchase notices describe posted available points, not pending order grants.
const purchasePointsCommunicationBaseSchema = z
  .object({
    version: z.literal(1),
    journey: z.literal("points_earned"),
    source: z.literal("purchase_points_available"),
    storeId: identifier,
    programId: identifier,
    accountId: identifier,
    installationGeneration: z.string().min(1).max(64),
    ledgerEntryId: identifier,
    orderId: identifier,
    occurredAt: z.string().datetime(),
    points: positivePoints,
    ledgerPoints: positivePoints,
    policyRevision: z.string().regex(/^[a-f0-9]{64}$/),
    policy: loyaltyCommunicationPolicySchema.refine(
      (policy) => policy.journey === "points_earned",
    ),
  })
  .strict();

const withinPostedPoints = (event: { points: string; ledgerPoints: string }) =>
  /^[1-9][0-9]{0,18}$/.test(event.points) &&
  /^[1-9][0-9]{0,18}$/.test(event.ledgerPoints) &&
  BigInt(event.points) <= BigInt(event.ledgerPoints);
export const purchasePointsCommunicationSchema =
  purchasePointsCommunicationBaseSchema.refine(withinPostedPoints);

export type PurchasePointsCommunication = z.infer<
  typeof purchasePointsCommunicationSchema
>;

export const loyaltyCommunicationJobPayloadSchema =
  purchasePointsCommunicationBaseSchema
    .extend({
      communicationDeliverySnapshot: z.string().max(1_000_000).optional(),
    })
    .strict()
    .refine(withinPostedPoints)
    .or(birthdayCommunicationJobSchema);

/** Construct only in the transaction that posts a new eligible ledger event.
 * Callers must not use historical recovery, backfill or replay as fresh events.
 * This validates evidence ownership; it does not authorize a merchant or send.
 */
export function createPurchasePointsCommunication({
  storeId,
  programId,
  accountId,
  installationGeneration,
  ledger,
  policySnapshot,
  eligiblePoints = ledger.pointsDelta,
}: {
  storeId: string;
  programId: string;
  accountId: string;
  installationGeneration: string;
  ledger: {
    id: string;
    storeId: string;
    accountId: string;
    entryType: string;
    pointsDelta: bigint;
    referenceType: string | null;
    referenceId: string | null;
    createdAt: Date;
  };
  policySnapshot: {
    storeId: string;
    programId: string;
    revision: string;
    policy: unknown;
  };
  eligiblePoints?: bigint;
}): PurchasePointsCommunication {
  if (
    ledger.storeId !== storeId ||
    ledger.accountId !== accountId ||
    ledger.entryType !== "EARN_ORDER" ||
    ledger.referenceType !== "COMMERCE_ORDER" ||
    policySnapshot.storeId !== storeId ||
    policySnapshot.programId !== programId
  )
    throw new Error("Purchase communication evidence unavailable");
  return purchasePointsCommunicationSchema.parse({
    version: 1,
    journey: "points_earned",
    source: "purchase_points_available",
    storeId,
    programId,
    accountId,
    installationGeneration,
    ledgerEntryId: ledger.id,
    orderId: ledger.referenceId,
    occurredAt: ledger.createdAt.toISOString(),
    ledgerPoints: ledger.pointsDelta.toString(),
    points: eligiblePoints.toString(),
    policyRevision: policySnapshot.revision,
    policy: policySnapshot.policy,
  });
}

// A policy edit cannot create a second notice for the same committed event.
// Store + generation prevent reuse after reinstall or across company stores.
export function purchasePointsCommunicationKey(
  event: PurchasePointsCommunication,
) {
  const value = purchasePointsCommunicationSchema.parse(event);
  return `purchase-points:${createHash("sha256")
    .update(
      JSON.stringify([
        value.storeId,
        value.installationGeneration,
        value.accountId,
        value.ledgerEntryId,
      ]),
    )
    .digest("hex")}`;
}
