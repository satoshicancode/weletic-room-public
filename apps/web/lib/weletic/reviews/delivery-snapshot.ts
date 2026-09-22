import { decrypt, encrypt } from "@/lib/encryption";
import { z } from "zod";
import { ReviewError } from "./contracts";

const header = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const contextSchema = z
  .object({
    storeId: z.string().min(1).max(191),
    requestId: z.string().min(1).max(191),
    installationGeneration: z.string().min(1).max(64).nullable(),
    tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
    policyDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    recipient: z.string().email().max(320),
    // Recomputed from current provider configuration by the caller; never taken
    // from stored evidence as authority for a retry on another provider account.
    transportIdentity: z.string().regex(/^[a-f0-9]{64}$/),
    // Optional only for backward-compatible initial invitation evidence.
    // A reminder binds both its original invitation and distinct delivery row.
    reminderId: z
      .string()
      .regex(/^wrevrem_[A-Za-z0-9_-]{20}$/)
      .optional(),
  })
  .strict();

// Retain rendered provider content, not mutable React props or a current template.
export const reviewDeliveryContentSchema = z
  .object({
    to: z.string().email().max(320),
    from: header,
    replyTo: z.array(header).max(10).optional(),
    subject: header,
    html: z.string().min(1).max(500_000),
    text: z.string().max(100_000).optional(),
    headers: z
      .record(z.string().regex(/^[A-Za-z0-9-]{1,128}$/), header)
      .optional(),
  })
  .strict();

const evidenceSchema = z
  .object({
    version: z.literal(1),
    context: contextSchema,
    provider: z.enum(["resend", "smtp"]),
    providerKey: z.string().min(1).max(256),
    preparedAt: z.string().datetime(),
    content: reviewDeliveryContentSchema,
  })
  .strict();
export type ReviewDeliveryContext = z.infer<typeof contextSchema>;
export type ReviewDeliveryContent = z.infer<typeof reviewDeliveryContentSchema>;
export type ReviewDeliveryProvider = "resend" | "smtp";

const unavailable = () =>
  new ReviewError("unavailable", "Review delivery evidence is unavailable");
export const reviewDeliveryProviderKey = (
  requestId: string,
  reminderId?: string,
) =>
  reminderId
    ? `native-review-reminder:${reminderId}`
    : `native-review-request:${requestId}`;
const MAX_CIPHERTEXT = 1_000_000;
// Match the existing communications worker's conservative deduplication horizon.
const RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;

export function sealReviewDeliverySnapshot(input: {
  context: ReviewDeliveryContext;
  provider: ReviewDeliveryProvider;
  content: ReviewDeliveryContent;
  now: Date;
}) {
  try {
    const evidence = evidenceSchema.parse({
      version: 1,
      context: input.context,
      provider: input.provider,
      providerKey: reviewDeliveryProviderKey(
        input.context.requestId,
        input.context.reminderId,
      ),
      preparedAt: input.now.toISOString(),
      content: input.content,
    });
    if (evidence.content.to !== evidence.context.recipient) throw unavailable();
    const ciphertext = encrypt(JSON.stringify(evidence));
    if (ciphertext.length > MAX_CIPHERTEXT) throw unavailable();
    return ciphertext;
  } catch {
    throw unavailable();
  }
}

/** Retention is not send authority. Caller must recheck privacy, installation,
 * invitation eligibility and the winning lease before every actual dispatch.
 */
export function openReviewDeliverySnapshot(input: {
  ciphertext: string;
  context: ReviewDeliveryContext;
  provider: ReviewDeliveryProvider;
  now: Date;
  retry: boolean;
}) {
  try {
    if (typeof input.retry !== "boolean") throw unavailable();
    if (!input.ciphertext || input.ciphertext.length > MAX_CIPHERTEXT)
      throw unavailable();
    const expected = contextSchema.parse(input.context);
    const evidence = evidenceSchema.parse(
      JSON.parse(decrypt(input.ciphertext)),
    );
    if (
      JSON.stringify(evidence.context) !== JSON.stringify(expected) ||
      evidence.content.to !== expected.recipient ||
      evidence.provider !== input.provider ||
      evidence.providerKey !==
        reviewDeliveryProviderKey(expected.requestId, expected.reminderId)
    )
      throw unavailable();
    const age = input.now.getTime() - new Date(evidence.preparedAt).getTime();
    if (!Number.isFinite(age) || age < 0 || age >= RETRY_WINDOW_MS)
      throw unavailable();
    // SMTP offers no provider idempotency contract: an ambiguous attempt must be
    // reconciled, not retried automatically or switched to another provider.
    if (input.retry && evidence.provider === "smtp") throw unavailable();
    return {
      content: evidence.content,
      providerKey: evidence.providerKey,
      retryUntil: new Date(
        new Date(evidence.preparedAt).getTime() + RETRY_WINDOW_MS,
      ),
    };
  } catch {
    throw unavailable();
  }
}
