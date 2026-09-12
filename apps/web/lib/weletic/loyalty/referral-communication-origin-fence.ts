import type { Prisma } from "@prisma/client";
import { assertShopifyStoreAcceptsOperationalWrites } from "../shopify/store-compliance-state";
import type { LoyaltyMaintenancePermit } from "./maintenance-write-fence";
import {
  readReferralCommunicationOrigin,
  type ReferralCommunicationIdentity,
} from "./referral-communication-origin";

/** An unproven origin is not authority to compensate or clean up a benefit. */
export class ReferralCommunicationOriginBlockedError extends Error {
  constructor(cause: unknown) {
    super("Referral communication origin unavailable", { cause });
    this.name = "ReferralCommunicationOriginBlockedError";
  }
}

/** Caller holds the store/program lock and separately checks program admission,
 * account privacy and the actual benefit receipt. This only fences provenance;
 * a null legacy origin never authorizes a new communication event. */
export async function assertReferralCommunicationOrigin({
  tx,
  metadata,
  identity,
  loyaltyMaintenancePermit,
}: {
  tx: Prisma.TransactionClient;
  metadata: unknown;
  identity: ReferralCommunicationIdentity;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}) {
  try {
    const origin = readReferralCommunicationOrigin({ metadata, identity });
    if (!origin) return null;
    await assertShopifyStoreAcceptsOperationalWrites({
      tx,
      storeId: identity.storeId,
      expectedInstallationGeneration: origin.installationGeneration,
      action: "loyalty_referral_communication_origin",
      loyaltyMaintenancePermit,
    });
    return origin;
  } catch (cause) {
    throw new ReferralCommunicationOriginBlockedError(cause);
  }
}
