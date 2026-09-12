import { decrypt, encrypt } from "@/lib/encryption";
import { ShopperEmailPausedError } from "@/lib/weletic/merchant-settings/communications";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { snapshotLoyaltyCommunicationPolicy } from "./communications-service";
import type { ExpiryDeliveryClaim } from "./expiry-delivery-snapshot";
import type { LoyaltyMaintenancePermit } from "./maintenance-write-fence";
import {
  assertActiveLoyaltyAccountForMutation,
  withActiveStoreLoyaltyMutation,
} from "./merchant-write-fence";
import { loyaltyCommunicationJobPayloadSchema } from "./points-communication-contract";
import { isCurrentReferralBenefit } from "./referral-benefit-communication-source";
import { isCurrentRewardExpiryReceipt } from "./reward-expiry-communication-source";
import { isCurrentRewardRedemption } from "./reward-redeemed-communication-source";
import { isCurrentVipAchievement } from "./vip-achievement-communication-source";

const requestSchema = z
  .object({
    to: z.string().email(),
    from: z.string().min(1).max(320),
    replyTo: z.array(z.string().min(1).max(320)).max(10).optional(),
    subject: z.string().max(4096),
    html: z.string().min(1).max(500_000),
    headers: z.record(z.string().max(128), z.string().max(2048)).optional(),
  })
  .strict();
const evidenceSchema = z
  .object({
    version: z.literal(1),
    provider: z.literal("resend"),
    storeId: z.string().min(1),
    accountId: z.string().min(1),
    jobId: z.string().min(1),
    installationGeneration: z.string().min(1).max(64),
    idempotencyKey: z.string().min(1).max(256),
    recipientEmail: z.string().email(),
    preparedAt: z.string().datetime(),
    request: requestSchema,
  })
  .strict();
export type CommunicationDeliveryRequest = z.infer<typeof requestSchema>;
export type CommunicationDeliveryClaim = ExpiryDeliveryClaim;
export class CommunicationDeliveryIneligibleError extends Error {
  constructor() {
    super("Loyalty communication no longer eligible");
  }
}
export class CommunicationDeliveryRecipientChangedError extends Error {
  constructor() {
    super("Loyalty communication recipient changed");
  }
}
export class CommunicationDeliveryReconciliationRequiredError extends Error {
  constructor() {
    super(
      "Loyalty communication retry window elapsed; reconciliation required",
    );
  }
}
const unavailable = () =>
  new Error("Loyalty communication delivery evidence unavailable");
const SAFE_RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;

/** No provider I/O. Caller holds customer-settlement locks through final send.
 * Recheck consent, policy, refunds and pause before calling on every attempt.
 * Retain the final rendered request; retries must never rerender stored content.
 */
export async function retainCommunicationDeliveryRequest({
  claim,
  accountId,
  expectedInstallationGeneration,
  recipientEmail,
  prepare,
  wallClockNow: suppliedWallClockNow,
  loyaltyMaintenancePermit,
}: {
  claim: CommunicationDeliveryClaim;
  accountId: string;
  expectedInstallationGeneration: string;
  recipientEmail: string;
  prepare: () => Promise<CommunicationDeliveryRequest>;
  wallClockNow?: Date;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}): Promise<CommunicationDeliveryRequest> {
  const wallClockNow = suppliedWallClockNow ?? new Date();
  const job = claim.candidate;
  const parsed = loyaltyCommunicationJobPayloadSchema.safeParse(job.payload);
  if (
    job.jobType !== "LOYALTY_COMMUNICATION" ||
    !parsed.success ||
    parsed.data.storeId !== job.storeId ||
    parsed.data.accountId !== accountId ||
    parsed.data.installationGeneration !== expectedInstallationGeneration ||
    !claim.ownerToken ||
    !Number.isFinite(wallClockNow.getTime()) ||
    !Number.isFinite(claim.claimedAt.getTime()) ||
    !Number.isSafeInteger(claim.attempt) ||
    claim.attempt < 1
  )
    throw unavailable();
  // Preserve the original JSON for full-payload CAS, not a normalized copy.
  const payload = job.payload as Prisma.JsonObject;
  const idempotencyKey = communicationDeliveryProviderKey(claim);
  const result = await withActiveStoreLoyaltyMutation({
    storeId: job.storeId,
    action: "loyalty_communication_delivery_evidence",
    expectedInstallationGeneration,
    loyaltyMaintenancePermit,
    operation: async (tx) => {
      await assertActiveLoyaltyAccountForMutation({
        tx,
        storeId: job.storeId,
        accountId,
      });
      // Store -> program locks acquired by the mutation fence serialize this
      // admission with merchant changes. Recheck first sends AND retries here.
      const program = await tx.weleticLoyaltyProgram.findUnique({
        where: { storeId: job.storeId },
        select: {
          id: true,
          status: true,
          killSwitchActive: true,
          metadata: true,
        },
      });
      if (
        !program ||
        program.id !== parsed.data.programId ||
        program.status !== "active" ||
        program.killSwitchActive ||
        !parsed.data.policy.enabled ||
        !snapshotLoyaltyCommunicationPolicy({
          storeId: job.storeId,
          programId: program.id,
          metadata: program.metadata,
          journey: parsed.data.journey,
        })?.policy.enabled
      )
        throw new CommunicationDeliveryIneligibleError();
      const settings = await tx.weleticMerchantSettings.findUnique({
        where: { storeId: job.storeId },
        select: { shopperEmailPaused: true },
      });
      if (settings?.shopperEmailPaused) throw new ShopperEmailPausedError();
      const recipient = await tx.weleticLoyaltyAccount.findFirst({
        where: {
          id: accountId,
          storeId: job.storeId,
          programId: program.id,
          status: "active",
        },
        select: {
          currentTierId: true,
          shopper: { select: { email: true, acceptsMarketing: true } },
        },
      });
      if (!recipient?.shopper.acceptsMarketing)
        throw new CommunicationDeliveryIneligibleError();
      if (recipient.shopper.email !== recipientEmail)
        throw new CommunicationDeliveryRecipientChangedError();
      if (
        parsed.data.source === "vip_threshold_promotion" &&
        !(await isCurrentVipAchievement({
          db: tx,
          event: parsed.data,
          currentTierId: recipient.currentTierId,
        }))
      )
        throw new CommunicationDeliveryIneligibleError();
      if (
        parsed.data.source === "reward_expiry_due" &&
        !(await isCurrentRewardExpiryReceipt({
          db: tx,
          event: parsed.data,
          now: suppliedWallClockNow ?? new Date(),
        }))
      )
        throw new CommunicationDeliveryIneligibleError();
      if (
        parsed.data.source === "reward_issuance_confirmed" &&
        !(await isCurrentRewardRedemption({
          db: tx,
          event: parsed.data,
          now: wallClockNow,
        }))
      )
        throw new CommunicationDeliveryIneligibleError();
      if (
        parsed.data.source === "referral_benefit_confirmed" &&
        !(await isCurrentReferralBenefit({
          db: tx,
          event: parsed.data,
          now: wallClockNow,
        }))
      )
        throw new CommunicationDeliveryIneligibleError();
      const where = {
        id: job.id,
        storeId: job.storeId,
        jobType: job.jobType,
        status: "processing" as const,
        lockedBy: claim.ownerToken,
        lockedAt: claim.claimedAt,
        attempts: claim.attempt,
        payload: { equals: payload as Prisma.InputJsonValue },
      };
      const current = await tx.weleticLoyaltyOutboxJob.findFirst({
        where,
        select: { id: true, updatedAt: true },
      });
      if (!current) throw unavailable();
      if (parsed.data.communicationDeliverySnapshot !== undefined) {
        try {
          const evidence = evidenceSchema.parse(
            JSON.parse(decrypt(parsed.data.communicationDeliverySnapshot)),
          );
          if (
            evidence.storeId !== job.storeId ||
            evidence.accountId !== accountId ||
            evidence.jobId !== job.id ||
            evidence.installationGeneration !==
              expectedInstallationGeneration ||
            evidence.idempotencyKey !== idempotencyKey ||
            evidence.request.to !== evidence.recipientEmail
          )
            throw unavailable();
          if (evidence.recipientEmail !== recipientEmail)
            throw new CommunicationDeliveryRecipientChangedError();
          const age =
            wallClockNow.getTime() - new Date(evidence.preparedAt).getTime();
          if (age < 0 || age >= SAFE_RETRY_WINDOW_MS)
            throw new CommunicationDeliveryReconciliationRequiredError();
          return { request: evidence.request, payload };
        } catch (error) {
          if (
            error instanceof CommunicationDeliveryRecipientChangedError ||
            error instanceof CommunicationDeliveryReconciliationRequiredError
          )
            throw error;
          throw unavailable();
        }
      }
      let request: CommunicationDeliveryRequest;
      let ciphertext: string;
      try {
        request = requestSchema.parse(await prepare());
        if (
          parsed.data.source === "reward_expiry_due" &&
          (suppliedWallClockNow ?? new Date()).getTime() >=
            new Date(parsed.data.expiresAt).getTime()
        )
          throw new CommunicationDeliveryIneligibleError();
        if (request.to !== recipientEmail) throw unavailable();
        const evidence = evidenceSchema.parse({
          version: 1,
          provider: "resend",
          storeId: job.storeId,
          accountId,
          jobId: job.id,
          installationGeneration: expectedInstallationGeneration,
          idempotencyKey,
          recipientEmail,
          preparedAt: wallClockNow.toISOString(),
          request,
        });
        ciphertext = encrypt(JSON.stringify(evidence));
        if (ciphertext.length > 1_000_000) throw unavailable();
      } catch (error) {
        if (error instanceof CommunicationDeliveryIneligibleError) throw error;
        throw unavailable();
      }
      const nextPayload = {
        ...payload,
        communicationDeliverySnapshot: ciphertext,
      };
      const updated = await tx.weleticLoyaltyOutboxJob.updateMany({
        where: { ...where, updatedAt: current.updatedAt },
        data: { payload: nextPayload as Prisma.InputJsonObject },
      });
      if (updated.count !== 1) throw unavailable();
      return { request, payload: nextPayload };
    },
  });
  // The completion transition owns the same full-payload claim fence.
  claim.candidate.payload = result.payload;
  return result.request;
}

export function communicationDeliveryProviderKey(
  claim: CommunicationDeliveryClaim,
) {
  return `loyalty-communication-job-${claim.candidate.id}`;
}
