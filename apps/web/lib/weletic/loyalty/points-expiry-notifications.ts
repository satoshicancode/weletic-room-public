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
import {
  prepareResendEmail,
  sendBatchEmail,
  sendPreparedResendEmail,
} from "@dub/email";
import type { ResendEmailOptions } from "@dub/email/resend/types";
import PointsExpiryReminder, {
  getPointsExpiryCopy,
  resolvePointsExpiryLocale,
} from "@dub/email/templates/points-expiry-reminder";
import { WeleticPointsLedgerEntryType } from "@prisma/client";
import {
  loyaltyExpiryCommunicationSnapshotSchema,
  renderLoyaltyCommunicationText,
} from "./communications-contract";
import { snapshotLoyaltyCommunicationPolicy } from "./communications-service";
import {
  ExpiryDeliveryRecipientChangedError,
  retainExpiryDeliveryRequest,
  type ExpiryDeliveryClaim,
} from "./expiry-delivery-snapshot";
import type { LoyaltyMaintenancePermit } from "./maintenance-write-fence";

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
  deliveryClaim,
  loyaltyMaintenancePermit,
  now = new Date(),
}: {
  storeId: string;
  payload: InactivityExpiryPayload;
  expectedInstallationGeneration?: string | null;
  deliveryClaim?: ExpiryDeliveryClaim;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
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
          id: true,
          metadata: true,
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

  const journey = stage === "warning" ? "points_warning" : "points_last_chance";
  const snapshot =
    payload.communicationSnapshot == null
      ? null
      : loyaltyExpiryCommunicationSnapshotSchema.parse(
          payload.communicationSnapshot,
        );
  if (
    snapshot &&
    (snapshot.storeId !== storeId ||
      snapshot.programId !== account.program.id ||
      snapshot.policy.journey !== journey)
  ) {
    throw new Error("Expiry communication snapshot ownership mismatch");
  }
  const currentPolicy = snapshotLoyaltyCommunicationPolicy({
    storeId,
    programId: account.program.id,
    metadata: account.program.metadata ?? null,
    journey,
  });
  // A current opt-out suppresses even older queued work. Content edits never
  // replace a queued snapshot, and historical jobs keep their legacy template.
  if (
    currentPolicy?.policy.enabled === false ||
    snapshot?.policy.enabled === false
  )
    return "ineligible";

  const expiryAt = new Date(payload.expiryAt);
  const notificationAt = getPointsExpiryStageDate({
    policy: account.program,
    expiryAt,
    stage,
  });
  if (notificationAt.getTime() > now.getTime()) {
    throw new Error(
      `Points expiry ${stage} notification ran before its configured threshold.`,
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

  const buildEmail = (): ResendEmailOptions => {
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
    const values = {
      brand_name: communications.brandName,
      customer_first_name: shopper.firstName ?? "",
      points: account.cachedPointsBalance.toString(),
      points_label: account.program.pointNamePlural,
      expiry_date: expiryDate,
    };
    const customContent = snapshot
      ? (Object.fromEntries(
          Object.entries(snapshot.policy.templates[locale]).map(
            ([field, text]) => [
              field,
              renderLoyaltyCommunicationText(text, journey, values),
            ],
          ),
        ) as {
          subject: string;
          heading: string;
          body: string;
          actionLabel: string;
        })
      : undefined;
    return {
      ...getWeleticTransactionalEmailOptions(),
      to: shopper.email!,
      subject:
        customContent?.subject ??
        getPointsExpiryCopy({
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
        customContent,
      }),
    };
  };
  const deliveryFailure = () =>
    new Error(
      `Failed to send points expiry ${stage}: email provider unavailable`,
    );
  if (
    snapshot &&
    (!deliveryClaim || deliveryClaim.candidate.storeId !== storeId)
  )
    throw new Error("Expiry delivery requires a worker claim");
  const idempotencyKey = snapshot
    ? `loyalty-expiry-job-${deliveryClaim!.candidate.id}`
    : `loyalty-expiry-${stage}-${account.id}-${expiryAt.toISOString()}`;
  let delivery;
  if (snapshot) {
    if (!deliveryClaim || deliveryClaim.candidate.storeId !== storeId)
      throw new Error("Expiry delivery requires a worker claim");
    let request;
    try {
      request = await retainExpiryDeliveryRequest({
        claim: deliveryClaim,
        accountId: account.id,
        expectedInstallationGeneration: expectedInstallationGeneration ?? null,
        recipientEmail: shopper.email,
        idempotencyKey,
        loyaltyMaintenancePermit,
        prepare: async () => {
          const prepared = await prepareResendEmail(buildEmail());
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
      if (error instanceof ExpiryDeliveryRecipientChangedError)
        return "ineligible";
      throw error;
    }
    delivery = await sendPreparedResendEmail(request, idempotencyKey).catch(
      () => {
        throw deliveryFailure();
      },
    );
  } else {
    delivery = await sendBatchEmail([buildEmail()], { idempotencyKey }).catch(
      () => {
        // Provider exceptions may contain recipient addresses or request details.
        // Do not persist those in outbox lastError, logs, or an Error cause.
        throw deliveryFailure();
      },
    );
  }

  if (delivery?.error || !delivery?.data) {
    throw deliveryFailure();
  }
  return "sent";
}
