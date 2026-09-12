import { decrypt, encrypt } from "@/lib/encryption";
import { Prisma, type WeleticLoyaltyOutboxJob } from "@prisma/client";
import { z } from "zod";
import type { LoyaltyMaintenancePermit } from "./maintenance-write-fence";
import {
  assertActiveLoyaltyAccountForMutation,
  withActiveStoreLoyaltyMutation,
} from "./merchant-write-fence";

// Persist the final provider request, not React props that can render differently
// after a release. This internal evidence must never enter a merchant response.
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
    installationGeneration: z.string().min(1).max(64).nullable(),
    idempotencyKey: z.string().min(1).max(256),
    recipientEmail: z.string().email(),
    preparedAt: z.string().datetime(),
    request: requestSchema,
  })
  .strict();

export type ExpiryDeliveryRequest = z.infer<typeof requestSchema>;
export type ExpiryDeliveryClaim = {
  candidate: WeleticLoyaltyOutboxJob;
  ownerToken: string;
  claimedAt: Date;
  attempt: number;
};

const unavailable = () => new Error("Expiry delivery evidence unavailable");
export class ExpiryDeliveryRecipientChangedError extends Error {
  constructor() {
    super("Expiry delivery recipient changed");
  }
}
export class ExpiryDeliveryReconciliationRequiredError extends Error {
  constructor() {
    super("Expiry delivery retry window elapsed; reconciliation required");
  }
}

// Resend retains keys for 24 hours. Leave one hour of margin; never turn an
// ambiguous old attempt into a fresh send after provider deduplication expires.
const SAFE_RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;

/** Called inside the worker's customer-settlement lock. This function performs
 * no delivery. Its transaction fences installation, account and worker ownership
 * before retaining a request. The caller must reuse the returned request exactly.
 */
export async function retainExpiryDeliveryRequest({
  claim,
  accountId,
  expectedInstallationGeneration,
  idempotencyKey,
  recipientEmail,
  prepare,
  wallClockNow = new Date(),
  loyaltyMaintenancePermit,
}: {
  claim: ExpiryDeliveryClaim;
  accountId: string;
  expectedInstallationGeneration: string | null;
  idempotencyKey: string;
  recipientEmail: string;
  prepare: () => Promise<ExpiryDeliveryRequest>;
  wallClockNow?: Date;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}): Promise<ExpiryDeliveryRequest> {
  const job = claim.candidate;
  const payload = job.payload;
  if (
    job.jobType !== "INACTIVITY_EXPIRY" ||
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    payload.accountId !== accountId ||
    (payload.stage !== "warning" && payload.stage !== "last_chance") ||
    (payload.installationGeneration ?? null) !==
      expectedInstallationGeneration ||
    !claim.ownerToken ||
    !Number.isFinite(wallClockNow.getTime()) ||
    !Number.isFinite(claim.claimedAt.getTime()) ||
    !Number.isSafeInteger(claim.attempt) ||
    claim.attempt < 1
  )
    throw unavailable();

  const result = await withActiveStoreLoyaltyMutation({
    storeId: job.storeId,
    action: "loyalty_expiry_delivery_evidence",
    expectedInstallationGeneration,
    loyaltyMaintenancePermit,
    operation: async (tx) => {
      await assertActiveLoyaltyAccountForMutation({
        tx,
        storeId: job.storeId,
        accountId,
      });
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

      if (payload.expiryDeliverySnapshot !== undefined) {
        try {
          if (
            typeof payload.expiryDeliverySnapshot !== "string" ||
            payload.expiryDeliverySnapshot.length > 1_000_000
          )
            throw unavailable();
          const evidence = evidenceSchema.parse(
            JSON.parse(decrypt(payload.expiryDeliverySnapshot)),
          );
          if (
            evidence.storeId !== job.storeId ||
            evidence.accountId !== accountId ||
            evidence.jobId !== job.id ||
            evidence.installationGeneration !==
              expectedInstallationGeneration ||
            evidence.idempotencyKey !== idempotencyKey
          )
            throw unavailable();
          if (evidence.recipientEmail !== recipientEmail)
            throw new ExpiryDeliveryRecipientChangedError();
          const age =
            wallClockNow.getTime() - new Date(evidence.preparedAt).getTime();
          if (age < 0 || age >= SAFE_RETRY_WINDOW_MS)
            throw new ExpiryDeliveryReconciliationRequiredError();
          return { request: evidence.request, payload };
        } catch (error) {
          if (error instanceof ExpiryDeliveryRecipientChangedError) throw error;
          if (error instanceof ExpiryDeliveryReconciliationRequiredError)
            throw error;
          // Never retain decrypt/parser errors: they can contain customer input.
          throw unavailable();
        }
      }

      let ciphertext: string;
      let request: ExpiryDeliveryRequest;
      try {
        request = requestSchema.parse(await prepare());
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
      } catch {
        throw unavailable();
      }
      const nextPayload = { ...payload, expiryDeliverySnapshot: ciphertext };
      const updated = await tx.weleticLoyaltyOutboxJob.updateMany({
        where: { ...where, updatedAt: current.updatedAt },
        data: { payload: nextPayload as Prisma.InputJsonObject },
      });
      if (updated.count !== 1) throw unavailable();
      return { request, payload: nextPayload };
    },
  });
  // Completion/retry transitions compare the full payload. Update only after
  // transaction commit; never weaken their claim fence to allow this write.
  claim.candidate.payload = result.payload;
  return result.request;
}
