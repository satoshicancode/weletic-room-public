import { prisma } from "@/lib/prisma";
import {
  readShopperCommunicationSettings,
  ShopperEmailPausedError,
} from "@/lib/weletic/merchant-settings/communications";
import { assertShopifyStoreAcceptsOperationalWrites } from "@/lib/weletic/shopify/store-compliance-state";
import { getWeleticTransactionalEmailOptions } from "@/lib/weletic/transactional-email";
import { prepareResendEmail, sendPreparedResendEmail } from "@dub/email";
import LoyaltyPointsEarned from "@dub/email/templates/loyalty-points-earned";
import { resolvePointsExpiryLocale } from "@dub/email/templates/points-expiry-reminder";
import {
  CommunicationDeliveryIneligibleError,
  communicationDeliveryProviderKey,
  CommunicationDeliveryRecipientChangedError,
  retainCommunicationDeliveryRequest,
  type CommunicationDeliveryClaim,
} from "./communication-delivery-snapshot";
import { renderLoyaltyCommunicationText } from "./communications-contract";
import { snapshotLoyaltyCommunicationPolicy } from "./communications-service";
import type { LoyaltyMaintenancePermit } from "./maintenance-write-fence";
import { loyaltyCommunicationJobPayloadSchema } from "./points-communication-contract";
import { rewardCommunicationValue } from "./reward-communication-value";
import { isCurrentRewardRedemption } from "./reward-redeemed-communication-source";
import { hasShopifyCustomerRedactionTombstone } from "./shopper-privacy";
import { isCurrentVipAchievement } from "./vip-achievement-communication-source";

/** Called only under the outbox customer's settlement lock, including send. */
export async function sendPointsEarnedNotification({
  claim,
  loyaltyMaintenancePermit,
}: {
  claim: CommunicationDeliveryClaim;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}): Promise<"sent" | "ineligible"> {
  const parsed = loyaltyCommunicationJobPayloadSchema.safeParse(
    claim.candidate.payload,
  );
  if (
    !parsed.success ||
    claim.candidate.jobType !== "LOYALTY_COMMUNICATION" ||
    parsed.data.storeId !== claim.candidate.storeId
  )
    throw new Error("Loyalty communication job unavailable");
  const event = parsed.data;
  await assertShopifyStoreAcceptsOperationalWrites({
    storeId: event.storeId,
    action: "loyalty_points_earned_notification",
    expectedInstallationGeneration: event.installationGeneration,
    loyaltyMaintenancePermit,
  });
  const account = await prisma.weleticLoyaltyAccount.findFirst({
    where: {
      id: event.accountId,
      storeId: event.storeId,
      programId: event.programId,
      status: "active",
    },
    select: {
      metadata: true,
      currentTierId: true,
      shopper: {
        select: {
          email: true,
          firstName: true,
          locale: true,
          acceptsMarketing: true,
        },
      },
      program: {
        select: {
          id: true,
          metadata: true,
          name: true,
          status: true,
          killSwitchActive: true,
          pointNamePlural: true,
        },
      },
      store: { select: { shopDomain: true } },
    },
  });
  if (
    !account ||
    hasShopifyCustomerRedactionTombstone(account.metadata) ||
    account.program.id !== event.programId ||
    account.program.status !== "active" ||
    account.program.killSwitchActive ||
    !account.shopper.email ||
    !account.shopper.acceptsMarketing ||
    !event.policy.enabled
  )
    return "ineligible";
  const currentPolicy = snapshotLoyaltyCommunicationPolicy({
    storeId: event.storeId,
    programId: event.programId,
    metadata: account.program.metadata,
    journey: event.journey,
  });
  if (!currentPolicy?.policy.enabled) return "ineligible";
  if (event.source === "vip_threshold_promotion") {
    if (
      !(await isCurrentVipAchievement({
        db: prisma,
        event,
        currentTierId: account.currentTierId,
      }))
    )
      return "ineligible";
  } else if (event.source === "reward_issuance_confirmed") {
    if (!(await isCurrentRewardRedemption({ db: prisma, event })))
      return "ineligible";
  } else {
    // Source ledger is required participation evidence. Never infer it from a
    // cached balance, customer import or an unverified event alone.
    const ledger = await prisma.weleticPointsLedgerEntry.findFirst({
      where: {
        id: event.ledgerEntryId,
        storeId: event.storeId,
        accountId: event.accountId,
        ...(event.source === "birthday_points_available"
          ? {
              entryType: "EARN_BONUS",
              referenceType: "BIRTHDAY_REWARD",
              referenceId: String(event.calendarYear),
              idempotencyKey: `birthday:${event.accountId}:${event.calendarYear}`,
            }
          : event.source === "signup_points_available"
            ? {
                entryType: "EARN_BONUS",
                referenceType: "SIGNUP_BONUS",
                referenceId: event.accountId,
              }
            : {
                entryType: "EARN_ORDER",
                referenceType: "COMMERCE_ORDER",
                referenceId: event.orderId,
              }),
      },
      select: { grantId: true, pointsDelta: true, createdAt: true },
    });
    if (
      !ledger ||
      ledger.pointsDelta.toString() !== event.ledgerPoints ||
      ledger.createdAt.toISOString() !== event.occurredAt
    )
      return "ineligible";
    if (event.source !== "purchase_points_available" && ledger.grantId)
      return "ineligible";
    if (event.source === "purchase_points_available") {
      if (!ledger.grantId) return "ineligible";
      const grant = await prisma.weleticLoyaltyEarnGrant.findFirst({
        where: {
          id: ledger.grantId,
          storeId: event.storeId,
          accountId: event.accountId,
          programId: event.programId,
          orderId: event.orderId,
        },
        select: { status: true, settledPoints: true },
      });
      if (
        !grant ||
        !["settled", "partially_reversed"].includes(grant.status) ||
        grant.settledPoints < BigInt(event.points)
      )
        return "ineligible";
      const order = await prisma.weleticCommerceOrder.findFirst({
        where: { id: event.orderId, storeId: event.storeId },
        select: { status: true },
      });
      if (!order || !["paid", "partially_refunded"].includes(order.status))
        return "ineligible";
    }
  }
  const communications = await readShopperCommunicationSettings({
    storeId: event.storeId,
    legacyBrandName: account.program.name,
  });
  if (communications.paused) throw new ShopperEmailPausedError();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(account.store.shopDomain))
    throw new Error("Loyalty communication destination unavailable");
  const accountUrl = `https://${account.store.shopDomain}/account`;
  let request;
  try {
    request = await retainCommunicationDeliveryRequest({
      claim,
      accountId: event.accountId,
      expectedInstallationGeneration: event.installationGeneration,
      recipientEmail: account.shopper.email,
      loyaltyMaintenancePermit,
      prepare: async () => {
        const locale = resolvePointsExpiryLocale(account.shopper.locale);
        const values = {
          brand_name: communications.brandName,
          customer_first_name: account.shopper.firstName ?? "",
          points:
            event.source === "vip_threshold_promotion" ||
            event.source === "reward_issuance_confirmed"
              ? ""
              : event.points,
          tier_name:
            event.source === "vip_threshold_promotion" ? event.toTier.name : "",
          points_label: account.program.pointNamePlural,
          reward_name:
            event.journey === "birthday"
              ? `${event.points} ${account.program.pointNamePlural}`
              : event.source === "reward_issuance_confirmed"
                ? event.reward.name
                : "",
          reward_value:
            event.source === "reward_issuance_confirmed"
              ? rewardCommunicationValue(event.reward, locale)
              : "",
        };
        const template = event.policy.templates[locale];
        const render = (text: string) =>
          renderLoyaltyCommunicationText(text, event.journey, values);
        const content = {
          subject: render(template.subject),
          heading: render(template.heading),
          body: render(template.body),
          actionLabel: render(template.actionLabel),
        };
        const sender = getWeleticTransactionalEmailOptions();
        if (!sender.from)
          throw new Error("Approved loyalty sender unavailable");
        const prepared = await prepareResendEmail({
          ...sender,
          to: account.shopper.email!,
          subject: content.subject,
          variant: "marketing",
          unsubscribeUrl: `${accountUrl}/profile`,
          react: LoyaltyPointsEarned({
            ...communications,
            accountUrl,
            locale,
            content,
          }),
        });
        return {
          to: typeof prepared.to === "string" ? prepared.to : prepared.to[0],
          from: prepared.from,
          subject: prepared.subject,
          html: prepared.html,
          ...(prepared.replyTo
            ? {
                replyTo: Array.isArray(prepared.replyTo)
                  ? prepared.replyTo
                  : [prepared.replyTo],
              }
            : {}),
          ...(prepared.headers ? { headers: prepared.headers } : {}),
        };
      },
    });
  } catch (error) {
    if (
      error instanceof CommunicationDeliveryRecipientChangedError ||
      error instanceof CommunicationDeliveryIneligibleError
    )
      return "ineligible";
    throw error;
  }
  const deliveryFailure = () =>
    new Error("Loyalty communication email provider unavailable");
  const result = await sendPreparedResendEmail(
    request,
    communicationDeliveryProviderKey(claim),
  ).catch(() => {
    throw deliveryFailure();
  });
  if (!result?.data || result.error) throw deliveryFailure();
  return "sent";
}
