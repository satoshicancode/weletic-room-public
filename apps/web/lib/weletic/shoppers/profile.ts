import { prisma } from "@/lib/prisma";
import { shopperRewardOwnershipWhere } from "@/lib/weletic/loyalty/reward-ownership";
import { hasShopifyCustomerRedactionTombstone } from "@/lib/weletic/loyalty/shopper-privacy";
import {
  hasShopifyCustomerPrivacyTombstone,
  SHOPIFY_CUSTOMER_PRIVACY_PSEUDONYM_PATTERN,
} from "@/lib/weletic/shopify/privacy-identity";
import type { Prisma } from "@prisma/client";
import {
  shopperProfileChronology,
  ShopperProfileError,
  shopperProfilePage,
  shopperProfileQuerySchema,
  shopperProfileSequence,
} from "./profile-query";

/** Read one store-scoped shopper, not a Dub Customer or affiliate Partner.
 * Explicit projections exclude bearer artifacts, private media, abuse signals,
 * raw provider failures and consent claims unsupported by retained data.
 * Authenticated gateways can supply their authorization transaction; this
 * read primitive does not authenticate the workspace or caller itself.
 */
export async function readMerchantShopperProfile(
  workspaceId: string,
  input: unknown,
  transaction?: Prisma.TransactionClient,
) {
  const query = shopperProfileQuerySchema.parse(input);
  if (query.section === "overview" && query.cursor)
    throw new ShopperProfileError("bad_request");
  const read = async (tx: Prisma.TransactionClient) => {
    const store = await tx.weleticShopifyStore.findFirst({
      where: {
        projectId: workspaceId,
        complianceState: "active",
        installationGeneration: { not: null },
      },
      select: { id: true, installationGeneration: true, defaultLocale: true },
    });
    if (!store?.installationGeneration)
      throw new ShopperProfileError("not_found");
    const shopper = await tx.weleticShopper.findFirst({
      where: { id: query.shopperId, storeId: store.id },
      select: {
        id: true,
        shopifyCustomerId: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        locale: true,
        acceptsMarketing: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (
      !shopper ||
      SHOPIFY_CUSTOMER_PRIVACY_PSEUDONYM_PATTERN.test(shopper.shopifyCustomerId)
    )
      throw new ShopperProfileError("not_found");
    const account = await tx.weleticLoyaltyAccount.findFirst({
      where: { storeId: store.id, shopperId: shopper.id },
      select: {
        id: true,
        status: true,
        metadata: true,
        currentTierId: true,
        cachedPointsBalance: true,
        cachedPendingPoints: true,
        lifetimePointsEarned: true,
        lifetimePointsRedeemed: true,
        enrolledAt: true,
      },
    });
    if (
      hasShopifyCustomerRedactionTombstone(account?.metadata) ||
      (await hasShopifyCustomerPrivacyTombstone({
        storeId: store.id,
        shopifyCustomerId: shopper.shopifyCustomerId,
        email: shopper.email,
        tx,
      }))
    )
      throw new ShopperProfileError("not_found");
    // Independent owner links remain authoritative even after identity scrubbing.
    const tombstone = await tx.weleticShopifyCustomerPrivacyTombstone.findFirst(
      {
        where: {
          storeId: store.id,
          OR: [
            { shopperId: shopper.id },
            ...(account ? [{ accountId: account.id }] : []),
          ],
        },
        select: { id: true },
      },
    );
    if (tombstone) throw new ShopperProfileError("not_found");
    const scope = {
      storeId: store.id,
      shopperId: shopper.id,
      section: query.section,
      generation: store.installationGeneration,
    };
    const chronology =
      query.section === "points"
        ? {}
        : shopperProfileChronology(scope, query.cursor);
    const sequence =
      query.section === "points"
        ? shopperProfileSequence(scope, query.cursor)
        : {};
    const page = {
      take: query.limit + 1,
      orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }],
    };
    const ownership = { storeId: store.id, shopperId: shopper.id };

    if (query.section === "overview") {
      const program = await tx.weleticLoyaltyProgram.findUnique({
        where: { storeId: store.id },
        select: { status: true, killSwitchActive: true },
      });
      const reviews = await tx.weleticReviewSettings.findUnique({
        where: { storeId: store.id },
        select: { enabled: true, requestEmailEnabled: true },
      });
      const tier = account?.currentTierId
        ? await tx.weleticLoyaltyTier.findFirst({
            where: {
              id: account.currentTierId,
              program: { storeId: store.id },
            },
            select: { id: true, name: true },
          })
        : null;
      return {
        section: "overview" as const,
        shopper: {
          ...shopper,
          createdAt: shopper.createdAt.toISOString(),
          updatedAt: shopper.updatedAt.toISOString(),
        },
        locale: { shopper: shopper.locale, merchant: store.defaultLocale },
        communicationPreferences: {
          shopifyAcceptsMarketing: shopper.acceptsMarketing,
          consentEvidence: "unavailable" as const,
          consentSource: null,
          consentRecordedAt: null,
          suppressionStatus: "unavailable" as const,
        },
        modules: {
          loyalty: program,
          reviews: reviews ?? { enabled: false, requestEmailEnabled: false },
        },
        loyalty: account
          ? {
              id: account.id,
              status: account.status,
              tier,
              pointsBalance: account.cachedPointsBalance.toString(),
              pendingPoints: account.cachedPendingPoints.toString(),
              lifetimeEarned: account.lifetimePointsEarned.toString(),
              lifetimeRedeemed: account.lifetimePointsRedeemed.toString(),
              enrolledAt: account.enrolledAt.toISOString(),
            }
          : null,
        coverage: {
          communications: "partial" as const,
          communicationSources: [
            "review_requests",
            "referral_friend_emailed_at",
          ],
          reason:
            "Provider delivery, consent history and unified shopper journeys are not yet recorded here.",
          reviews: "native_product_reviews_only" as const,
          rewards: "account_and_direct_shopper_rewards" as const,
          purchases: "locally_projected_orders_only" as const,
        },
      };
    }
    if (query.section === "purchases") {
      const rows = await tx.weleticCommerceOrder.findMany({
        where: { ...ownership, ...chronology },
        ...page,
        select: {
          id: true,
          createdAt: true,
          occurredAt: true,
          orderName: true,
          status: true,
          accountingCurrency: true,
          accountingNet: true,
          accountingTotal: true,
        },
      });
      return shopperProfilePage(
        { ...scope, section: "purchases" },
        rows,
        query.limit,
        (row) => ({
          ...row,
          createdAt: row.createdAt.toISOString(),
          occurredAt: row.occurredAt.toISOString(),
          accountingNet: row.accountingNet.toString(),
          accountingTotal: row.accountingTotal.toString(),
        }),
      );
    }
    if (query.section === "reviews") {
      const rows = await tx.weleticProductReview.findMany({
        where: { ...ownership, status: { not: "redacted" }, ...chronology },
        ...page,
        select: {
          id: true,
          createdAt: true,
          productId: true,
          status: true,
          rating: true,
          title: true,
          verifiedPurchase: true,
          incentivized: true,
          rewardStatus: true,
        },
      });
      return shopperProfilePage(
        { ...scope, section: "reviews" },
        rows,
        query.limit,
        (row) => ({
          ...row,
          subject: "product" as const,
          createdAt: row.createdAt.toISOString(),
        }),
      );
    }
    if (query.section === "review_requests") {
      const rows = await tx.weleticReviewRequest.findMany({
        where: { ...ownership, ...chronology },
        ...page,
        select: {
          id: true,
          createdAt: true,
          productId: true,
          orderId: true,
          status: true,
          sendAt: true,
          sentAt: true,
          submittedAt: true,
          expiresAt: true,
          cancelledAt: true,
          deliveryAttempts: true,
        },
      });
      return shopperProfilePage(
        { ...scope, section: "review_requests" },
        rows,
        query.limit,
        (row) => ({
          ...row,
          createdAt: row.createdAt.toISOString(),
          sendAt: row.sendAt.toISOString(),
          sentAt: row.sentAt?.toISOString() ?? null,
          submittedAt: row.submittedAt?.toISOString() ?? null,
          expiresAt: row.expiresAt.toISOString(),
          cancelledAt: row.cancelledAt?.toISOString() ?? null,
          deliveryEvidence: "application_send_record_only" as const,
        }),
      );
    }
    if (query.section === "referrals") {
      const rows = await tx.weleticLoyaltyReferral.findMany({
        where: {
          storeId: store.id,
          AND: [
            {
              OR: [
                { refereeShopperId: shopper.id },
                ...(account
                  ? [
                      { advocateAccountId: account.id },
                      { refereeAccountId: account.id },
                    ]
                  : []),
              ],
            },
            chronology,
          ],
        },
        ...page,
        select: {
          id: true,
          createdAt: true,
          advocateAccountId: true,
          status: true,
          qualifyingOrderId: true,
          advocatePointsAwarded: true,
          refereePointsAwarded: true,
          rewardedAt: true,
          friendRewardEmailedAt: true,
        },
      });
      return shopperProfilePage(
        { ...scope, section: "referrals" },
        rows,
        query.limit,
        (row) => ({
          id: row.id,
          createdAt: row.createdAt.toISOString(),
          role:
            row.advocateAccountId === account?.id
              ? ("advocate" as const)
              : ("friend" as const),
          status: row.status,
          qualifyingOrderId: row.qualifyingOrderId,
          pointsAwarded: (row.advocateAccountId === account?.id
            ? row.advocatePointsAwarded
            : row.refereePointsAwarded
          ).toString(),
          rewardedAt: row.rewardedAt?.toISOString() ?? null,
          friendRewardEmailedAt:
            row.friendRewardEmailedAt?.toISOString() ?? null,
        }),
      );
    }
    if (!account && query.section === "points")
      return {
        section: query.section,
        items: new Array<never>(),
        pagination: { limit: query.limit, hasMore: false, nextCursor: null },
      };
    if (query.section === "points" && account) {
      const rows = await tx.weleticPointsLedgerEntry.findMany({
        where: { storeId: store.id, accountId: account.id, ...sequence },
        ...page,
        orderBy: [{ sequenceNumber: "desc" }, { id: "desc" }],
        select: {
          id: true,
          createdAt: true,
          sequenceNumber: true,
          entryType: true,
          pointsDelta: true,
          pendingDelta: true,
          balanceAfter: true,
        },
      });
      return shopperProfilePage(
        { ...scope, section: "points" },
        rows,
        query.limit,
        (row) => ({
          ...row,
          createdAt: row.createdAt.toISOString(),
          pointsDelta: row.pointsDelta.toString(),
          pendingDelta: row.pendingDelta.toString(),
          balanceAfter: row.balanceAfter.toString(),
        }),
      );
    }
    const rows = await tx.weleticRewardRedemption.findMany({
      where: {
        AND: [
          shopperRewardOwnershipWhere({
            storeId: store.id,
            shopperId: shopper.id,
            accountId: account?.id ?? null,
          }),
          chronology,
        ],
      },
      ...page,
      select: {
        id: true,
        createdAt: true,
        rewardDefinitionId: true,
        status: true,
        artifactKind: true,
        pointsSpent: true,
        fulfillmentSource: true,
        usedAt: true,
        expiresAt: true,
      },
    });
    return shopperProfilePage(
      { ...scope, section: "rewards" },
      rows,
      query.limit,
      (row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
        pointsSpent: row.pointsSpent.toString(),
        usedAt: row.usedAt?.toISOString() ?? null,
        expiresAt: row.expiresAt?.toISOString() ?? null,
      }),
    );
  };
  return transaction ? read(transaction) : prisma.$transaction(read);
}

// Type-only consumers can share the JSON-safe contract without a runtime
// dependency on Prisma, Next.js authentication or either navigation adapter.
export type MerchantShopperProfile = Awaited<
  ReturnType<typeof readMerchantShopperProfile>
>;
