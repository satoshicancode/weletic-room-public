import { createHash } from "node:crypto";
import { z } from "zod";
import { loyaltyCommunicationPolicySchema } from "./communications-contract";

const identifier = z.string().min(1).max(191);
const rank = z.number().int().min(0).max(2_147_483_647);
const tier = z
  .object({
    id: identifier,
    rank,
  })
  .strict();
const base = z
  .object({
    version: z.literal(1),
    journey: z.literal("vip_achieved"),
    source: z.literal("vip_threshold_promotion"),
    storeId: identifier,
    programId: identifier,
    accountId: identifier,
    installationGeneration: z.string().min(1).max(64),
    tierHistoryId: identifier,
    sequenceNumber: z.number().int().min(1).max(2_147_483_647),
    fromTier: tier,
    toTier: tier
      .extend({
        name: z
          .string()
          .min(1)
          .max(191)
          .refine(
            (value) =>
              value.trim().length > 0 &&
              !/[\u0000-\u001f\u007f\u2028\u2029]/.test(value),
          ),
      })
      .strict(),
    occurredAt: z.string().datetime(),
    policyRevision: z.string().regex(/^[a-f0-9]{64}$/),
    policy: loyaltyCommunicationPolicySchema.refine(
      (value) => value.journey === "vip_achieved",
    ),
  })
  .strict();
const promotion = (event: {
  fromTier: { id: string; rank: number };
  toTier: { id: string; rank: number };
}) =>
  event.toTier.id !== event.fromTier.id &&
  event.toTier.rank > event.fromTier.rank;
export const vipAchievementCommunicationSchema = base.refine(promotion);
export const vipAchievementCommunicationJobSchema = base
  .extend({
    communicationDeliverySnapshot: z.string().max(1_000_000).optional(),
  })
  .strict()
  .refine(promotion);
export type VipAchievementCommunication = z.infer<
  typeof vipAchievementCommunicationSchema
>;

/** Caller must own the transaction creating this history; this is not authority
 * to announce an existing/imported/manual placement or recover an old event. */
export function createVipAchievementCommunication(input: {
  storeId: string;
  programId: string;
  accountId: string;
  installationGeneration: string;
  history: {
    id: string;
    accountId: string;
    sequenceNumber: number | null;
    fromTierId: string | null;
    toTierId: string;
    changeReason: string;
    effectiveAt: Date;
  };
  fromTier: { id: string; storeId: string; programId: string; rank: number };
  toTier: {
    id: string;
    storeId: string;
    programId: string;
    rank: number;
    name: string;
  };
  policySnapshot: {
    storeId: string;
    programId: string;
    revision: string;
    policy: unknown;
  };
}): VipAchievementCommunication {
  const { history, fromTier, toTier, policySnapshot } = input;
  if (
    history.accountId !== input.accountId ||
    history.changeReason !== "threshold_reached" ||
    history.fromTierId !== fromTier.id ||
    history.toTierId !== toTier.id ||
    [fromTier, toTier, policySnapshot].some(
      (value) =>
        value.storeId !== input.storeId || value.programId !== input.programId,
    )
  )
    throw new Error("VIP achievement evidence unavailable");
  // Merchant names historically allow controls. Normalize only the message
  // label so a valid promotion cannot fail due to a legacy display name.
  const rawName = z
    .string()
    .min(1)
    .max(191)
    .refine((value) => value.trim().length > 0)
    .parse(toTier.name);
  const displayName =
    rawName.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim() || "VIP";
  return vipAchievementCommunicationSchema.parse({
    version: 1,
    journey: "vip_achieved",
    source: "vip_threshold_promotion",
    storeId: input.storeId,
    programId: input.programId,
    accountId: input.accountId,
    installationGeneration: input.installationGeneration,
    tierHistoryId: history.id,
    sequenceNumber: history.sequenceNumber,
    fromTier: { id: fromTier.id, rank: fromTier.rank },
    toTier: { id: toTier.id, rank: toTier.rank, name: displayName },
    occurredAt: history.effectiveAt.toISOString(),
    policyRevision: policySnapshot.revision,
    policy: policySnapshot.policy,
  });
}

export function vipAchievementCommunicationKey(
  event: VipAchievementCommunication,
) {
  const value = vipAchievementCommunicationSchema.parse(event);
  return `vip-achieved:${createHash("sha256")
    .update(
      JSON.stringify([
        value.storeId,
        value.installationGeneration,
        value.accountId,
        value.tierHistoryId,
        value.sequenceNumber,
      ]),
    )
    .digest("hex")}`;
}
