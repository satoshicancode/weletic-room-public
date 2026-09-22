import { getWeleticTransactionalEmailOptions } from "@/lib/weletic/transactional-email";
import { prepareResendEmail, sendPreparedResendEmail } from "@dub/email";
import {
  isResendCredentialCurrent,
  resend,
  resendCredentialIdentity,
} from "@dub/email/resend";
import {
  prepareNodeMailerEmail,
  sendViaNodeMailer,
} from "@dub/email/send-via-nodemailer";
import { createHash } from "node:crypto";
import { ReviewError } from "./contracts";
import {
  reviewDeliveryContentSchema,
  type ReviewDeliveryContent,
  type ReviewDeliveryProvider,
} from "./delivery-snapshot";
import { renderReviewInvitationEmail } from "./invitation-email-content";

const unavailable = () =>
  new ReviewError("unavailable", "Review email transport unavailable");

/** Private identity only, retained inside encrypted evidence, never logged.
 * Credential rotation conservatively blocks retries even within one account.
 */
export function reviewTransportIdentity(provider: ReviewDeliveryProvider) {
  const env = process.env;
  if (provider === "resend") {
    if (!resend || !resendCredentialIdentity || !isResendCredentialCurrent())
      throw unavailable();
    return resendCredentialIdentity;
  }
  if (provider === "smtp" && (!env.SMTP_HOST || !env.SMTP_PORT))
    throw unavailable();
  if (provider !== "smtp") throw unavailable();
  return createHash("sha256")
    .update(
      JSON.stringify([
        "review-delivery-smtp-v1",
        env.SMTP_HOST,
        env.SMTP_PORT,
        env.SMTP_USER ?? null,
        env.SMTP_PASSWORD ?? null,
      ]),
    )
    .digest("hex");
}

/** Rendering only: no provider send. The caller must durably retain the result
 * before dispatch, and reopen that evidence rather than preparing again on retry.
 */
export async function prepareReviewEmail(
  input: Parameters<typeof renderReviewInvitationEmail>[0] & { email: string },
): Promise<{
  provider: ReviewDeliveryProvider;
  content: ReviewDeliveryContent;
  transportIdentity: string;
}> {
  try {
    const options = {
      ...getWeleticTransactionalEmailOptions(),
      ...renderReviewInvitationEmail(input),
      to: input.email,
    };
    if (resend) {
      const prepared = await prepareResendEmail(options);
      // Do not bind a shopper's invitation to preview recipient redirection.
      if (prepared.to !== input.email) throw unavailable();
      const content = reviewDeliveryContentSchema.parse({
        to: prepared.to,
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
      });
      return {
        provider: "resend",
        content,
        transportIdentity: reviewTransportIdentity("resend"),
      };
    }
    if (!process.env.SMTP_HOST || !process.env.SMTP_PORT) throw unavailable();
    const content = reviewDeliveryContentSchema.parse(
      await prepareNodeMailerEmail(options),
    );
    return {
      provider: "smtp",
      content,
      transportIdentity: reviewTransportIdentity("smtp"),
    };
  } catch {
    throw unavailable();
  }
}

/** Caller supplies freshly authorized, reopened evidence. This boundary never
 * falls back to a different provider or rereads sender/template configuration.
 * SMTP retries must already have been rejected by openReviewDeliverySnapshot.
 */
export async function dispatchPreparedReviewEmail(input: {
  provider: ReviewDeliveryProvider;
  content: ReviewDeliveryContent;
  providerKey: string;
  transportIdentity: string;
}) {
  try {
    const content = reviewDeliveryContentSchema.parse(input.content);
    if (input.transportIdentity !== reviewTransportIdentity(input.provider))
      throw unavailable();
    if (
      !/^native-review-request:[A-Za-z0-9_-]{1,191}$/.test(input.providerKey) &&
      !/^native-review-reminder:wrevrem_[A-Za-z0-9_-]{20}$/.test(
        input.providerKey,
      )
    )
      throw unavailable();
    if (input.provider === "resend") {
      const result = await sendPreparedResendEmail(content, input.providerKey);
      if (result.error || !result.data) throw unavailable();
      return;
    }
    if (
      input.provider !== "smtp" ||
      !process.env.SMTP_HOST ||
      !process.env.SMTP_PORT
    )
      throw unavailable();
    // SMTP does not provide an idempotency contract. This is a single authorized
    // attempt; any failure after entering the transport is ambiguous.
    await sendViaNodeMailer(content);
  } catch {
    // Transport exceptions may contain recipient addresses and invitation URLs.
    throw unavailable();
  }
}
