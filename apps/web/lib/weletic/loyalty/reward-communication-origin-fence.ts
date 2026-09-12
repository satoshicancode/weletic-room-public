import type { Prisma } from "@prisma/client";
import { assertShopifyStoreAcceptsOperationalWrites } from "../shopify/store-compliance-state";
import type { LoyaltyMaintenancePermit } from "./maintenance-write-fence";
import { readLoyaltyRedemptionProvisioningSnapshot } from "./redemption-provisioning-snapshot";
import { readRewardCommunicationOrigin } from "./reward-communication-origin";

/** Caller holds the program/store lock. Never invent origin for legacy rows.
 * For new rows this comparison must precede remote markers/dispatch/adoption. */
export class RewardCommunicationOriginBlockedError extends Error {
  constructor(cause: unknown) {
    super(
      cause instanceof Error
        ? cause.message
        : "Reward communication origin unavailable",
      { cause },
    );
    this.name = "RewardCommunicationOriginBlockedError";
  }
}

export async function assertRewardCommunicationOrigin(
  input: Parameters<typeof readAndFenceOrigin>[0],
) {
  try {
    return await readAndFenceOrigin(input);
  } catch (cause) {
    // An unproven origin is never authority to compensate or clean up a row.
    throw new RewardCommunicationOriginBlockedError(cause);
  }
}

async function readAndFenceOrigin({
  tx,
  storeId,
  accountId,
  redemptionId,
  metadata,
  loyaltyMaintenancePermit,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  accountId: string;
  redemptionId: string;
  metadata: unknown;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}) {
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    !Object.prototype.hasOwnProperty.call(metadata, "rewardCommunicationOrigin")
  )
    return null;
  const snapshot = readLoyaltyRedemptionProvisioningSnapshot(metadata);
  if (!snapshot) throw new Error("Reward communication origin unavailable");
  const origin = readRewardCommunicationOrigin({
    metadata,
    storeId,
    accountId,
    redemptionId,
    provisioningDigest: snapshot.contentDigest,
  });
  if (!origin) throw new Error("Reward communication origin unavailable");
  await assertShopifyStoreAcceptsOperationalWrites({
    tx,
    storeId,
    expectedInstallationGeneration: origin.installationGeneration,
    action: "loyalty_reward_communication_origin",
    loyaltyMaintenancePermit,
  });
  return origin;
}
