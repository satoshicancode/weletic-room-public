import { getEmailDomainBlockFlags } from "@/lib/email/get-email-domain-block-flags";
import { prisma } from "@/lib/prisma";
import { createWeleticId } from "@/lib/weletic/ids";
import { enqueueFlowTriggerJob } from "@/lib/weletic/loyalty/flow-trigger-outbox";
import { appendPointsLedgerEntry } from "@/lib/weletic/loyalty/ledger";
import type { LoyaltyMaintenancePermit } from "@/lib/weletic/loyalty/maintenance-write-fence";
import { enqueueOutboxJob } from "@/lib/weletic/loyalty/outbox";
import { lockLoyaltyProgramRow } from "@/lib/weletic/loyalty/program-write-fence";
import { canonicalizeLoyaltyDiscountCode } from "@/lib/weletic/loyalty/redemption-discount-identity";
import { getReferralCouponIdempotencyKey } from "@/lib/weletic/loyalty/referral-coupon";
import { createReferralCouponRewardSnapshot } from "@/lib/weletic/loyalty/referral-coupon-snapshot";
import { createReferralPrivacySnapshot } from "@/lib/weletic/loyalty/referral-privacy-snapshot";
import {
  getAbuseSignalLookupDigests,
  getReferralEmailSimilarityKey,
  hashAbuseSignal,
  isKnownDisposableReferralEmail,
  runSerializableReferralTransaction,
} from "@/lib/weletic/loyalty/referrals";
import { isReferralCouponProvisionable } from "@/lib/weletic/loyalty/rewards";
import {
  deactivateDiscount,
  lookupDiscountByCode,
  matchesLoyaltyRewardDiscountConfiguration,
  provisionLoyaltyRewardDiscount,
  resolveShopifyOfflineCredentials,
  type ProvisionLoyaltyRewardDiscountParams,
} from "@/lib/weletic/loyalty/shopify-discounts";
import { scheduleTierReviewAfterQualifyingActivity } from "@/lib/weletic/loyalty/tier-review-scheduling";
import { readShopperCommunicationSettings } from "@/lib/weletic/merchant-settings/communications";
import { decimalToMinorUnits } from "@/lib/weletic/money";
import {
  canonicalizeShopifyCustomerEmail,
  createAllShopifyDerivedPrivacyDigests,
  createShopifyDerivedPrivacyDigest,
  hasShopifyCustomerPrivacyTombstone,
} from "@/lib/weletic/shopify/privacy-identity";
import { assertShopifyStoreAcceptsOperationalWrites } from "@/lib/weletic/shopify/store-compliance-state";
import { getWeleticTransactionalEmailOptions } from "@/lib/weletic/transactional-email";
import { sendBatchEmail } from "@dub/email";
import ReferralFriendReward from "@dub/email/templates/referral-friend-reward";
import {
  Prisma,
  WeleticLoyaltyReferralStatus,
  WeleticPointsLedgerEntryType,
  WeleticRewardExchangeType,
  WeleticRewardStatus,
} from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  DEFAULT_REFERRAL_PURCHASE_POLICY,
  DEFAULT_REWARD_PURCHASE_POLICY,
  getEligibleLoyaltyOrderSubtotal,
  loyaltyPurchasePolicySchema,
  readLoyaltyPurchasePolicy,
} from "./purchase-policy";

const CLAIM_METADATA_KEY = "friendRewardSnapshot";
const LEGACY_FRIEND_REWARD_CLEANUP_PENDING_REASON =
  "Legacy friend reward remote cleanup is pending.";
const LEGACY_FRIEND_REWARD_CLEANUP_COMPLETE_REASON =
  "Legacy friend reward was cancelled before online-store delivery.";
const provisionableRewardTypeSchema = z.enum([
  "amount_off",
  "percentage_off",
  "free_shipping",
  "free_product",
]);
const rewardSalesChannelSchema = z.enum(["online_store", "pos", "both"]);

const nullableDecimalStringSchema = z
  .string()
  .regex(/^-?\d+(?:\.\d+)?$/)
  .nullable();

const friendRewardSnapshotSchema = z
  .object({
    rewardDefinition: z
      .object({
        id: z.string().min(1),
        name: z.string().min(1),
        rewardType: provisionableRewardTypeSchema,
        salesChannel: rewardSalesChannelSchema.optional(),
        purchasePolicy: loyaltyPurchasePolicySchema.optional(),
        discountValue: nullableDecimalStringSchema,
        maxDiscountValue: nullableDecimalStringSchema,
        minOrderAmount: nullableDecimalStringSchema,
        appliesToResource: z.string().nullable(),
        entitledProductIds: z.array(z.string()),
        entitledVariantIds: z.array(z.string()),
        entitledCollectionIds: z.array(z.string()),
        combinesWithOrderDiscounts: z.boolean(),
        combinesWithProductDiscounts: z.boolean(),
        combinesWithShippingDiscounts: z.boolean(),
        usageLimit: z.literal(1),
        usageLimitPerCustomer: z.literal(1),
        expiresInDays: z.number().int().nonnegative().nullable(),
      })
      .strict(),
    startsAt: z.string().datetime(),
    expiresAt: z.string().datetime().nullable(),
    shopCurrency: z.string().regex(/^[A-Z]{3}$/),
    currencyVerifiedAt: z.string().datetime(),
  })
  .strict();

type FriendRewardSnapshot = z.infer<typeof friendRewardSnapshotSchema> & {
  rewardDefinition: ProvisionLoyaltyRewardDiscountParams["rewardDefinition"];
};

function friendDiscountCode(referralId: string) {
  const fingerprint = createHash("sha256")
    .update(`weletic:referral-friend:v1:${referralId}`)
    .digest("hex")
    .slice(0, 20)
    .toUpperCase();
  return `WLF-${fingerprint}`;
}

function rewardSnapshotFromDefinition({
  reward,
  shopCurrency,
  currencyVerifiedAt,
  now,
}: {
  reward: {
    id: string;
    name: string;
    rewardType: string;
    salesChannel?: unknown;
    purchasePolicy?: Prisma.JsonValue;
    discountValue: Prisma.Decimal | null;
    maxDiscountValue: Prisma.Decimal | null;
    minOrderAmount: Prisma.Decimal | null;
    appliesToResource: string | null;
    entitledProductIds: Prisma.JsonValue;
    entitledVariantIds: Prisma.JsonValue;
    entitledCollectionIds: Prisma.JsonValue;
    combinesWithOrderDiscounts: boolean;
    combinesWithProductDiscounts: boolean;
    combinesWithShippingDiscounts: boolean;
    expiresInDays: number | null;
  };
  shopCurrency: string;
  currencyVerifiedAt: Date;
  now: Date;
}): FriendRewardSnapshot {
  const stringArray = (value: Prisma.JsonValue) =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  const expiresAt = reward.expiresInDays
    ? new Date(now.getTime() + reward.expiresInDays * 86_400_000)
    : null;
  const salesChannel =
    reward.salesChannel === undefined
      ? undefined
      : rewardSalesChannelSchema.parse(reward.salesChannel);
  return {
    rewardDefinition: {
      id: reward.id,
      name: reward.name,
      rewardType: provisionableRewardTypeSchema.parse(reward.rewardType),
      ...(salesChannel ? { salesChannel } : {}),
      purchasePolicy: readLoyaltyPurchasePolicy(
        reward.purchasePolicy,
        DEFAULT_REWARD_PURCHASE_POLICY,
      ),
      discountValue: reward.discountValue?.toString() ?? null,
      maxDiscountValue: reward.maxDiscountValue?.toString() ?? null,
      minOrderAmount: reward.minOrderAmount?.toString() ?? null,
      appliesToResource: reward.appliesToResource,
      entitledProductIds: stringArray(reward.entitledProductIds),
      entitledVariantIds: stringArray(reward.entitledVariantIds),
      entitledCollectionIds: stringArray(reward.entitledCollectionIds),
      combinesWithOrderDiscounts: reward.combinesWithOrderDiscounts,
      combinesWithProductDiscounts: reward.combinesWithProductDiscounts,
      combinesWithShippingDiscounts: reward.combinesWithShippingDiscounts,
      // Smile's friend reward is a unique, single-use code even when the
      // merchant's reusable catalog reward has broader usage defaults.
      usageLimit: 1,
      usageLimitPerCustomer: 1,
      expiresInDays: reward.expiresInDays,
    },
    startsAt: now.toISOString(),
    expiresAt: expiresAt?.toISOString() ?? null,
    shopCurrency: shopCurrency.trim().toUpperCase(),
    currencyVerifiedAt: currencyVerifiedAt.toISOString(),
  };
}

function readFriendRewardSnapshot(metadata: Prisma.JsonValue) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const value = (metadata as Record<string, unknown>)[CLAIM_METADATA_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const parsed = friendRewardSnapshotSchema.safeParse(value);
  return parsed.success ? (parsed.data as FriendRewardSnapshot) : null;
}

function isSameCanonicalEmail(left: string | null, right: string) {
  if (!left) return false;
  try {
    return canonicalizeShopifyCustomerEmail(left) === right;
  } catch {
    return false;
  }
}

function isPrismaUniqueConstraintError(error: unknown) {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  ) {
    return true;
  }
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "P2002",
  );
}

function referralApplyUrl(shopDomain: string, discountCode: string) {
  return `https://${shopDomain}/discount/${encodeURIComponent(discountCode)}?redirect=%2F`;
}

async function deactivateAndFinalizeUnprovisionableFriendReward({
  storeId,
  referralId,
  friendEmailDigests,
  discountCode,
  remoteDiscountId,
  shopDomain,
  accessToken,
  loyaltyMaintenancePermit,
}: {
  storeId: string;
  referralId: string;
  friendEmailDigests: string[];
  discountCode: string;
  remoteDiscountId: string;
  shopDomain: string;
  accessToken: string;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}) {
  // The prior transaction persisted a terminal status and the verified remote
  // identity. Shopify I/O stays outside the DB transaction; a crash here is
  // resumable from the cancelled row, and the voucher can never be delivered.
  const deactivated = await deactivateDiscount(
    shopDomain,
    accessToken,
    remoteDiscountId,
  );
  if (!deactivated) {
    throw new Error("Legacy friend reward voucher could not be deactivated.");
  }

  return runSerializableReferralTransaction(async (tx) => {
    await lockLoyaltyProgramRow({
      tx,
      storeId,
      mode: "lock_only",
      loyaltyMaintenancePermit,
    });
    const scrubbed = await tx.weleticLoyaltyReferral.updateMany({
      where: {
        id: referralId,
        storeId,
        status: WeleticLoyaltyReferralStatus.cancelled,
        fraudReason: LEGACY_FRIEND_REWARD_CLEANUP_PENDING_REASON,
        friendEmailDigest: { in: friendEmailDigests },
        friendShopifyDiscountCode: discountCode,
        friendShopifyDiscountId: remoteDiscountId,
        friendRewardProvisionedAt: null,
      },
      data: {
        friendEmailDigest: null,
        friendShopifyDiscountCode: null,
        friendShopifyDiscountCodeCanonical: null,
        friendShopifyDiscountId: null,
        friendRewardDefinitionId: null,
        friendRewardExpiresAt: null,
        fraudReason: LEGACY_FRIEND_REWARD_CLEANUP_COMPLETE_REASON,
      },
    });
    if (scrubbed.count === 1) return true;

    const current = await tx.weleticLoyaltyReferral.findFirst({
      where: { id: referralId, storeId },
      select: {
        status: true,
        fraudReason: true,
        friendEmailDigest: true,
        friendShopifyDiscountCode: true,
        friendShopifyDiscountId: true,
      },
    });
    if (
      current?.status === WeleticLoyaltyReferralStatus.cancelled &&
      current.fraudReason === LEGACY_FRIEND_REWARD_CLEANUP_COMPLETE_REASON &&
      current.friendEmailDigest === null &&
      current.friendShopifyDiscountCode === null &&
      current.friendShopifyDiscountId === null
    ) {
      return true;
    }
    throw new Error(
      "Legacy friend reward reservation changed during remote cleanup.",
    );
  });
}

async function reconcileUnprovisionableFriendRewardReservation({
  storeId,
  referralId,
  friendEmailDigests,
  discountCode,
  snapshot,
  loyaltyMaintenancePermit,
}: {
  storeId: string;
  referralId: string;
  friendEmailDigests: string[];
  discountCode: string;
  snapshot: FriendRewardSnapshot;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}) {
  const credentials = await resolveShopifyOfflineCredentials({ storeId });
  const remote = await lookupDiscountByCode(
    credentials.shopDomain,
    credentials.accessToken,
    discountCode,
  );
  if (!remote) {
    throw new Error(
      "Friend reward snapshot is not authorized for online-store provisioning.",
    );
  }
  if (
    !matchesLoyaltyRewardDiscountConfiguration({
      remote,
      rewardDefinition: snapshot.rewardDefinition,
      startsAt: new Date(snapshot.startsAt),
      expiresAt: snapshot.expiresAt ? new Date(snapshot.expiresAt) : null,
      expectedShopCurrency: snapshot.shopCurrency,
      shopifyCustomerId: null,
    })
  ) {
    throw new Error(
      "Legacy friend reward voucher does not match its immutable reservation; manual reconciliation is required.",
    );
  }

  const cleanupFenced = await runSerializableReferralTransaction(async (tx) => {
    await lockLoyaltyProgramRow({
      tx,
      storeId,
      mode: "lock_only",
      loyaltyMaintenancePermit,
    });
    const fenced = await tx.weleticLoyaltyReferral.updateMany({
      where: {
        id: referralId,
        storeId,
        status: WeleticLoyaltyReferralStatus.pending,
        friendEmailDigest: { in: friendEmailDigests },
        friendShopifyDiscountCode: discountCode,
        friendRewardProvisionedAt: null,
      },
      data: {
        status: WeleticLoyaltyReferralStatus.cancelled,
        friendShopifyDiscountId: remote.id,
        fraudReason: LEGACY_FRIEND_REWARD_CLEANUP_PENDING_REASON,
      },
    });
    if (fenced.count === 1) return true;

    const concurrent = await tx.weleticLoyaltyReferral.findFirst({
      where: { id: referralId, storeId },
      select: {
        status: true,
        fraudReason: true,
        friendEmailDigest: true,
        friendShopifyDiscountCode: true,
        friendShopifyDiscountId: true,
        friendRewardProvisionedAt: true,
      },
    });
    return Boolean(
      concurrent?.status === WeleticLoyaltyReferralStatus.cancelled &&
        concurrent.fraudReason ===
          LEGACY_FRIEND_REWARD_CLEANUP_PENDING_REASON &&
        concurrent.friendEmailDigest !== null &&
        friendEmailDigests.includes(concurrent.friendEmailDigest) &&
        concurrent.friendShopifyDiscountCode === discountCode &&
        concurrent.friendShopifyDiscountId === remote.id &&
        concurrent.friendRewardProvisionedAt === null,
    );
  });
  if (!cleanupFenced) return false;

  return deactivateAndFinalizeUnprovisionableFriendReward({
    storeId,
    referralId,
    friendEmailDigests,
    discountCode,
    remoteDiscountId: remote.id,
    shopDomain: credentials.shopDomain,
    accessToken: credentials.accessToken,
    loyaltyMaintenancePermit,
  });
}

async function shopifyHasCustomerEmail({
  storeId,
  email,
}: {
  storeId: string;
  email: string;
}) {
  const credentials = await resolveShopifyOfflineCredentials({ storeId });
  const escapedEmail = email.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const response = await import("@/lib/weletic/loyalty/shopify-discounts").then(
    ({ shopifyAdminGraphqlRequest }) =>
      shopifyAdminGraphqlRequest<{
        customers?: {
          nodes?: Array<{
            id: string;
            email?: string | null;
            numberOfOrders?: string | number | null;
          }>;
        };
      }>({
        shopDomain: credentials.shopDomain,
        accessToken: credentials.accessToken,
        query: `query ReferralFriendCustomerLookup($query: String!) {
          customers(first: 10, query: $query) {
            nodes { id email numberOfOrders }
          }
        }`,
        variables: { query: `email:\"${escapedEmail}\"` },
      }),
  );
  return Boolean(
    response.customers?.nodes?.some((customer) => {
      try {
        return (
          customer.email &&
          canonicalizeShopifyCustomerEmail(customer.email) === email
        );
      } catch {
        return false;
      }
    }),
  );
}

const FRIEND_EMAIL_LEASE_TTL_MS = 60_000;
const FRIEND_EMAIL_DELIVERY_FAILURE = "Referral email delivery failed";

async function deliverFriendRewardEmail({
  referralId,
  email,
  brandName,
  logoUrl,
  accentColor,
  advocateName,
  rewardName,
  discountCode,
  applyUrl,
  expiresAt,
}: {
  referralId: string;
  email: string;
  brandName: string;
  logoUrl?: string | null;
  accentColor?: string | null;
  advocateName: string | null;
  rewardName: string;
  discountCode: string;
  applyUrl: string;
  expiresAt: Date | null;
}): Promise<{ success: boolean; error?: string }> {
  let formattedExpiry: string | null = null;
  if (expiresAt) {
    formattedExpiry = new Intl.DateTimeFormat("en", {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    }).format(expiresAt);
  }
  try {
    const delivery = await sendBatchEmail(
      [
        {
          ...getWeleticTransactionalEmailOptions(),
          to: email,
          subject: `${advocateName || "A friend"} sent you ${rewardName}`,
          variant: "notifications",
          react: ReferralFriendReward({
            brandName,
            logoUrl,
            accentColor,
            advocateName,
            rewardName,
            discountCode,
            applyUrl,
            expiresAt: formattedExpiry,
          }),
        },
      ],
      { idempotencyKey: `loyalty-referral-friend-${referralId}` },
    );
    if (delivery?.error) {
      return {
        success: false,
        error: FRIEND_EMAIL_DELIVERY_FAILURE,
      };
    }
    return {
      success: Boolean(delivery?.data),
      error: delivery?.data ? undefined : FRIEND_EMAIL_DELIVERY_FAILURE,
    };
  } catch {
    // Provider errors can contain recipients, voucher URLs and credentials.
    // Retain only a fixed failure category, never the raw error or its cause.
    return {
      success: false,
      error: FRIEND_EMAIL_DELIVERY_FAILURE,
    };
  }
}

export async function deliverReferralEmailUnderLease({
  referralId,
  storeId,
  now = new Date(),
  deliver,
}: {
  referralId: string;
  storeId: string;
  now?: Date;
  deliver: () => Promise<{ success: boolean; error?: string }>;
}) {
  const leaseToken = randomUUID();
  const communications = await readShopperCommunicationSettings({ storeId });
  if (communications.paused) return { acquired: false, emailSent: false };
  const leaseExpiresAt = new Date(now.getTime() + FRIEND_EMAIL_LEASE_TTL_MS);
  const updatedAt = new Date();
  // Prisma's MySQL updateMany implementation selects matching IDs before it
  // updates them. Keep the lease predicate in one SQL UPDATE so concurrent
  // workers cannot all select the same expired lease and then overwrite it.
  let claimed: number;
  if (typeof (prisma as { $executeRaw?: unknown }).$executeRaw !== "function") {
    if (process.env.NODE_ENV !== "test") {
      throw new Error("Atomic referral email lease SQL is unavailable.");
    }
    const fallback = await prisma.weleticLoyaltyReferral.updateMany({
      where: {
        id: referralId,
        storeId,
        friendRewardEmailedAt: null,
        friendEmailLeaseExpiresAt: { lte: now },
      },
      data: {
        friendEmailLeaseToken: leaseToken,
        friendEmailLeaseReservedAt: now,
        friendEmailLeaseExpiresAt: leaseExpiresAt,
        friendEmailDeliveryAttempts: { increment: 1 },
        friendEmailLastError: null,
      },
    });
    claimed = fallback.count;
  } else {
    claimed = await prisma.$executeRaw`
      UPDATE \`WeleticLoyaltyReferral\`
      SET
        \`friendEmailLeaseToken\` = ${leaseToken},
        \`friendEmailLeaseReservedAt\` = ${now},
        \`friendEmailLeaseExpiresAt\` = ${leaseExpiresAt},
        \`friendEmailDeliveryAttempts\` = \`friendEmailDeliveryAttempts\` + 1,
        \`friendEmailLastError\` = NULL,
        \`updatedAt\` = ${updatedAt}
      WHERE
        \`id\` = ${referralId}
        AND \`storeId\` = ${storeId}
        AND \`friendRewardEmailedAt\` IS NULL
        AND \`friendEmailLeaseExpiresAt\` <= ${now}
        AND NOT EXISTS (
          SELECT 1 FROM \`WeleticMerchantSettings\`
          WHERE \`storeId\` = ${storeId} AND \`shopperEmailPaused\` = TRUE
        )
    `;
  }
  if (claimed === 0) {
    const current = await prisma.weleticLoyaltyReferral.findUnique({
      where: { id: referralId },
      select: { friendRewardEmailedAt: true },
    });
    return {
      acquired: false,
      emailSent: Boolean(current?.friendRewardEmailedAt),
    };
  }

  let delivery: { success: boolean; error?: string };
  try {
    delivery = await deliver();
  } catch {
    delivery = {
      success: false,
      error: FRIEND_EMAIL_DELIVERY_FAILURE,
    };
  }

  if (delivery.success) {
    const deliveredAt = new Date();
    let finalized: number;
    if (
      typeof (prisma as { $executeRaw?: unknown }).$executeRaw !== "function"
    ) {
      if (process.env.NODE_ENV !== "test") {
        throw new Error("Atomic referral email lease SQL is unavailable.");
      }
      const fallback = await prisma.weleticLoyaltyReferral.updateMany({
        where: {
          id: referralId,
          storeId,
          friendRewardEmailedAt: null,
          friendEmailLeaseToken: leaseToken,
        },
        data: {
          friendRewardEmailedAt: deliveredAt,
          friendEmailLeaseToken: null,
          friendEmailLeaseReservedAt: null,
          friendEmailLeaseExpiresAt: deliveredAt,
          friendEmailLastError: null,
        },
      });
      finalized = fallback.count;
    } else {
      finalized = await prisma.$executeRaw`
        UPDATE \`WeleticLoyaltyReferral\`
        SET
          \`friendRewardEmailedAt\` = ${deliveredAt},
          \`friendEmailLeaseToken\` = NULL,
          \`friendEmailLeaseReservedAt\` = NULL,
          \`friendEmailLeaseExpiresAt\` = ${deliveredAt},
          \`friendEmailLastError\` = NULL,
          \`updatedAt\` = ${deliveredAt}
        WHERE
          \`id\` = ${referralId}
          AND \`storeId\` = ${storeId}
          AND \`friendRewardEmailedAt\` IS NULL
          AND \`friendEmailLeaseToken\` = ${leaseToken}
      `;
    }
    return { acquired: true, emailSent: finalized === 1 };
  } else {
    // This boundary also protects against alternate delivery callbacks that
    // return an unsanitized error instead of throwing one.
    const error = FRIEND_EMAIL_DELIVERY_FAILURE;
    if (
      typeof (prisma as { $executeRaw?: unknown }).$executeRaw !== "function"
    ) {
      if (process.env.NODE_ENV !== "test") {
        throw new Error("Atomic referral email lease SQL is unavailable.");
      }
      await prisma.weleticLoyaltyReferral.updateMany({
        where: {
          id: referralId,
          storeId,
          friendRewardEmailedAt: null,
          friendEmailLeaseToken: leaseToken,
        },
        data: {
          friendEmailLeaseToken: null,
          friendEmailLeaseReservedAt: null,
          friendEmailLeaseExpiresAt: now,
          friendEmailLastError: error,
        },
      });
    } else {
      await prisma.$executeRaw`
        UPDATE \`WeleticLoyaltyReferral\`
        SET
          \`friendEmailLeaseToken\` = NULL,
          \`friendEmailLeaseReservedAt\` = NULL,
          \`friendEmailLeaseExpiresAt\` = ${now},
          \`friendEmailLastError\` = ${error},
          \`updatedAt\` = ${new Date()}
        WHERE
          \`id\` = ${referralId}
          AND \`storeId\` = ${storeId}
          AND \`friendRewardEmailedAt\` IS NULL
          AND \`friendEmailLeaseToken\` = ${leaseToken}
      `;
    }
    return { acquired: true, emailSent: false };
  }
}

export async function claimReferralFriendReward({
  storeId,
  referralCode,
  friendEmail,
  clientIp,
  userAgent,
  now = new Date(),
  loyaltyMaintenancePermit,
}: {
  storeId: string;
  referralCode: string;
  friendEmail: string;
  clientIp?: string;
  userAgent?: string;
  now?: Date;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}) {
  const normalizedCode = referralCode.trim().toUpperCase();
  const email = canonicalizeShopifyCustomerEmail(friendEmail);
  const storeIdentity = await prisma.weleticShopifyStore.findUniqueOrThrow({
    where: { id: storeId },
    select: { shopDomain: true },
  });
  const referralInvitation = await prisma.weleticLoyaltyAccount.findFirst({
    where: { storeId, referralCode: normalizedCode, status: "active" },
    select: { id: true },
  });
  if (!referralInvitation) {
    throw new Error("This referral invitation is invalid or has expired.");
  }
  const emailDigests = createAllShopifyDerivedPrivacyDigests({
    purpose: "referral_email",
    values: [storeId, email],
  });
  const currentEmailDigest = createShopifyDerivedPrivacyDigest({
    purpose: "referral_email",
    values: [storeId, email],
  });

  // Cleanup is compensating work, not a new loyalty mutation. Resume it even
  // after the program is paused or disabled; the persisted cancelled marker
  // proves that this exact remote identity must never be delivered.
  const pendingRemoteCleanup = await prisma.weleticLoyaltyReferral.findFirst({
    where: {
      storeId,
      advocateAccountId: referralInvitation.id,
      status: WeleticLoyaltyReferralStatus.cancelled,
      fraudReason: LEGACY_FRIEND_REWARD_CLEANUP_PENDING_REASON,
      friendEmailDigest: { in: emailDigests },
      friendShopifyDiscountCode: { not: null },
      friendShopifyDiscountId: { not: null },
      friendRewardProvisionedAt: null,
    },
  });
  if (
    pendingRemoteCleanup?.friendEmailDigest &&
    emailDigests.includes(pendingRemoteCleanup.friendEmailDigest) &&
    pendingRemoteCleanup.friendShopifyDiscountCode &&
    pendingRemoteCleanup.friendShopifyDiscountId
  ) {
    const credentials = await resolveShopifyOfflineCredentials({ storeId });
    await deactivateAndFinalizeUnprovisionableFriendReward({
      storeId,
      referralId: pendingRemoteCleanup.id,
      friendEmailDigests: emailDigests,
      discountCode: pendingRemoteCleanup.friendShopifyDiscountCode,
      remoteDiscountId: pendingRemoteCleanup.friendShopifyDiscountId,
      shopDomain: credentials.shopDomain,
      accessToken: credentials.accessToken,
      loyaltyMaintenancePermit,
    });
    return { status: "review" as const };
  }

  await assertShopifyStoreAcceptsOperationalWrites({
    storeId,
    action: "referral_friend_claim_precheck",
    loyaltyMaintenancePermit,
  });
  const ipHash = hashAbuseSignal({
    storeId,
    kind: "ip",
    signal: clientIp,
  });
  const ipDigests = getAbuseSignalLookupDigests({
    storeId,
    kind: "ip",
    signal: clientIp,
  });
  const userAgentHash = hashAbuseSignal({
    storeId,
    kind: "user_agent",
    signal: userAgent,
  });

  const [
    localCustomer,
    remoteCustomerExists,
    emailDomainFlags,
    privacyTombstoned,
  ] = await Promise.all([
    prisma.weleticShopper.findFirst({
      where: { storeId, email },
      select: { id: true, ordersCount: true },
    }),
    shopifyHasCustomerEmail({ storeId, email }),
    getEmailDomainBlockFlags(email).catch(() => ({
      isDisposable: false,
      matchesBlockedTerms: false,
      reputationUnavailable: true,
    })),
    hasShopifyCustomerPrivacyTombstone({ storeId, email }),
  ]);

  // Never recreate even a derived lookup identity after Shopify customer
  // erasure. The public boundary converts this into the same generic
  // eligibility response used for every rejected claim.
  if (privacyTombstoned) {
    throw new Error("This customer cannot participate in referrals.");
  }

  const referralId = createWeleticId("wreferral_");
  const generatedDiscountCode = friendDiscountCode(referralId);

  const reservation = await (async () => {
    try {
      return await runSerializableReferralTransaction(async (tx) => {
        const store = await assertShopifyStoreAcceptsOperationalWrites({
          storeId,
          action: "referral_friend_claim",
          loyaltyMaintenancePermit,
          tx,
        });
        await lockLoyaltyProgramRow({
          tx,
          storeId,
          mode: "active",
          loyaltyMaintenancePermit,
        });

        const advocate = await tx.weleticLoyaltyAccount.findFirst({
          where: { storeId, referralCode: normalizedCode, status: "active" },
          include: { shopper: true, program: true },
        });
        if (!advocate) {
          throw new Error(
            "This referral invitation is invalid or has expired.",
          );
        }
        const existing = await tx.weleticLoyaltyReferral.findFirst({
          where: { storeId, friendEmailDigest: { in: emailDigests } },
        });
        if (existing) {
          return { referral: existing, advocate };
        }

        const rule = await tx.weleticLoyaltyReferralRule.findFirst({
          where: { programId: advocate.programId, isActive: true },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        });
        if (!rule)
          throw new Error("The referral program is currently inactive.");

        const matchingIpReferral =
          rule.fraudCheckSameIp && ipDigests.length > 0
            ? await tx.weleticLoyaltyReferral.findFirst({
                where: {
                  storeId,
                  ipHash: { in: ipDigests },
                  status: { not: WeleticLoyaltyReferralStatus.cancelled },
                },
                select: { id: true },
              })
            : null;
        const advocateEmailKey = getReferralEmailSimilarityKey(
          advocate.shopper.email,
        );
        const friendEmailKey = getReferralEmailSimilarityKey(email);
        const fraudSignals = {
          sameEmail: Boolean(
            isSameCanonicalEmail(advocate.shopper.email, email),
          ),
          similarEmail: Boolean(
            advocateEmailKey &&
              friendEmailKey &&
              advocateEmailKey === friendEmailKey,
          ),
          disposableEmail:
            isKnownDisposableReferralEmail(email) ||
            emailDomainFlags.isDisposable ||
            emailDomainFlags.matchesBlockedTerms,
          existingCustomer: Boolean(localCustomer || remoteCustomerExists),
          privacyTombstoned,
          repeatedIp: Boolean(matchingIpReferral),
          emailReputationUnavailable:
            "reputationUnavailable" in emailDomainFlags &&
            emailDomainFlags.reputationUnavailable === true,
        };
        const fraudReasons = [
          fraudSignals.sameEmail ? "Friend email matches the advocate" : null,
          fraudSignals.similarEmail
            ? "Friend email is materially similar to the advocate email"
            : null,
          fraudSignals.disposableEmail
            ? "Friend email uses a disposable or blocked domain"
            : null,
          fraudSignals.existingCustomer
            ? "Friend email already belongs to a Shopify customer"
            : null,
          fraudSignals.privacyTombstoned
            ? "Friend email is unavailable after a privacy erasure request"
            : null,
          fraudSignals.repeatedIp
            ? "Referral activity repeated from the same network"
            : null,
        ].filter((reason): reason is string => Boolean(reason));

        if (fraudReasons.length > 0) {
          const blocked = await tx.weleticLoyaltyReferral.create({
            data: {
              id: referralId,
              storeId,
              advocateAccountId: advocate.id,
              friendEmailDigest: currentEmailDigest,
              status: WeleticLoyaltyReferralStatus.fraud_blocked,
              ipHash,
              userAgentHash,
              fraudReason: fraudReasons.join("; "),
              fraudSignals: fraudSignals as Prisma.InputJsonValue,
              metadata: {
                claimKind: "anonymous_email",
                referralCode: normalizedCode,
                claimedAt: now.toISOString(),
              } as Prisma.InputJsonValue,
            },
          });
          return { referral: blocked, advocate };
        }

        if (
          rule.refereeRewardKind !== "coupon" ||
          !rule.refereeRewardDefinitionId
        ) {
          throw new Error(
            "The friend reward must be configured as a Shopify coupon before anonymous claims can be enabled.",
          );
        }
        const reward = await tx.weleticRewardDefinition.findFirst({
          where: {
            id: rule.refereeRewardDefinitionId,
            storeId,
            status: WeleticRewardStatus.active,
            exchangeType: WeleticRewardExchangeType.fixed,
          },
        });
        if (!reward || !isReferralCouponProvisionable(reward)) {
          throw new Error("The configured friend reward is not provisionable.");
        }
        if (!store?.shopCurrency || !store.currencyVerifiedAt) {
          throw new Error("Shopify store currency must be verified first.");
        }
        const rewardSnapshot = rewardSnapshotFromDefinition({
          reward,
          shopCurrency: store.shopCurrency,
          currencyVerifiedAt: store.currencyVerifiedAt,
          now,
        });
        const referral = await tx.weleticLoyaltyReferral.create({
          data: {
            id: referralId,
            storeId,
            advocateAccountId: advocate.id,
            friendEmailDigest: currentEmailDigest,
            friendRewardDefinitionId: reward.id,
            friendShopifyDiscountCode: generatedDiscountCode,
            friendShopifyDiscountCodeCanonical: canonicalizeLoyaltyDiscountCode(
              generatedDiscountCode,
            ),
            friendRewardExpiresAt: rewardSnapshot.expiresAt
              ? new Date(rewardSnapshot.expiresAt)
              : null,
            status: WeleticLoyaltyReferralStatus.pending,
            ipHash,
            userAgentHash,
            metadata: {
              claimKind: "anonymous_email",
              referralCode: normalizedCode,
              claimedAt: now.toISOString(),
              [CLAIM_METADATA_KEY]: rewardSnapshot,
            } as Prisma.InputJsonValue,
          },
        });

        return { referral, advocate };
      });
    } catch (error) {
      if (!isPrismaUniqueConstraintError(error)) throw error;
      const [referral, advocate] = await Promise.all([
        prisma.weleticLoyaltyReferral.findFirst({
          where: { storeId, friendEmailDigest: { in: emailDigests } },
        }),
        prisma.weleticLoyaltyAccount.findFirst({
          where: { storeId, referralCode: normalizedCode, status: "active" },
          include: { shopper: true, program: true },
        }),
      ]);
      if (!referral || !advocate) throw error;
      return { referral, advocate };
    }
  })();

  let referral = reservation.referral;
  if (
    referral.advocateAccountId !== reservation.advocate.id ||
    referral.status === WeleticLoyaltyReferralStatus.fraud_blocked
  ) {
    return { status: "review" as const };
  }
  if (referral.status === WeleticLoyaltyReferralStatus.cancelled) {
    if (
      referral.fraudReason === LEGACY_FRIEND_REWARD_CLEANUP_PENDING_REASON &&
      referral.friendRewardProvisionedAt === null &&
      referral.friendEmailDigest !== null &&
      emailDigests.includes(referral.friendEmailDigest) &&
      referral.friendShopifyDiscountCode &&
      referral.friendShopifyDiscountId
    ) {
      const credentials = await resolveShopifyOfflineCredentials({ storeId });
      await deactivateAndFinalizeUnprovisionableFriendReward({
        storeId,
        referralId: referral.id,
        friendEmailDigests: emailDigests,
        discountCode: referral.friendShopifyDiscountCode,
        remoteDiscountId: referral.friendShopifyDiscountId,
        shopDomain: credentials.shopDomain,
        accessToken: credentials.accessToken,
        loyaltyMaintenancePermit,
      });
    }
    return { status: "review" as const };
  }

  const snapshot = readFriendRewardSnapshot(referral.metadata);
  if (!snapshot) throw new Error("Friend reward snapshot is unavailable.");
  if (!referral.friendShopifyDiscountCode) {
    throw new Error("Friend discount identity is unavailable.");
  }
  if (!referral.friendRewardProvisionedAt) {
    if (!isReferralCouponProvisionable(snapshot.rewardDefinition)) {
      await reconcileUnprovisionableFriendRewardReservation({
        storeId,
        referralId: referral.id,
        friendEmailDigests: emailDigests,
        discountCode: referral.friendShopifyDiscountCode,
        snapshot,
        loyaltyMaintenancePermit,
      });
      return { status: "review" as const };
    }
    const credentials = await resolveShopifyOfflineCredentials({ storeId });
    let remote;
    try {
      remote = await provisionLoyaltyRewardDiscount({
        storeId,
        resolvedCredentials: credentials,
        rewardDefinition: snapshot.rewardDefinition,
        discountCode: referral.friendShopifyDiscountCode,
        startsAt: new Date(snapshot.startsAt),
        expiresAt: snapshot.expiresAt ? new Date(snapshot.expiresAt) : null,
        expectedShopCurrency: snapshot.shopCurrency,
        currentShopCurrency: snapshot.shopCurrency,
        shopifyCustomerId: null,
      });
    } catch (provisionError) {
      const existingRemote = await lookupDiscountByCode(
        credentials.shopDomain,
        credentials.accessToken,
        referral.friendShopifyDiscountCode,
      );
      if (
        !existingRemote ||
        !matchesLoyaltyRewardDiscountConfiguration({
          remote: existingRemote,
          rewardDefinition: snapshot.rewardDefinition,
          startsAt: new Date(snapshot.startsAt),
          expiresAt: snapshot.expiresAt ? new Date(snapshot.expiresAt) : null,
          expectedShopCurrency: snapshot.shopCurrency,
          shopifyCustomerId: null,
        })
      ) {
        throw provisionError;
      }
      remote = existingRemote;
    }

    try {
      referral = await runSerializableReferralTransaction(async (tx) => {
        await assertShopifyStoreAcceptsOperationalWrites({
          storeId,
          action: "referral_friend_claim_adoption",
          loyaltyMaintenancePermit,
          tx,
        });
        await lockLoyaltyProgramRow({
          tx,
          storeId,
          mode: "active",
          loyaltyMaintenancePermit,
        });
        const provisioned = await tx.weleticLoyaltyReferral.updateMany({
          where: {
            id: referral.id,
            storeId,
            status: WeleticLoyaltyReferralStatus.pending,
            friendRewardProvisionedAt: null,
          },
          data: {
            friendShopifyDiscountId: remote.id,
            friendRewardProvisionedAt: new Date(),
          },
        });
        if (provisioned.count === 0) {
          const concurrent = await tx.weleticLoyaltyReferral.findFirstOrThrow({
            where: { id: referral.id, storeId },
          });
          if (
            concurrent.status !== WeleticLoyaltyReferralStatus.pending ||
            !concurrent.friendRewardProvisionedAt ||
            concurrent.friendShopifyDiscountId !== remote.id
          ) {
            throw new Error("Friend reward claim changed during provisioning.");
          }
          return concurrent;
        }
        return tx.weleticLoyaltyReferral.findFirstOrThrow({
          where: { id: referral.id, storeId },
        });
      });
    } catch (adoptionError) {
      const adopted = await prisma.weleticLoyaltyReferral.findFirst({
        where: {
          id: referral.id,
          storeId,
          friendShopifyDiscountId: remote.id,
          friendRewardProvisionedAt: { not: null },
        },
      });
      if (adopted) {
        referral = adopted;
      } else {
        // A remote create is not allowed to outlive a failed local adoption.
        // The reservation identity is released only after Shopify confirms the
        // voucher is disabled, so a later claim can safely start again.
        await deactivateDiscount(
          credentials.shopDomain,
          credentials.accessToken,
          remote.id,
        );
        await prisma.weleticLoyaltyReferral.updateMany({
          where: {
            id: referral.id,
            storeId,
            friendRewardProvisionedAt: null,
          },
          data: {
            status: WeleticLoyaltyReferralStatus.cancelled,
            friendEmailDigest: null,
            friendShopifyDiscountCode: null,
            friendShopifyDiscountCodeCanonical: null,
            friendShopifyDiscountId: null,
            friendRewardDefinitionId: null,
            fraudReason:
              "Remote voucher was rolled back after local adoption failed",
          },
        });
        throw adoptionError;
      }
    }
  }
  if (
    !referral.friendRewardProvisionedAt ||
    !referral.friendShopifyDiscountId
  ) {
    throw new Error("Friend reward provisioning did not complete.");
  }
  const provisionedDiscountId = referral.friendShopifyDiscountId;
  await assertShopifyStoreAcceptsOperationalWrites({
    storeId,
    action: "referral_friend_delivery_precheck",
    loyaltyMaintenancePermit,
  });
  const [privacyTombstonedBeforeDelivery, deliverableReferral] =
    await Promise.all([
      hasShopifyCustomerPrivacyTombstone({ storeId, email }),
      prisma.weleticLoyaltyReferral.findFirst({
        where: {
          id: referral.id,
          storeId,
          friendEmailDigest: { in: emailDigests },
          friendShopifyDiscountId: provisionedDiscountId,
          friendRewardProvisionedAt: { not: null },
          status: { not: WeleticLoyaltyReferralStatus.cancelled },
        },
      }),
    ]);
  if (privacyTombstonedBeforeDelivery || !deliverableReferral) {
    throw new Error("This customer cannot participate in referrals.");
  }
  referral = deliverableReferral;
  const finalDiscountCode = referral.friendShopifyDiscountCode;
  if (!finalDiscountCode) {
    throw new Error("Friend discount identity was lost during provisioning.");
  }
  const applyUrl = referralApplyUrl(
    storeIdentity.shopDomain,
    finalDiscountCode,
  );
  let emailSent = Boolean(referral.friendRewardEmailedAt);
  if (!emailSent) {
    const communications = await readShopperCommunicationSettings({
      storeId,
      legacyBrandName: reservation.advocate.program.name,
    });
    const delivery = await deliverReferralEmailUnderLease({
      referralId: referral.id,
      storeId,
      now,
      deliver: () =>
        deliverFriendRewardEmail({
          referralId: referral.id,
          email,
          brandName: communications.brandName,
          logoUrl: communications.logoUrl,
          accentColor: communications.accentColor,
          advocateName:
            [
              reservation.advocate.shopper.firstName,
              reservation.advocate.shopper.lastName,
            ]
              .filter(Boolean)
              .join(" ") || null,
          rewardName: snapshot.rewardDefinition.name,
          discountCode: finalDiscountCode,
          applyUrl,
          expiresAt: referral.friendRewardExpiresAt,
        }),
    });
    emailSent = delivery.emailSent;
  }
  return {
    status: "claimed" as const,
    discountCode: finalDiscountCode,
    applyUrl,
    expiresAt: referral.friendRewardExpiresAt,
    emailSent,
  };
}

export async function evaluateReferralFriendClaimQualification({
  storeId,
  orderId,
  friendEmail,
  refereeShopperId,
  orderSubtotal,
  currency,
  customerOrderSequence,
  loyaltyMaintenancePermit,
}: {
  storeId: string;
  orderId: string;
  friendEmail?: string | null;
  refereeShopperId?: string | null;
  orderSubtotal: bigint;
  currency: string;
  customerOrderSequence?: number | null;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}) {
  if (!friendEmail) return { qualified: false as const, reason: "No email" };
  let email: string;
  try {
    email = canonicalizeShopifyCustomerEmail(friendEmail);
  } catch {
    return { qualified: false as const, reason: "Invalid email" };
  }
  const emailDigests = createAllShopifyDerivedPrivacyDigests({
    purpose: "referral_email",
    values: [storeId, email],
  });

  try {
    return await runSerializableReferralTransaction(async (tx) => {
      const operationalStore = await assertShopifyStoreAcceptsOperationalWrites(
        {
          storeId,
          action: "referral_friend_qualification",
          requireVerifiedCurrency: true,
          loyaltyMaintenancePermit,
          tx,
        },
      );
      await lockLoyaltyProgramRow({
        tx,
        storeId,
        mode: "active",
        loyaltyMaintenancePermit,
      });
      if (
        operationalStore?.shopCurrency.trim().toUpperCase() !==
        currency.trim().toUpperCase()
      ) {
        throw new Error("Referral order currency does not match the store.");
      }
      const referral = await tx.weleticLoyaltyReferral.findFirst({
        where: {
          storeId,
          friendEmailDigest: { in: emailDigests },
          status: WeleticLoyaltyReferralStatus.pending,
          friendRewardProvisionedAt: { not: null },
        },
        include: { advocateAccount: true },
      });
      if (!referral || !referral.friendEmailDigest) {
        return { qualified: false as const, reason: "No pending friend claim" };
      }
      const persistedShopper = refereeShopperId
        ? await tx.weleticShopper.findFirst({
            where: { id: refereeShopperId, storeId },
            select: { ordersCount: true },
          })
        : null;
      const observedOrderSequence =
        customerOrderSequence ?? persistedShopper?.ordersCount ?? null;
      if (observedOrderSequence != null && observedOrderSequence > 1) {
        await tx.weleticLoyaltyReferral.updateMany({
          where: {
            id: referral.id,
            storeId,
            status: WeleticLoyaltyReferralStatus.pending,
          },
          data: {
            status: WeleticLoyaltyReferralStatus.fraud_blocked,
            fraudReason: "Qualifying purchase is not the friend's first order",
            fraudSignals: {
              nonFirstOrder: true,
              observedOrdersCount: observedOrderSequence,
            } as Prisma.InputJsonValue,
          },
        });
        return { qualified: false as const, reason: "Not first order" };
      }
      const rule = await tx.weleticLoyaltyReferralRule.findFirst({
        where: {
          programId: referral.advocateAccount.programId,
          isActive: true,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      if (!rule) return { qualified: false as const, reason: "Inactive rule" };
      let qualificationPurchasePolicy;
      try {
        qualificationPurchasePolicy = readLoyaltyPurchasePolicy(
          rule.purchasePolicy,
          DEFAULT_REFERRAL_PURCHASE_POLICY,
        );
      } catch {
        return { qualified: false as const, reason: "Invalid purchase policy" };
      }
      const eligibleSubtotal = await getEligibleLoyaltyOrderSubtotal({
        tx,
        storeId,
        orderId,
        policy: qualificationPurchasePolicy,
        testFallbackSubtotal: orderSubtotal,
      });
      if (eligibleSubtotal <= BigInt(0)) {
        return { qualified: false as const, reason: "Ineligible purchase" };
      }
      if (rule.minQualifyingOrderSubtotal) {
        const minimum = decimalToMinorUnits(
          rule.minQualifyingOrderSubtotal.toString(),
          currency,
        );
        if (eligibleSubtotal < minimum) {
          return { qualified: false as const, reason: "Below minimum" };
        }
      }
      const advocateAwarded =
        rule.advocateRewardKind === "points"
          ? rule.advocatePointsReward
          : BigInt(0);
      const qualifiedAt = new Date();
      const advocateCoupon =
        rule.advocateRewardKind === "coupon" && rule.advocateRewardDefinitionId
          ? await tx.weleticRewardDefinition.findFirst({
              where: {
                id: rule.advocateRewardDefinitionId,
                storeId,
                status: WeleticRewardStatus.active,
                exchangeType: WeleticRewardExchangeType.fixed,
              },
            })
          : null;
      if (
        rule.advocateRewardKind === "coupon" &&
        (!advocateCoupon || !isReferralCouponProvisionable(advocateCoupon))
      ) {
        throw new Error("The advocate coupon reward is not provisionable.");
      }
      const couponSnapshot = advocateCoupon
        ? createReferralCouponRewardSnapshot({
            identity: {
              storeId,
              referralId: referral.id,
              qualificationOrderId: orderId,
              accountId: referral.advocateAccountId,
              rewardDefinitionId: advocateCoupon.id,
              side: "advocate",
            },
            reward: advocateCoupon,
            qualifiedAt,
            shopCurrency: currency,
            currencyVerifiedAt: operationalStore!.currencyVerifiedAt!,
            shopifyCustomerId: (
              await tx.weleticLoyaltyAccount.findFirstOrThrow({
                where: { id: referral.advocateAccountId, storeId },
                select: { shopper: { select: { shopifyCustomerId: true } } },
              })
            ).shopper.shopifyCustomerId,
          })
        : null;
      const couponKey = couponSnapshot
        ? `job:${getReferralCouponIdempotencyKey({
            referralId: referral.id,
            qualificationOrderId: orderId,
            side: "advocate",
          })}`
        : null;
      const ledgerKey = `referral_friend_advocate:${referral.id}:${orderId}`;
      const existingAward =
        advocateAwarded > BigInt(0)
          ? await tx.weleticPointsLedgerEntry.findUnique({
              where: {
                storeId_idempotencyKey: { storeId, idempotencyKey: ledgerKey },
              },
            })
          : couponKey
            ? await tx.weleticLoyaltyOutboxJob.findUnique({
                where: {
                  storeId_idempotencyKey: {
                    storeId,
                    idempotencyKey: couponKey,
                  },
                },
              })
            : null;
      if (existingAward) {
        return { qualified: false as const, reason: "Already awarded" };
      }
      const claimed = await tx.weleticLoyaltyReferral.updateMany({
        where: {
          id: referral.id,
          storeId,
          status: WeleticLoyaltyReferralStatus.pending,
        },
        data: {
          status: couponSnapshot
            ? WeleticLoyaltyReferralStatus.qualified
            : WeleticLoyaltyReferralStatus.rewarded,
          qualifyingOrderId: orderId,
          refereeShopperId: refereeShopperId || null,
          advocatePointsAwarded: advocateAwarded,
          rewardedAt: couponSnapshot ? null : qualifiedAt,
          metadata: {
            ...((referral.metadata &&
            typeof referral.metadata === "object" &&
            !Array.isArray(referral.metadata)
              ? referral.metadata
              : {}) as Record<string, unknown>),
            qualificationOrderId: orderId,
            qualificationReferralRuleId: rule.id,
            qualificationPurchasePolicy,
            friendPrivacySnapshot: createReferralPrivacySnapshot({
              storeId,
              referralId: referral.id,
              friendEmailDigest: referral.friendEmailDigest,
              email,
              now: qualifiedAt,
            }),
            eligibleSubtotal: eligibleSubtotal.toString(),
            requiredCouponSides: couponSnapshot ? ["advocate"] : [],
            referralCouponRewardSnapshots: couponSnapshot
              ? { advocate: couponSnapshot }
              : {},
            rewardKinds: {
              advocate: rule.advocateRewardKind,
              referee: "preissued_coupon",
            },
          } as Prisma.InputJsonValue,
        },
      });
      if (claimed.count !== 1) {
        return { qualified: false as const, reason: "Concurrent claim" };
      }
      const counter = await tx.weleticLoyaltyAccount.updateMany({
        where: {
          id: referral.advocateAccountId,
          storeId,
          status: "active",
          ...(rule.maxReferralsPerAdvocate != null
            ? { referralCount: { lt: rule.maxReferralsPerAdvocate } }
            : {}),
        },
        data: {
          referralCount: { increment: 1 },
          referralPointsEarned: { increment: advocateAwarded },
        },
      });
      if (counter.count !== 1) {
        throw new Error("Advocate referral limit was reached.");
      }
      if (advocateAwarded > BigInt(0)) {
        const ledgerEntry = await appendPointsLedgerEntry({
          storeId,
          accountId: referral.advocateAccountId,
          entryType: WeleticPointsLedgerEntryType.EARN_REFERRAL,
          pointsDelta: advocateAwarded,
          referenceType: "referral_friend_claim",
          referenceId: referral.id,
          idempotencyKey: ledgerKey,
          reason: `Referral reward for a friend's first order (${orderId})`,
          metadata: { referralId: referral.id, orderId },
          tx,
        });
        await enqueueFlowTriggerJob({
          storeId,
          eventId: ledgerEntry.id,
          payload: {
            accountId: referral.advocateAccountId,
            handle: "weletic-points-earned",
            pointsDelta: advocateAwarded.toString(),
            pointsBalance: ledgerEntry.balanceAfter.toString(),
            reason: "referral_friend_reward",
            orderId,
          },
          loyaltyMaintenancePermit,
          tx,
        });
        await scheduleTierReviewAfterQualifyingActivity({
          storeId,
          accountId: referral.advocateAccountId,
          activityKey: ledgerKey,
          reason: "referral_friend_points_earned",
          loyaltyMaintenancePermit,
          tx,
        });
      }
      if (!couponSnapshot) {
        await enqueueFlowTriggerJob({
          storeId,
          eventId: referral.id,
          payload: {
            handle: "weletic-referral-completed",
            accountId: referral.advocateAccountId,
            referralId: referral.id,
            orderId,
            advocatePoints: advocateAwarded.toString(),
            friendPoints: "0",
          },
          loyaltyMaintenancePermit,
          tx,
        });
      }
      if (couponSnapshot && advocateCoupon && couponKey) {
        await enqueueOutboxJob({
          storeId,
          jobType: "REFERRAL_REWARD_PROVISION",
          payload: {
            referralId: referral.id,
            qualificationOrderId: orderId,
            accountId: referral.advocateAccountId,
            rewardDefinitionId: advocateCoupon.id,
            side: "advocate",
            rewardSnapshot: couponSnapshot,
          },
          idempotencyKey: couponKey,
          loyaltyMaintenancePermit,
          tx,
        });
      }
      await enqueueOutboxJob({
        storeId,
        jobType: "METAFIELD_SYNC",
        payload: {
          accountId: referral.advocateAccountId,
          triggerReason: "referral_friend_reward",
        },
        idempotencyKey: `metafield_sync:referral_friend:${referral.id}:${orderId}`,
        loyaltyMaintenancePermit,
        tx,
      });
      return {
        qualified: true as const,
        referralId: referral.id,
        advocatePointsAwarded: advocateAwarded,
        couponProvisioning: Boolean(couponSnapshot),
      };
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("limit")) {
      return { qualified: false as const, reason: error.message };
    }
    throw error;
  }
}

export async function approveReferralFriendClaimAfterReview({
  storeId,
  referralId,
  reviewNote,
  now = new Date(),
}: {
  storeId: string;
  referralId: string;
  reviewNote?: string | null;
  now?: Date;
}) {
  return runSerializableReferralTransaction(async (tx) => {
    const store = await assertShopifyStoreAcceptsOperationalWrites({
      storeId,
      action: "referral_friend_claim_review_approve",
      tx,
    });
    await lockLoyaltyProgramRow({ tx, storeId, mode: "active" });
    const referral = await tx.weleticLoyaltyReferral.findFirst({
      where: {
        id: referralId,
        storeId,
        status: WeleticLoyaltyReferralStatus.fraud_blocked,
        friendEmailDigest: { not: null },
      },
      include: { advocateAccount: true },
    });
    if (!referral) {
      throw new Error("Fraud-blocked friend claim was not found.");
    }
    const rule = await tx.weleticLoyaltyReferralRule.findFirst({
      where: {
        programId: referral.advocateAccount.programId,
        isActive: true,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    if (
      !rule ||
      rule.refereeRewardKind !== "coupon" ||
      !rule.refereeRewardDefinitionId
    ) {
      throw new Error("An active coupon friend reward is required.");
    }
    const reward = await tx.weleticRewardDefinition.findFirst({
      where: {
        id: rule.refereeRewardDefinitionId,
        storeId,
        status: WeleticRewardStatus.active,
        exchangeType: WeleticRewardExchangeType.fixed,
      },
    });
    if (!reward || !isReferralCouponProvisionable(reward)) {
      throw new Error("The configured friend reward is not provisionable.");
    }
    if (!store?.shopCurrency || !store.currencyVerifiedAt) {
      throw new Error("Shopify store currency must be verified first.");
    }
    const rewardSnapshot = rewardSnapshotFromDefinition({
      reward,
      shopCurrency: store.shopCurrency,
      currencyVerifiedAt: store.currencyVerifiedAt,
      now,
    });
    const code = friendDiscountCode(referral.id);
    const metadata =
      referral.metadata &&
      typeof referral.metadata === "object" &&
      !Array.isArray(referral.metadata)
        ? (referral.metadata as Record<string, unknown>)
        : {};
    const approved = await tx.weleticLoyaltyReferral.updateMany({
      where: {
        id: referral.id,
        storeId,
        status: WeleticLoyaltyReferralStatus.fraud_blocked,
      },
      data: {
        status: WeleticLoyaltyReferralStatus.pending,
        fraudReason: null,
        friendRewardDefinitionId: reward.id,
        friendShopifyDiscountCode: code,
        friendShopifyDiscountCodeCanonical:
          canonicalizeLoyaltyDiscountCode(code),
        friendRewardExpiresAt: rewardSnapshot.expiresAt
          ? new Date(rewardSnapshot.expiresAt)
          : null,
        metadata: {
          ...metadata,
          [CLAIM_METADATA_KEY]: rewardSnapshot,
          reviewedAt: now.toISOString(),
          reviewDecision: "approved",
          reviewNote: reviewNote?.trim() || null,
          // The customer must resubmit the same email. The server can then
          // provision and deliver the code without ever persisting raw email.
          awaitingClaimResubmission: true,
        } as Prisma.InputJsonValue,
      },
    });
    if (approved.count !== 1) {
      throw new Error("Friend claim changed during review approval.");
    }
    return tx.weleticLoyaltyReferral.findFirstOrThrow({
      where: { id: referral.id, storeId },
    });
  });
}

export async function redactReferralFriendClaimsForEmail({
  storeId,
  email: rawEmail,
  redactedAt,
}: {
  storeId: string;
  email: string;
  redactedAt: Date;
}) {
  const email = canonicalizeShopifyCustomerEmail(rawEmail);
  const emailDigests = createAllShopifyDerivedPrivacyDigests({
    purpose: "referral_email",
    values: [storeId, email],
  });
  const referrals = await prisma.weleticLoyaltyReferral.findMany({
    where: { storeId, friendEmailDigest: { in: emailDigests } },
  });
  if (referrals.length === 0) return 0;

  const discountIds = [
    ...new Set(
      referrals
        .map((referral) => referral.friendShopifyDiscountId)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  if (discountIds.length > 0) {
    // Keep the digest until every remote voucher is disabled. If Shopify is
    // unavailable, the compliance worker retries with the same exact rows.
    const credentials = await resolveShopifyOfflineCredentials({ storeId });
    for (const discountId of discountIds) {
      await deactivateDiscount(
        credentials.shopDomain,
        credentials.accessToken,
        discountId,
      );
    }
  }

  const deactivatedDiscountIds = new Set(discountIds);
  await runSerializableReferralTransaction(async (tx) => {
    await lockLoyaltyProgramRow({ tx, storeId, mode: "lock_only" });
    for (const referral of referrals) {
      const current = await tx.weleticLoyaltyReferral.findFirst({
        where: {
          id: referral.id,
          storeId,
          friendEmailDigest: { in: emailDigests },
        },
      });
      if (!current) continue;
      if (
        current.friendShopifyDiscountId &&
        !deactivatedDiscountIds.has(current.friendShopifyDiscountId)
      ) {
        throw new Error(
          `Referral friend claim ${current.id} acquired a newer voucher during privacy redaction.`,
        );
      }
      const awaitingPurchase =
        current.status === WeleticLoyaltyReferralStatus.pending ||
        current.status === WeleticLoyaltyReferralStatus.fraud_blocked;
      const scrubbed = await tx.weleticLoyaltyReferral.updateMany({
        where: {
          id: current.id,
          storeId,
          friendEmailDigest: { in: emailDigests },
        },
        data: {
          friendEmailDigest: null,
          friendRewardDefinitionId: null,
          friendShopifyDiscountCode: null,
          friendShopifyDiscountCodeCanonical: null,
          friendShopifyDiscountId: null,
          ipHash: null,
          userAgentHash: null,
          fraudReason: null,
          fraudSignals: Prisma.DbNull,
          ...(awaitingPurchase
            ? { status: WeleticLoyaltyReferralStatus.cancelled }
            : {}),
          metadata: {
            privacyRedactedAt: redactedAt.toISOString(),
            friendDiscountDeactivatedAt: current.friendShopifyDiscountId
              ? redactedAt.toISOString()
              : null,
            ...(awaitingPurchase
              ? {
                  requalificationBlocked: true,
                  requalificationBlockedReason: "customer_privacy_redacted",
                }
              : {}),
          } as Prisma.InputJsonValue,
        },
      });
      if (scrubbed.count !== 1) {
        throw new Error(
          `Referral friend claim ${current.id} changed during privacy redaction.`,
        );
      }
    }
  });
  return referrals.length;
}

export async function redactReferralFriendClaimsForShopBatch({
  storeId,
  afterId,
  batchSize,
  redactedAt,
}: {
  storeId: string;
  afterId?: string;
  batchSize: number;
  redactedAt: Date;
}) {
  const referrals = await prisma.weleticLoyaltyReferral.findMany({
    where: {
      storeId,
      ...(afterId ? { id: { gt: afterId } } : {}),
      OR: [
        { friendEmailDigest: { not: null } },
        { friendShopifyDiscountCode: { not: null } },
        { friendShopifyDiscountId: { not: null } },
      ],
    },
    orderBy: { id: "asc" },
    take: batchSize + 1,
  });
  const bounded = referrals.slice(0, batchSize);
  const remoteIds = [
    ...new Set(
      bounded
        .map((referral) => referral.friendShopifyDiscountId)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  if (remoteIds.length > 0) {
    const credentials = await resolveShopifyOfflineCredentials({ storeId });
    for (const remoteId of remoteIds) {
      await deactivateDiscount(
        credentials.shopDomain,
        credentials.accessToken,
        remoteId,
      );
    }
  }

  for (const referral of bounded) {
    const awaitingPurchase =
      referral.status === WeleticLoyaltyReferralStatus.pending ||
      referral.status === WeleticLoyaltyReferralStatus.fraud_blocked;
    const scrubbed = await prisma.weleticLoyaltyReferral.updateMany({
      where: { id: referral.id, storeId },
      data: {
        friendEmailDigest: null,
        friendRewardDefinitionId: null,
        friendShopifyDiscountCode: null,
        friendShopifyDiscountCodeCanonical: null,
        friendShopifyDiscountId: null,
        ipHash: null,
        userAgentHash: null,
        fraudReason: null,
        fraudSignals: Prisma.DbNull,
        ...(awaitingPurchase
          ? { status: WeleticLoyaltyReferralStatus.cancelled }
          : {}),
        metadata: {
          privacyRedactedAt: redactedAt.toISOString(),
          privacyRedactionSource: "shop_redact",
          friendDiscountDeactivated: Boolean(referral.friendShopifyDiscountId),
        },
      },
    });
    if (scrubbed.count !== 1) {
      throw new Error(
        `Referral friend claim ${referral.id} changed during shop erasure.`,
      );
    }
  }

  return {
    scrubbed: bounded.length,
    hasMore: referrals.length > batchSize,
    lastId: bounded[bounded.length - 1]?.id,
  };
}

export async function deactivateCancelledReferralFriendReward({
  storeId,
  orderId,
  referralId,
}: {
  storeId: string;
  orderId?: string;
  referralId?: string;
}) {
  if (!orderId && !referralId) {
    throw new Error("A referral or qualifying order id is required.");
  }
  const referral = await prisma.weleticLoyaltyReferral.findFirst({
    where: {
      storeId,
      ...(referralId ? { id: referralId } : { qualifyingOrderId: orderId }),
      status: WeleticLoyaltyReferralStatus.cancelled,
      friendShopifyDiscountId: { not: null },
    },
  });
  if (!referral?.friendShopifyDiscountId) return false;
  const metadata =
    referral.metadata &&
    typeof referral.metadata === "object" &&
    !Array.isArray(referral.metadata)
      ? (referral.metadata as Record<string, unknown>)
      : {};
  if (metadata.friendDiscountDeactivatedAt) return true;
  const credentials = await resolveShopifyOfflineCredentials({ storeId });
  await deactivateDiscount(
    credentials.shopDomain,
    credentials.accessToken,
    referral.friendShopifyDiscountId,
  );
  await prisma.weleticLoyaltyReferral.updateMany({
    where: {
      id: referral.id,
      storeId,
      status: WeleticLoyaltyReferralStatus.cancelled,
      // Customer/shop redaction clears this identity. If that wins while the
      // remote deactivation is in flight, do not overwrite its scrubbed
      // metadata with this stale pre-redaction snapshot.
      friendShopifyDiscountId: referral.friendShopifyDiscountId,
    },
    data: {
      metadata: {
        ...metadata,
        friendDiscountDeactivatedAt: new Date().toISOString(),
      } as Prisma.InputJsonValue,
    },
  });
  return true;
}
