import { prisma } from "@/lib/prisma";
import type { InactivityExpiryPayload } from "@/lib/weletic/loyalty/outbox";
import {
  getPointsExpiryStageDate,
  isPointsExpiryEnabled,
  pointsExpiryDatesMatch,
} from "@/lib/weletic/loyalty/points-expiry-policy";
import {
  readShopperCommunicationSettings,
  ShopperEmailPausedError,
} from "@/lib/weletic/merchant-settings/communications";
import { assertShopifyStoreAcceptsOperationalWrites } from "@/lib/weletic/shopify/store-compliance-state";
import { getWeleticTransactionalEmailOptions } from "@/lib/weletic/transactional-email";
import { sendBatchEmail } from "@dub/email";
import PointsExpiryReminder, {
  getPointsExpiryCopy,
  resolvePointsExpiryLocale,
} from "@dub/email/templates/points-expiry-reminder";
import { WeleticPointsLedgerEntryType } from "@prisma/client";

const EXPLICIT_PARTICIPATION_TYPES: WeleticPointsLedgerEntryType[] = [
  WeleticPointsLedgerEntryType.EARN_ORDER,
  WeleticPointsLedgerEntryType.EARN_REFERRAL,
  WeleticPointsLedgerEntryType.EARN_BONUS,
  WeleticPointsLedgerEntryType.REDEEM_REWARD,
  WeleticPointsLedgerEntryType.TIER_BONUS,
];

export type PointsExpiryNotificationOutcome = "sent" | "stale" | "ineligible";

export async function sendPointsExpiryNotification({
  storeId,
  payload,
  expectedInstallationGeneration,
  now = new Date(),
}: {
  storeId: string;
  payload: InactivityExpiryPayload;
  expectedInstallationGeneration?: string | null;
  now?: Date;
}): Promise<PointsExpiryNotificationOutcome> {
  const stage = payload.stage;
  if (stage !== "warning" && stage !== "last_chance") return "stale";
  if (!payload.expiryAt) return "stale";

  await assertShopifyStoreAcceptsOperationalWrites({
    storeId,
    action: `loyalty_points_expiry_${stage}_notification`,
    expectedInstallationGeneration,
  });

  const account = await prisma.weleticLoyaltyAccount.findFirst({
    where: { id: payload.accountId, storeId, status: "active" },
    select: {
      id: true,
      cachedPointsBalance: true,
      nextExpiryDate: true,
      pointsExpiryPolicyVersion: true,
      shopper: {
        select: {
          email: true,
          firstName: true,
          locale: true,
          acceptsMarketing: true,
          ordersCount: true,
        },
      },
      program: {
        select: {
          name: true,
          status: true,
          killSwitchActive: true,
          pointNamePlural: true,
          pointsExpiryDays: true,
          pointsExpiryMonths: true,
          pointsExpiryWarningDays: true,
          pointsExpiryLastChanceDays: true,
          pointsExpiryWarningEnabled: true,
          pointsExpiryLastChanceEnabled: true,
          pointsExpiryPolicyAnchorAt: true,
          pointsExpiryPolicyVersion: true,
          activatedAt: true,
          createdAt: true,
        },
      },
      store: { select: { shopDomain: true } },
    },
  });

  if (
    !account ||
    account.cachedPointsBalance <= BigInt(0) ||
    !isPointsExpiryEnabled(account.program) ||
    account.pointsExpiryPolicyVersion !==
      account.program.pointsExpiryPolicyVersion ||
    payload.policyVersion !== account.program.pointsExpiryPolicyVersion ||
    !pointsExpiryDatesMatch(account.nextExpiryDate, payload.expiryAt)
  ) {
    return "stale";
  }

  const notificationEnabled =
    stage === "warning"
      ? account.program.pointsExpiryWarningEnabled
      : account.program.pointsExpiryLastChanceEnabled;
  if (!notificationEnabled) return "stale";

  const expiryAt = new Date(payload.expiryAt);
  const notificationAt = getPointsExpiryStageDate({
    policy: account.program,
    expiryAt,
    stage,
  });
  if (notificationAt.getTime() > now.getTime()) {
    throw new Error(
      `Points expiry ${stage} notification for ${account.id} ran before its configured threshold.`,
    );
  }

  const { shopper } = account;
  if (!shopper.email || !shopper.acceptsMarketing) return "ineligible";

  const explicitEntry =
    shopper.ordersCount > 0
      ? { id: "order_participation" }
      : await prisma.weleticPointsLedgerEntry.findFirst({
          where: {
            storeId,
            accountId: account.id,
            entryType: { in: EXPLICIT_PARTICIPATION_TYPES },
          },
          select: { id: true },
        });
  if (!explicitEntry) return "ineligible";
  const communications = await readShopperCommunicationSettings({
    storeId,
    legacyBrandName: account.program.name,
  });
  if (communications.paused) throw new ShopperEmailPausedError();

  const locale = resolvePointsExpiryLocale(shopper.locale);
  let expiryDate: string;
  try {
    expiryDate = new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    }).format(expiryAt);
  } catch {
    expiryDate = new Intl.DateTimeFormat("en", {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    }).format(expiryAt);
  }

  const accountUrl = `https://${account.store.shopDomain}/account`;
  const pointsBalance = `${account.cachedPointsBalance.toString()} ${account.program.pointNamePlural}`;
  const delivery = await sendBatchEmail(
    [
      {
        ...getWeleticTransactionalEmailOptions(),
        to: shopper.email,
        subject: getPointsExpiryCopy({
          locale,
          urgency: stage,
          pointsBalance,
          expiryDate,
          brandName: communications.brandName,
        }).subject,
        variant: "marketing",
        unsubscribeUrl: `${accountUrl}/profile`,
        react: PointsExpiryReminder({
          brandName: communications.brandName,
          logoUrl: communications.logoUrl,
          accentColor: communications.accentColor,
          customerFirstName: shopper.firstName,
          pointsBalance,
          expiryDate,
          accountUrl,
          urgency: stage,
          locale,
        }),
      },
    ],
    {
      idempotencyKey: `loyalty-expiry-${stage}-${account.id}-${expiryAt.toISOString()}`,
    },
  );

  if (delivery?.error || !delivery?.data) {
    throw new Error(
      `Failed to send points expiry ${stage} notification for ${account.id}: ${JSON.stringify(delivery?.error || "email provider unavailable")}`,
    );
  }
  return "sent";
}
