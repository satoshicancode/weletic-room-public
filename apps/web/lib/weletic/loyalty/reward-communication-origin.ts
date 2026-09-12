import { z } from "zod";

const identifier = z.string().min(1).max(191);
const originSchema = z
  .object({
    version: z.literal(1),
    storeId: identifier,
    accountId: identifier,
    redemptionId: identifier,
    installationGeneration: z.string().min(1).max(64),
    provisioningDigest: z.string().regex(/^[A-F0-9]{64}$/),
  })
  .strict();
export type RewardCommunicationOrigin = z.infer<typeof originSchema>;

/** New reservation only, from its store-row-locked operational identity. */
export function createRewardCommunicationOrigin(
  input: Omit<RewardCommunicationOrigin, "version">,
) {
  return originSchema.parse({ version: 1, ...input });
}

/** Missing legacy evidence is not permission to bind it to today's installation.
 * Present-but-invalid evidence fails closed instead of becoming a legacy row. */
export function readRewardCommunicationOrigin({
  metadata,
  storeId,
  accountId,
  redemptionId,
  provisioningDigest,
}: {
  metadata: unknown;
  storeId: string;
  accountId: string;
  redemptionId: string;
  provisioningDigest: string;
}): RewardCommunicationOrigin | null {
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    !Object.prototype.hasOwnProperty.call(metadata, "rewardCommunicationOrigin")
  )
    return null;
  const result = originSchema.safeParse(
    (metadata as Record<string, unknown>).rewardCommunicationOrigin,
  );
  if (
    !result.success ||
    result.data.storeId !== storeId ||
    result.data.accountId !== accountId ||
    result.data.redemptionId !== redemptionId ||
    result.data.provisioningDigest !== provisioningDigest
  )
    throw new Error("Reward communication origin unavailable");
  return result.data;
}
