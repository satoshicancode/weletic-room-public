import { decrypt } from "@/lib/encryption";
import { prisma } from "@/lib/prisma";
import { readShopperCommunicationSettings } from "@/lib/weletic/merchant-settings/communications";
import {
  admitShopperDeliveryInTransaction,
  confirmShopperDeliveryInTransaction,
  shopperDeliveryContentDigest,
  ShopperDeliveryIneligibleError,
  ShopperDeliveryReconciliationRequiredError,
  type ShopperDeliveryIdentity,
} from "@/lib/weletic/merchant-settings/delivery-reservations";
import { withShopifyCustomerSettlementLocks } from "@/lib/weletic/shopify/customer-settlement-lock";
import { resend } from "@dub/email/resend";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hashReviewToken, ReviewError } from "./contracts";
import {
  openReviewDeliverySnapshot,
  reviewDeliveryProviderKey,
  sealReviewDeliverySnapshot,
} from "./delivery-snapshot";
import { reviewIncentiveDisclosure } from "./incentive-disclosure";
import {
  readReviewIncentivePolicySnapshot,
  reviewIncentivePolicyDigest,
} from "./incentive-policy";
import { reviewInvitationLocale } from "./invitation-email-content";
import {
  dispatchPreparedReviewEmail,
  prepareReviewEmail,
  reviewTransportIdentity,
} from "./prepared-email";
import {
  assertReviewPurchase,
  assertReviewPurchaseNotSuppressed,
  reviewRequestInclude,
} from "./purchase";
import {
  ReviewReminderDeferredError,
  ReviewReminderReconciliationError,
} from "./reminder-errors";
import { eraseReviewReminderMaterialInTransaction } from "./reminder-retention";
import { withReviewMutation } from "./transaction";

const inputSchema = z
  .object({
    storeId: z.string().min(1).max(191),
    requestId: z.string().min(1).max(191),
    reminderId: z.string().regex(/^wrevrem_[A-Za-z0-9_-]{20}$/),
    installationGeneration: z.string().min(1).max(64),
  })
  .strict();
const LEASE_MS = 120_000;
const MAX_ATTEMPTS = 5;

/** Internal worker entry point, not an unauthenticated API. The scheduler must
 * supply the saved generation; no current-generation fallback is permitted.
 * The customer lock also fences submissions, refunds and privacy erasure.
 */
export async function deliverReviewReminder(
  input: z.infer<typeof inputSchema>,
) {
  const { storeId, requestId, reminderId, installationGeneration } =
    inputSchema.parse(input);
  const identity = await prisma.weleticReviewReminder.findFirst({
    where: {
      id: reminderId,
      requestId,
      storeId,
      installationGeneration,
      request: { storeId },
    },
    select: {
      request: {
        select: {
          store: { select: { projectId: true } },
          shopper: { select: { shopifyCustomerId: true } },
        },
      },
    },
  });
  if (!identity?.request.shopper.shopifyCustomerId) return;
  return withShopifyCustomerSettlementLocks({
    workspaceId: identity.request.store.projectId,
    storeId,
    shopifyCustomerId: identity.request.shopper.shopifyCustomerId,
    onLocked: () => {
      throw new ReviewReminderDeferredError(new Date(Date.now() + 60_000));
    },
    fn: () =>
      deliverLocked({ storeId, requestId, reminderId, installationGeneration }),
  });
}

async function deliverLocked(input: z.infer<typeof inputSchema>) {
  const { storeId, requestId, reminderId, installationGeneration } = input;
  const leaseToken = randomUUID();
  const owned = { id: reminderId, requestId, storeId, installationGeneration };
  const claimed = await withReviewMutation(
    storeId,
    async (tx, generation) => {
      const now = new Date();
      const row = await tx.weleticReviewReminder.findFirst({
        where: { ...owned, request: { storeId } },
        include: { request: { include: reviewRequestInclude } },
      });
      if (!row) return null;
      if (row.status === "reconciliation")
        return { reconciliation: true as const };
      if (!["queued", "failed", "sending"].includes(row.status)) return null;
      const notBefore = Math.max(
        row.scheduledFor.getTime(),
        row.leaseExpiresAt?.getTime() ?? 0,
      );
      if (notBefore > now.getTime())
        throw new ReviewReminderDeferredError(new Date(notBefore));
      const request = row.request;
      const settings = await tx.weleticReviewSettings.findUnique({
        where: { storeId },
      });
      const reason =
        !settings?.enabled || !settings.requestEmailEnabled
          ? "settings_disabled"
          : request.expiresAt <= now
            ? "expired"
            : request.status === "submitted"
              ? "submitted"
              : request.status !== "sent" || !request.sentAt
                ? "purchase_ineligible"
                : null;
      if (reason) {
        await eraseReviewReminderMaterialInTransaction(tx, {
          storeId,
          requestIds: [request.id],
          reason,
        });
        return row.attempts > 0 ? { reconciliation: true as const } : null;
      }
      try {
        assertReviewPurchase(request, generation);
        await assertReviewPurchaseNotSuppressed(tx, request);
      } catch (error) {
        if (!(error instanceof ReviewError)) throw error;
        await eraseReviewReminderMaterialInTransaction(tx, {
          storeId,
          requestIds: [request.id],
          reason: "purchase_ineligible",
        });
        return row.attempts > 0 ? { reconciliation: true as const } : null;
      }
      const communications = await readShopperCommunicationSettings({
        storeId,
        tx,
      });
      if (communications.paused)
        throw new ReviewReminderDeferredError(
          new Date(now.getTime() + 5 * 60_000),
        );
      // A saved attempt without evidence is not permission to compose a new send.
      // Retain a private reconciliation record, never silently reset attempts.
      const reconcile = async () => {
        await tx.weleticReviewReminder.updateMany({
          where: owned,
          data: {
            status: "reconciliation",
            outcomeReason: "delivery_evidence_unavailable",
            leaseToken: null,
            leaseExpiresAt: null,
            settledAt: now,
          },
        });
        const pending = await tx.weleticReviewReminder.count({
          where: {
            storeId,
            requestId: request.id,
            id: { not: reminderId },
            status: { in: ["queued", "sending", "failed"] },
          },
        });
        if (!pending)
          await tx.weleticReviewRequest.updateMany({
            where: { id: request.id, storeId, installationGeneration },
            data: { encryptedReminderToken: null },
          });
        return { reconciliation: true as const };
      };
      if (
        row.attempts >= MAX_ATTEMPTS ||
        !request.encryptedReminderToken ||
        !request.shopper.email ||
        (row.attempts > 0 && !row.encryptedDeliverySnapshot)
      )
        return reconcile();
      let token: string;
      try {
        token = decrypt(request.encryptedReminderToken);
        if (
          !/^[A-Za-z0-9_-]{43}$/.test(token) ||
          hashReviewToken(token) !== request.tokenHash
        )
          return reconcile();
      } catch {
        return reconcile();
      }
      const policy = await readReviewIncentivePolicySnapshot(
        tx,
        storeId,
        request.incentivePolicyId,
      );
      const provider = resend ? "resend" : "smtp";
      let transportIdentity: string;
      try {
        transportIdentity = reviewTransportIdentity(provider);
      } catch (error) {
        if (row.attempts > 0) return reconcile();
        throw error;
      }
      const context = {
        storeId,
        requestId: request.id,
        reminderId,
        installationGeneration: generation,
        tokenHash: hashReviewToken(token),
        policyDigest: policy ? reviewIncentivePolicyDigest(policy) : null,
        recipient: request.shopper.email,
        transportIdentity,
      };
      let ciphertext = row.encryptedDeliverySnapshot;
      let prepared;
      let retryUntil: Date;
      if (ciphertext) {
        try {
          const reopened = openReviewDeliverySnapshot({
            ciphertext,
            context,
            provider,
            now,
            retry: true,
          });
          retryUntil = reopened.retryUntil;
          prepared = {
            provider,
            content: reopened.content,
            transportIdentity: context.transportIdentity,
          };
        } catch {
          return reconcile();
        }
      } else {
        const store = await tx.weleticShopifyStore.findUniqueOrThrow({
          where: { id: storeId },
          select: { shopDomain: true },
        });
        if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(store.shopDomain))
          throw new ReviewError("unavailable", "Invalid storefront domain");
        const branding = await tx.weleticLoyaltyProgram.findUnique({
          where: { storeId },
          select: { name: true },
        });
        const language = reviewInvitationLocale(request.shopper.locale);
        prepared = await prepareReviewEmail({
          email: request.shopper.email,
          language,
          productTitle: request.product.title,
          brandName:
            communications.configuredBrandName ?? branding?.name ?? "Weletic",
          logoUrl: communications.logoUrl,
          accentColor: communications.accentColor,
          disclosure: reviewIncentiveDisclosure(policy)?.[language] ?? [],
          url: `https://${store.shopDomain}/apps/weletic/reviews/write?locale=${language}#token=${token}`,
        });
        if (
          prepared.provider !== provider ||
          prepared.transportIdentity !== context.transportIdentity
        )
          throw new ReviewError(
            "unavailable",
            "Review delivery configuration changed",
          );
        retryUntil = new Date(now.getTime() + 23 * 60 * 60_000);
        ciphertext = sealReviewDeliverySnapshot({
          context,
          provider,
          content: prepared.content,
          now,
        });
      }
      const reserved = await tx.weleticReviewReminder.updateMany({
        where: {
          ...owned,
          status: row.status,
          attempts: row.attempts,
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
        },
        data: {
          status: "sending",
          attempts: { increment: 1 },
          leaseToken,
          leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
          encryptedDeliverySnapshot: ciphertext,
        },
      });
      if (reserved.count !== 1)
        throw new ReviewError("conflict", "Review reminder already reserved");
      const deliveryIdentity: ShopperDeliveryIdentity = {
        storeId,
        installationGeneration,
        producer: "review_reminder",
        sourceKey: reviewDeliveryProviderKey(request.id, reminderId),
        provider,
        contentDigest: shopperDeliveryContentDigest({
          content: prepared.content,
          transportIdentity: prepared.transportIdentity,
        }),
        email: request.shopper.email,
        shopifyCustomerId: request.shopper.shopifyCustomerId,
        expiresAt: request.expiresAt,
        retryUntil,
      };
      // Commit immutable source evidence and budget admission together. A lost
      // commit acknowledgement must leave both recoverable or neither persisted.
      let admission;
      try {
        admission = await admitShopperDeliveryInTransaction({
          tx,
          input: deliveryIdentity,
          priorAttempt: row.attempts > 0,
        });
      } catch (error) {
        if (
          !(error instanceof ShopperDeliveryIneligibleError) &&
          !(error instanceof ShopperDeliveryReconciliationRequiredError)
        )
          throw error;
        // These typed errors occur before budget writes. Commit containment
        // instead of leaving an active source behind a terminal queue record.
        const reconciliation =
          row.attempts > 0 ||
          error instanceof ShopperDeliveryReconciliationRequiredError;
        await tx.weleticReviewReminder.updateMany({
          where: {
            ...owned,
            status: "sending",
            leaseToken,
            attempts: row.attempts + 1,
          },
          data: {
            status: reconciliation ? "reconciliation" : "cancelled",
            attempts: row.attempts,
            encryptedDeliverySnapshot: row.encryptedDeliverySnapshot,
            leaseToken: null,
            leaseExpiresAt: null,
            settledAt: now,
            outcomeReason: "shared_delivery_ineligible",
          },
        });
        const pending = await tx.weleticReviewReminder.count({
          where: {
            storeId,
            requestId,
            status: { in: ["queued", "sending", "failed"] },
          },
        });
        if (!pending)
          await tx.weleticReviewRequest.updateMany({
            where: { id: requestId, storeId, installationGeneration },
            data: { encryptedReminderToken: null },
          });
        return reconciliation ? { reconciliation: true as const } : null;
      }
      return {
        ...prepared,
        admission,
        deliveryIdentity,
        requestId: request.id,
        attempt: row.attempts + 1,
        providerKey: reviewDeliveryProviderKey(request.id, reminderId),
      };
    },
    installationGeneration,
  );
  if (!claimed) return;
  if ("reconciliation" in claimed)
    throw new ReviewReminderReconciliationError();

  const winning = { ...owned, status: "sending", leaseToken };
  let enteredProvider = false;
  let renewal: Promise<unknown> | null = null;
  const heartbeat = setInterval(() => {
    if (renewal) return;
    renewal = prisma.weleticReviewReminder
      .updateMany({
        where: winning,
        data: { leaseExpiresAt: new Date(Date.now() + LEASE_MS) },
      })
      .catch(() => undefined)
      .finally(() => {
        renewal = null;
      });
  }, 20_000);
  try {
    // Recheck current installation and settings, not just the lease. External
    // transport cannot be atomic with a later merchant disable; receipts below
    // therefore preserve confirmed outcomes even if cancellation wins in flight.
    const allowed = await withReviewMutation(
      storeId,
      async (tx) => {
        const settings = await tx.weleticReviewSettings.findUnique({
          where: { storeId },
        });
        if (
          !settings?.enabled ||
          !settings.requestEmailEnabled ||
          (await readShopperCommunicationSettings({ storeId, tx })).paused
        )
          return null;
        const stillOwned =
          (await tx.weleticReviewReminder.count({
            where: {
              ...winning,
              leaseExpiresAt: { gt: new Date() },
              request: {
                storeId,
                status: "sent",
                installationGeneration,
                expiresAt: { gt: new Date() },
              },
            },
          })) === 1;
        if (!stillOwned) return null;
        return true;
      },
      installationGeneration,
    );
    if (!allowed)
      throw new ReviewError("conflict", "Review reminder lease lost");
    enteredProvider = true;
    if (claimed.admission.status !== "sent")
      await dispatchPreparedReviewEmail({
        provider: claimed.provider,
        content: claimed.content,
        transportIdentity: claimed.transportIdentity,
        providerKey: claimed.providerKey,
      });
    // A receipt is evidence, not a new operational writer. No new job or award
    // is created, including after generation retirement or settings cancellation.
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM WeleticShopifyStore WHERE id = ${storeId} FOR UPDATE`;
      const receipt = await tx.weleticReviewReminder.updateMany({
        where: {
          ...owned,
          attempts: claimed.attempt,
          OR: [
            { status: "sending", leaseToken },
            { status: "cancelled", leaseToken: null },
            { status: "reconciliation", leaseToken: null },
          ],
        },
        data: {
          status: "sent",
          sentAt: new Date(),
          settledAt: new Date(),
          outcomeReason: "provider_confirmed",
          leaseToken: null,
          leaseExpiresAt: null,
          encryptedDeliverySnapshot: null,
        },
      });
      if (receipt.count !== 1)
        throw new ReviewError(
          "conflict",
          "Review reminder receipt requires reconciliation",
        );
      await confirmShopperDeliveryInTransaction(tx, claimed.deliveryIdentity);
      const unsettled = await tx.weleticReviewReminder.count({
        where: {
          storeId,
          requestId: claimed.requestId,
          status: { in: ["queued", "sending", "failed"] },
        },
      });
      if (!unsettled)
        await tx.weleticReviewRequest.updateMany({
          where: { id: claimed.requestId, storeId, installationGeneration },
          data: { encryptedReminderToken: null },
        });
    });
  } catch (error) {
    if (!enteredProvider) {
      // Admission already committed with this attempt. Retain its original
      // evidence even when transport has not started: an arbitrary database
      // error is not proof that the earlier commit was rolled back.
      const retryAt = new Date(Date.now() + 5 * 60_000);
      const terminal = claimed.provider === "smtp";
      await prisma.weleticReviewReminder.updateMany({
        where: { ...winning, attempts: claimed.attempt },
        data: {
          status: terminal ? "reconciliation" : "failed",
          leaseToken: null,
          leaseExpiresAt: terminal ? null : retryAt,
          outcomeReason: "deferred_after_admission",
          ...(terminal ? { settledAt: new Date() } : {}),
        },
      });
      if (terminal) {
        await prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM WeleticShopifyStore WHERE id = ${storeId} FOR UPDATE`;
          const pending = await tx.weleticReviewReminder.count({
            where: {
              storeId,
              requestId,
              status: { in: ["queued", "sending", "failed"] },
            },
          });
          if (!pending)
            await tx.weleticReviewRequest.updateMany({
              where: { id: requestId, storeId, installationGeneration },
              data: { encryptedReminderToken: null },
            });
        });
        throw new ReviewReminderReconciliationError();
      }
      throw new ReviewReminderDeferredError(retryAt);
    }

    const terminal =
      claimed.provider === "smtp" || claimed.attempt >= MAX_ATTEMPTS;
    await prisma.weleticReviewReminder.updateMany({
      where: winning,
      data: {
        status: terminal ? "reconciliation" : "failed",
        leaseToken: null,
        // This field is a not-before fence for failed rows as well as a live lease;
        // the immutable original schedule is never moved by a retry.
        leaseExpiresAt: terminal
          ? null
          : new Date(
              Date.now() + Math.min(60 * 60_000, 60_000 * 2 ** claimed.attempt),
            ),
        settledAt: terminal ? new Date() : null,
        outcomeReason: "delivery_outcome_unconfirmed",
      },
    });
    // Settings cancellation can win while the provider is in flight. Its
    // cancellation receipt is not evidence that the email was never sent.
    if (enteredProvider)
      await prisma.weleticReviewReminder.updateMany({
        where: {
          ...owned,
          status: "cancelled",
          attempts: claimed.attempt,
          leaseToken: null,
        },
        data: {
          status: "reconciliation",
          settledAt: new Date(),
          outcomeReason: "cancelled_during_unconfirmed_delivery",
        },
      });
    if (terminal) {
      // Terminal ambiguity keeps its encrypted provider evidence for bounded
      // reconciliation, but must not retain a reusable parent invitation token
      // after the final pending reminder has settled.
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM WeleticShopifyStore WHERE id = ${storeId} FOR UPDATE`;
        const pending = await tx.weleticReviewReminder.count({
          where: {
            storeId,
            requestId: claimed.requestId,
            status: { in: ["queued", "sending", "failed"] },
          },
        });
        if (!pending)
          await tx.weleticReviewRequest.updateMany({
            where: { id: claimed.requestId, storeId, installationGeneration },
            data: { encryptedReminderToken: null },
          });
      });
      throw new ReviewReminderReconciliationError();
    }
    throw new ReviewError(
      "unavailable",
      "Review reminder delivery requires retry or reconciliation",
    );
  } finally {
    clearInterval(heartbeat);
    if (renewal) await renewal;
  }
}
