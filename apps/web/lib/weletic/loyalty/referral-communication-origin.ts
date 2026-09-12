import { createHash } from "node:crypto";
import { z } from "zod";

const identifier = z.string().min(1).max(191);
const positivePoints = z
  .string()
  .refine(
    (value) =>
      /^[1-9][0-9]{0,18}$/.test(value) &&
      BigInt(value) <= BigInt("9223372036854775807"),
  );
const identity = {
  version: z.literal(1),
  storeId: identifier,
  programId: identifier,
  referralId: identifier,
  qualificationOrderId: identifier,
  accountId: identifier,
  side: z.enum(["advocate", "referee"]),
  installationGeneration: z.string().min(1).max(64),
  qualificationPath: z.enum(["account_referral", "preissued_friend_claim"]),
  qualifiedAt: z.string().datetime(),
};

/** Account-backed benefit origins only. Anonymous friend delivery has its own
 * existing claim/recipient boundary; never manufacture an account for it. */
export const referralCommunicationOriginSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        ...identity,
        kind: z.literal("points"),
        points: positivePoints,
      })
      .strict(),
    z
      .object({
        ...identity,
        kind: z.literal("coupon"),
        rewardDefinitionId: identifier,
        rewardSnapshotDigest: z.string().regex(/^[A-F0-9]{64}$/),
      })
      .strict(),
  ])
  .refine(
    (origin) =>
      origin.qualificationPath !== "preissued_friend_claim" ||
      origin.side === "advocate",
    "A preissued friend claim qualifies only the account-backed advocate benefit.",
  );

export type ReferralCommunicationOrigin = z.infer<
  typeof referralCommunicationOriginSchema
>;
type WithoutVersion<T> = T extends unknown ? Omit<T, "version"> : never;
export type ReferralCommunicationIdentity = Pick<
  ReferralCommunicationOrigin,
  | "storeId"
  | "programId"
  | "referralId"
  | "qualificationOrderId"
  | "accountId"
  | "side"
>;

/** Call only while claiming a genuinely new qualification under its store lock,
 * before coupon dispatch. This parser is not operational write authorization. */
export function createReferralCommunicationOrigin(
  input: WithoutVersion<ReferralCommunicationOrigin>,
): ReferralCommunicationOrigin {
  return referralCommunicationOriginSchema.parse({ version: 1, ...input });
}

/** Read original provenance, never fill missing legacy evidence from current
 * credentials. The caller must fence the returned generation before mutation. */
export function readReferralCommunicationOrigin({
  metadata,
  identity: expected,
}: {
  metadata: unknown;
  identity: ReferralCommunicationIdentity;
}): ReferralCommunicationOrigin | null {
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    !Object.prototype.hasOwnProperty.call(
      metadata,
      "referralCommunicationOrigins",
    )
  )
    return null;
  const origins = (metadata as Record<string, unknown>)
    .referralCommunicationOrigins;
  if (
    !origins ||
    typeof origins !== "object" ||
    Array.isArray(origins) ||
    Object.keys(origins).some((key) => key !== "advocate" && key !== "referee")
  )
    throw new Error("Referral communication origin unavailable");
  if (!Object.prototype.hasOwnProperty.call(origins, expected.side))
    return null;
  const parsed = referralCommunicationOriginSchema.safeParse(
    (origins as Record<string, unknown>)[expected.side],
  );
  if (
    !parsed.success ||
    parsed.data.storeId !== expected.storeId ||
    parsed.data.programId !== expected.programId ||
    parsed.data.referralId !== expected.referralId ||
    parsed.data.qualificationOrderId !== expected.qualificationOrderId ||
    parsed.data.accountId !== expected.accountId ||
    parsed.data.side !== expected.side
  )
    throw new Error("Referral communication origin unavailable");
  return parsed.data;
}

/** Receipt ID is the winning ledger entry or issued coupon redemption, not the
 * whole-referral completion timestamp. Content edits never create a second key. */
export function referralBenefitCommunicationKey(
  input: ReferralCommunicationOrigin,
  receiptId: string,
) {
  const origin = referralCommunicationOriginSchema.parse(input);
  const receipt = identifier.parse(receiptId);
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        origin.version,
        origin.storeId,
        origin.programId,
        origin.referralId,
        origin.qualificationOrderId,
        origin.installationGeneration,
        origin.accountId,
        origin.side,
        origin.kind,
        receipt,
      ]),
    )
    .digest("hex");
  return `loyalty_communication:referral_benefit:${digest}`;
}
