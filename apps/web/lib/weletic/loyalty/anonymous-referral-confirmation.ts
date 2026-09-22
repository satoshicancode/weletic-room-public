import { decrypt, encrypt } from "@/lib/encryption";
import { prisma } from "@/lib/prisma";
import {
  admitShopperDeliveryInTransaction,
  confirmShopperDeliveryInTransaction,
  shopperDeliveryContentDigest,
  ShopperDeliveryDeferredError,
  ShopperDeliveryReconciliationRequiredError,
  type ShopperDeliveryIdentity,
} from "@/lib/weletic/merchant-settings/delivery-reservations";
import {
  createAllShopifyDerivedPrivacyDigests,
  hasShopifyCustomerPrivacyTombstone,
} from "@/lib/weletic/shopify/privacy-identity";
import { assertShopifyStoreAcceptsOperationalWrites } from "@/lib/weletic/shopify/store-compliance-state";
import { sendPreparedResendEmail } from "@dub/email";
import { Prisma, type WeleticLoyaltyReferral } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { anonymousConfirmationJobSchema } from "./anonymous-confirmation-contract";
import { communicationDeliveryRequestSchema } from "./communication-delivery-snapshot";
import type { ExpiryDeliveryClaim } from "./expiry-delivery-snapshot";
import { isLoyaltyMaintenanceBlockedError } from "./maintenance-write-fence";
import { enqueueOutboxJobFromProgramTransaction } from "./outbox";
import { lockLoyaltyProgramRow } from "./program-write-fence";
import { readReferralPrivacySnapshot } from "./referral-privacy-snapshot";
import { hasShopifyCustomerRedactionTombstone } from "./shopper-privacy";

export const ANONYMOUS_CONFIRMATION_WINDOW_MS = 23 * 60 * 60 * 1000;
export const anonymousConfirmationLocaleSchema = z.enum(["en", "ja", "vi"]);
const originSchema = z
  .object({
    version: z.literal(1),
    storeId: z.string().min(1),
    programId: z.string().min(1),
    referralId: z.string().min(1),
    installationGeneration: z.string().min(1).max(64),
    friendEmailDigest: z.string().min(1),
    rewardDefinitionId: z.string().min(1),
    discountCode: z.string().min(1),
    rewardDigest: z.string().regex(/^[a-f0-9]{64}$/),
    locale: anonymousConfirmationLocaleSchema,
  })
  .strict();
const retainedSchema = z
  .object({
    version: z.literal(1),
    originDigest: z.string(),
    remoteDiscountId: z.string(),
    preparedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    providerKey: z.string().min(1),
    ciphertext: z.string().min(1).max(1_000_000),
  })
  .strict();
type Origin = z.infer<typeof originSchema>;
const envelopeSchema = retainedSchema
  .omit({ ciphertext: true })
  .extend({ request: communicationDeliveryRequestSchema })
  .strict();
const unavailable = () =>
  new Error("Anonymous referral confirmation unavailable");
const metadataOf = (value: Prisma.JsonValue | null): Prisma.JsonObject =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Prisma.JsonObject)
    : {};
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, canonical(child)]),
    );
  return value;
}
export const anonymousConfirmationDigest = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
export function createAnonymousConfirmationOrigin(
  input: Omit<Origin, "version" | "rewardDigest"> & { rewardSnapshot: unknown },
) {
  const { rewardSnapshot, ...fields } = input;
  return originSchema.parse({
    ...fields,
    version: 1,
    rewardDigest: anonymousConfirmationDigest(rewardSnapshot),
  });
}

async function authorize(
  tx: Prisma.TransactionClient,
  storeId: string,
  referralId: string,
  email: string,
  expectedOrigin: Origin,
  allowPausedPreparation = false,
) {
  await assertShopifyStoreAcceptsOperationalWrites({
    tx,
    storeId,
    action: "anonymous_referral_confirmation",
    expectedInstallationGeneration: expectedOrigin.installationGeneration,
  });
  const program = await lockLoyaltyProgramRow({ tx, storeId, mode: "active" });
  await tx.$queryRaw`SELECT id FROM WeleticLoyaltyReferral WHERE id = ${referralId} AND storeId = ${storeId} FOR UPDATE`;
  const row = await tx.weleticLoyaltyReferral.findFirst({
    where: { id: referralId, storeId },
  });
  if (!row) throw unavailable();
  const metadata = metadataOf(row.metadata);
  const origin = originSchema.parse(metadata.anonymousConfirmationOrigin);
  const now = new Date();
  if (
    anonymousConfirmationDigest(origin) !==
      anonymousConfirmationDigest(expectedOrigin) ||
    origin.storeId !== storeId ||
    origin.referralId !== referralId ||
    origin.programId !== program.id ||
    origin.friendEmailDigest !== row.friendEmailDigest ||
    origin.rewardDefinitionId !== row.friendRewardDefinitionId ||
    origin.discountCode !== row.friendShopifyDiscountCode ||
    origin.rewardDigest !==
      anonymousConfirmationDigest(metadata.friendRewardSnapshot) ||
    !row.friendRewardProvisionedAt ||
    !row.friendShopifyDiscountId ||
    !["pending", "qualified", "rewarded"].includes(row.status) ||
    (row.friendRewardExpiresAt && row.friendRewardExpiresAt <= now) ||
    !createAllShopifyDerivedPrivacyDigests({
      purpose: "referral_email",
      values: [storeId, email],
    }).includes(origin.friendEmailDigest) ||
    !readReferralPrivacySnapshot({
      value: metadata.friendPrivacySnapshot,
      storeId,
      referralId,
      friendEmailDigest: row.friendEmailDigest,
      now,
    }) ||
    (await hasShopifyCustomerPrivacyTombstone({ storeId, email, now, tx }))
  )
    throw unavailable();
  const advocate = await tx.weleticLoyaltyAccount.findFirst({
    where: {
      id: row.advocateAccountId,
      storeId,
      programId: program.id,
      status: "active",
    },
    select: { id: true, metadata: true },
  });
  const referee = row.refereeAccountId
    ? await tx.weleticLoyaltyAccount.findFirst({
        where: {
          id: row.refereeAccountId,
          storeId,
          programId: program.id,
          status: "active",
        },
        select: { id: true, metadata: true },
      })
    : null;
  const settings = await tx.weleticMerchantSettings.findUnique({
    where: { storeId },
    select: { shopperEmailPaused: true },
  });
  if (
    !advocate ||
    hasShopifyCustomerRedactionTombstone(advocate.metadata) ||
    (row.refereeAccountId &&
      (!referee || hasShopifyCustomerRedactionTombstone(referee.metadata))) ||
    (row.friendRewardExpiresAt && row.friendRewardExpiresAt <= new Date())
  )
    throw unavailable();
  if (!allowPausedPreparation && settings?.shopperEmailPaused)
    throw new ShopperDeliveryDeferredError(
      new Date(Date.now() + 60_000),
      "paused",
    );
  return { row, metadata, origin };
}

function readRequest(
  row: WeleticLoyaltyReferral,
  origin: Origin,
  email: string,
  allowUnattempted = false,
) {
  const saved = retainedSchema.parse(
    metadataOf(row.metadata).anonymousConfirmationDelivery,
  );
  const preparedAt = new Date(saved.preparedAt).getTime();
  const expiresAt = new Date(saved.expiresAt).getTime();
  if (
    saved.originDigest !== anonymousConfirmationDigest(origin) ||
    saved.remoteDiscountId !== row.friendShopifyDiscountId ||
    saved.providerKey !== `loyalty-referral-friend-${row.id}` ||
    preparedAt > Date.now() ||
    expiresAt !== preparedAt + ANONYMOUS_CONFIRMATION_WINDOW_MS ||
    (!(
      allowUnattempted &&
      row.friendEmailDeliveryAttempts === 0 &&
      metadataOf(row.metadata).anonymousConfirmationQueued === true
    ) &&
      Date.now() >= expiresAt) ||
    (row.friendRewardExpiresAt &&
      row.friendRewardExpiresAt.getTime() <= Date.now())
  )
    throw unavailable();
  const { request, ...authenticatedBinding } = envelopeSchema.parse(
    JSON.parse(decrypt(saved.ciphertext)),
  );
  const { ciphertext: _ciphertext, ...outerBinding } = saved;
  if (
    anonymousConfirmationDigest(authenticatedBinding) !==
    anonymousConfirmationDigest(outerBinding)
  )
    throw unavailable();
  if (request.to !== email) throw unavailable();
  return { saved, request };
}

/** Requested service confirmation only: never infer an account or marketing consent.
 * Preparation commits before provider I/O. Dispatch is never transaction-retried.
 * Store/program/referral locks serialize dispatch admission with lifecycle writes.
 */
export async function sendAnonymousReferralConfirmation({
  storeId,
  referralId,
  email,
  prepare,
  deliveryClaim,
}: {
  storeId: string;
  referralId: string;
  email: string;
  deliveryClaim?: ExpiryDeliveryClaim;
  prepare: (
    locale: Origin["locale"],
    source: {
      discountCode: string;
      rewardName: string;
      expiresAt: Date | null;
    },
  ) => Promise<unknown>;
}) {
  const initial = await prisma.weleticLoyaltyReferral.findFirst({
    where: { id: referralId, storeId },
  });
  const parsed = originSchema.safeParse(
    metadataOf(initial?.metadata ?? null).anonymousConfirmationOrigin,
  );
  if (!initial || !parsed.success)
    return { emailSent: false, state: "unavailable" as const };
  const origin = parsed.data;
  const owner = randomUUID();
  try {
    const acquired = await prisma.$transaction(
      async (tx) => {
        const { row, metadata } = await authorize(
          tx,
          storeId,
          referralId,
          email,
          origin,
          true,
        );
        if (deliveryClaim) {
          const job = deliveryClaim.candidate;
          const payload = anonymousConfirmationJobSchema.parse(job.payload);
          const owned = await tx.weleticLoyaltyOutboxJob.findFirst({
            where: {
              id: job.id,
              storeId,
              jobType: "ANONYMOUS_REFERRAL_EMAIL",
              status: "processing",
              lockedBy: deliveryClaim.ownerToken,
              lockedAt: deliveryClaim.claimedAt,
              attempts: deliveryClaim.attempt,
              payload: { equals: job.payload as Prisma.InputJsonValue },
            },
            select: { id: true },
          });
          if (
            !owned ||
            payload.referralId !== referralId ||
            payload.installationGeneration !== origin.installationGeneration
          )
            throw unavailable();
        }
        if (row.friendRewardEmailedAt) return "sent" as const;
        if (metadata.anonymousConfirmationTerminal)
          return "unavailable" as const;
        if (row.friendEmailLeaseExpiresAt > new Date()) return "busy" as const;
        let retained = metadata.anonymousConfirmationDelivery;
        if (retained !== undefined) readRequest(row, origin, email, true);
        else {
          // Missing prepared bytes after an attempted send must never be recreated.
          if (row.friendEmailDeliveryAttempts > 0) throw unavailable();
          const snapshot = z
            .object({
              rewardDefinition: z.object({ name: z.string().min(1) }),
              expiresAt: z.string().datetime().nullable(),
            })
            .parse(metadata.friendRewardSnapshot);
          if (
            (row.friendRewardExpiresAt?.toISOString() ?? null) !==
            snapshot.expiresAt
          )
            throw unavailable();
          const request = communicationDeliveryRequestSchema.parse(
            await prepare(origin.locale, {
              discountCode: origin.discountCode,
              rewardName: snapshot.rewardDefinition.name,
              expiresAt: row.friendRewardExpiresAt,
            }),
          );
          if (request.to !== email) throw unavailable();
          const now = new Date();
          if (row.friendRewardExpiresAt && row.friendRewardExpiresAt <= now)
            throw unavailable();
          const envelope = envelopeSchema.parse({
            version: 1,
            originDigest: anonymousConfirmationDigest(origin),
            remoteDiscountId: row.friendShopifyDiscountId,
            preparedAt: now.toISOString(),
            expiresAt: new Date(
              now.getTime() + ANONYMOUS_CONFIRMATION_WINDOW_MS,
            ).toISOString(),
            providerKey: `loyalty-referral-friend-${referralId}`,
            request,
          });
          const { request: _request, ...binding } = envelope;
          retained = retainedSchema.parse({
            ...binding,
            ciphertext: encrypt(JSON.stringify(envelope)),
          });
        }
        let envelope = readRequest(
          {
            ...row,
            metadata: {
              ...metadata,
              anonymousConfirmationQueued: true,
              anonymousConfirmationDelivery: retained,
            } as Prisma.JsonObject,
          },
          origin,
          email,
          true,
        );
        if (row.friendEmailDeliveryAttempts === 0) {
          // Proven-unsent preparation may wait beyond a provider retry window.
          // Anchor the transport deadline only when first attempting admission;
          // retain exact rendered bytes and the original coupon expiry.
          const preparedAt = new Date().toISOString();
          const { ciphertext: _ciphertext, ...binding } = envelope.saved;
          const next = {
            ...binding,
            preparedAt,
            expiresAt: new Date(
              new Date(preparedAt).getTime() + ANONYMOUS_CONFIRMATION_WINDOW_MS,
            ).toISOString(),
            request: envelope.request,
          };
          retained = {
            ...binding,
            preparedAt: next.preparedAt,
            expiresAt: next.expiresAt,
            ciphertext: encrypt(JSON.stringify(next)),
          };
          envelope = {
            saved: retainedSchema.parse(retained),
            request: envelope.request,
          };
        }
        const delivery = confirmationDeliveryIdentity(
          storeId,
          origin,
          row,
          envelope,
        );
        let deferred: ShopperDeliveryDeferredError | undefined;
        try {
          const admitted = await admitShopperDeliveryInTransaction({
            tx,
            input: delivery,
            priorAttempt: row.friendEmailDeliveryAttempts > 0,
          });
          if (admitted.status === "sent") return "sent" as const;
        } catch (error) {
          if (!(error instanceof ShopperDeliveryDeferredError)) throw error;
          deferred = error;
        }
        await enqueueOutboxJobFromProgramTransaction({
          tx,
          storeId,
          jobType: "ANONYMOUS_REFERRAL_EMAIL",
          payload: {
            version: 1,
            referralId,
            installationGeneration: origin.installationGeneration,
          },
          idempotencyKey: `anonymous-referral-email:${referralId}:${origin.installationGeneration}`,
          scheduledFor: deferred?.retryAt ?? new Date(),
        });
        await tx.weleticLoyaltyReferral.update({
          where: { id: row.id },
          data: {
            metadata: {
              ...metadata,
              anonymousConfirmationQueued: true,
              anonymousConfirmationDelivery: retained,
            } as Prisma.InputJsonObject,
            ...(deferred
              ? {}
              : {
                  friendEmailLeaseToken: owner,
                  friendEmailLeaseReservedAt: new Date(),
                  friendEmailLeaseExpiresAt: new Date(Date.now() + 60_000),
                  friendEmailDeliveryAttempts: { increment: 1 },
                }),
            friendEmailLastError: null,
          },
        });
        return deferred
          ? { state: "deferred" as const, retryAt: deferred.retryAt }
          : ("acquired" as const);
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 15_000,
      },
    );
    if (typeof acquired === "object") return { emailSent: false, ...acquired };
    if (acquired !== "acquired")
      return { emailSent: acquired === "sent", state: acquired };
    return await prisma.$transaction(
      async (tx) => {
        const { row, metadata } = await authorize(
          tx,
          storeId,
          referralId,
          email,
          origin,
        );
        if (
          row.friendEmailLeaseToken !== owner ||
          row.friendEmailLeaseExpiresAt <= new Date() ||
          row.friendRewardEmailedAt
        )
          throw unavailable();
        const { saved, request } = readRequest(row, origin, email);
        const delivery = confirmationDeliveryIdentity(storeId, origin, row, {
          saved,
          request,
        });
        await admitShopperDeliveryInTransaction({
          tx,
          input: delivery,
          priorAttempt: true,
        });
        // A timeout is ambiguous, not cancellation of a provider-accepted email.
        // Retain the exact request/key; never retry this transaction callback.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const response = await Promise.race([
          sendPreparedResendEmail(request, saved.providerKey),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(unavailable()), 8_000);
          }),
        ]).finally(() => {
          if (timer) clearTimeout(timer);
        });
        const acknowledgments = response?.data?.data;
        if (
          response?.error ||
          !Array.isArray(acknowledgments) ||
          acknowledgments.length !== 1 ||
          !acknowledgments[0]?.id
        )
          throw unavailable();
        const { anonymousConfirmationDelivery: _removed, ...remaining } =
          metadata;
        const finalized = await tx.weleticLoyaltyReferral.updateMany({
          where: {
            id: referralId,
            storeId,
            friendEmailLeaseToken: owner,
            friendRewardEmailedAt: null,
          },
          data: {
            metadata: {
              ...remaining,
              anonymousConfirmationTerminal: "sent",
            } as Prisma.InputJsonObject,
            friendRewardEmailedAt: new Date(),
            friendEmailLeaseToken: null,
            friendEmailLeaseReservedAt: null,
            friendEmailLeaseExpiresAt: new Date(),
            friendEmailLastError: null,
          },
        });
        if (finalized.count !== 1) throw unavailable();
        await confirmShopperDeliveryInTransaction(tx, delivery);
        return { emailSent: true, state: "sent" as const };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 15_000,
      },
    );
  } catch (error) {
    // A transport failure may be ambiguous. Keep original bytes/key, but never
    // mutate a new owner's lease or repopulate metadata removed by erasure.
    await prisma.$executeRaw`
      UPDATE WeleticLoyaltyReferral
      SET friendEmailLeaseToken = NULL, friendEmailLeaseReservedAt = NULL,
          friendEmailLeaseExpiresAt = ${new Date()},
          friendEmailLastError = 'Referral confirmation requires retry or reconciliation',
          updatedAt = UTC_TIMESTAMP(3)
      WHERE id = ${referralId} AND storeId = ${storeId}
        AND friendEmailLeaseToken = ${owner} AND friendRewardEmailedAt IS NULL
    `;
    if (error instanceof ShopperDeliveryDeferredError)
      return {
        emailSent: false,
        state: "deferred" as const,
        retryAt: error.retryAt,
      };
    if (
      deliveryClaim &&
      (error instanceof ShopperDeliveryReconciliationRequiredError ||
        isLoyaltyMaintenanceBlockedError(error))
    )
      throw error;
    return { emailSent: false, state: "unavailable" as const };
  }
}

function confirmationDeliveryIdentity(
  storeId: string,
  origin: Origin,
  row: WeleticLoyaltyReferral,
  envelope: ReturnType<typeof readRequest>,
): ShopperDeliveryIdentity {
  return {
    storeId,
    installationGeneration: origin.installationGeneration,
    producer: "referral_confirmation",
    sourceKey: envelope.saved.providerKey,
    provider: "resend",
    contentDigest: shopperDeliveryContentDigest(envelope.request),
    email: envelope.request.to,
    shopifyCustomerId: null,
    expiresAt: row.friendRewardExpiresAt,
    retryUntil: new Date(envelope.saved.expiresAt),
  };
}

/** Resume only a persisted user-requested confirmation; never collect history. */
export async function resumeAnonymousReferralConfirmation(
  claim: ExpiryDeliveryClaim,
) {
  const parsed = anonymousConfirmationJobSchema.safeParse(
    claim.candidate.payload,
  );
  if (!parsed.success || claim.candidate.jobType !== "ANONYMOUS_REFERRAL_EMAIL")
    throw new ShopperDeliveryReconciliationRequiredError();
  const row = await prisma.weleticLoyaltyReferral.findFirst({
    where: { id: parsed.data.referralId, storeId: claim.candidate.storeId },
  });
  if (!row || row.friendRewardEmailedAt) return;
  const metadata = metadataOf(row.metadata);
  const origin = originSchema.safeParse(metadata.anonymousConfirmationOrigin);
  if (!origin.success || metadata.anonymousConfirmationTerminal) return;
  if (origin.data.installationGeneration !== parsed.data.installationGeneration)
    throw new ShopperDeliveryReconciliationRequiredError();
  let email: string;
  try {
    const retained = retainedSchema.parse(
      metadata.anonymousConfirmationDelivery,
    );
    email = envelopeSchema.parse(JSON.parse(decrypt(retained.ciphertext)))
      .request.to;
    readRequest(row, origin.data, email, true);
  } catch {
    throw new ShopperDeliveryReconciliationRequiredError();
  }
  const result = await sendAnonymousReferralConfirmation({
    storeId: row.storeId,
    referralId: row.id,
    email,
    deliveryClaim: claim,
    prepare: async () => {
      throw new ShopperDeliveryReconciliationRequiredError();
    },
  });
  if (result.state === "deferred")
    throw new ShopperDeliveryDeferredError(result.retryAt, "policy_window");
  if (result.state === "busy")
    throw new ShopperDeliveryDeferredError(
      new Date(Date.now() + 60_000),
      "source_lease",
    );
  if (!result.emailSent) throw unavailable();
}
