import { decrypt, encrypt } from "@/lib/encryption";
import { z } from "zod";
import { ReviewError } from "./contracts";
import {
  reviewDeliveryContentSchema,
  type ReviewDeliveryContent,
  type ReviewDeliveryProvider,
} from "./delivery-snapshot";

const contextSchema = z
  .object({
    storeId: z.string().min(1).max(191),
    requestId: z.string().regex(/^wstorereq_[A-Za-z0-9_-]{1,191}$/),
    installationGeneration: z.string().min(1).max(64),
    policyDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    recipient: z.string().email().max(320),
    transportIdentity: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type StoreReviewDeliveryContext = z.infer<typeof contextSchema>;

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

const unavailable = () =>
  new ReviewError("unavailable", "Store-review delivery evidence unavailable");
const MAX_CIPHERTEXT = 1_000_000;
const RETRY_WINDOW_MS = 23 * 60 * 60_000;

export const storeReviewDeliveryProviderKey = (requestId: string) =>
  `native-store-review-request:${requestId}`;

export function sealStoreReviewDeliverySnapshot(input: {
  context: StoreReviewDeliveryContext;
  provider: ReviewDeliveryProvider;
  content: ReviewDeliveryContent;
  now: Date;
}) {
  try {
    const evidence = evidenceSchema.parse({
      version: 1,
      context: input.context,
      provider: input.provider,
      providerKey: storeReviewDeliveryProviderKey(input.context.requestId),
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

/** A snapshot preserves one provider request across retries. Callers must
 * separately recheck the live purchase, privacy, installation and winning lease.
 */
export function openStoreReviewDeliverySnapshot(input: {
  ciphertext: string;
  context: StoreReviewDeliveryContext;
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
        storeReviewDeliveryProviderKey(expected.requestId)
    )
      throw unavailable();
    const age = input.now.getTime() - new Date(evidence.preparedAt).getTime();
    if (!Number.isFinite(age) || age < 0 || age >= RETRY_WINDOW_MS)
      throw unavailable();
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
