import { render } from "@react-email/render";
import type { CreateEmailOptions } from "resend";
import { resend } from "./resend";
import { VARIANT_TO_FROM_MAP } from "./resend/constants";
import { ResendBulkEmailOptions, ResendEmailOptions } from "./resend/types";

const resendEmailForOptions = (
  opts: ResendEmailOptions,
): CreateEmailOptions => {
  const {
    to,
    from,
    variant = "primary",
    bcc,
    replyTo,
    subject,
    text,
    react,
    scheduledAt,
    headers,
    tags,
    unsubscribeUrl,
  } = opts;

  const isPreviewEnv = process.env.VERCEL_ENV === "preview";
  const gitBranch = process.env.VERCEL_GIT_COMMIT_REF;

  // Build base options without rendered outputs (react/text)
  // CreateEmailOptions requires at least one of react or text
  const baseOptions = {
    to: isPreviewEnv ? "delivered@resend.dev" : to,
    from: from || VARIANT_TO_FROM_MAP[variant],
    subject: `${subject}${isPreviewEnv && gitBranch ? ` [${gitBranch}]` : ""}`,
    bcc,
    // if replyTo is set to "noreply@dub.co", don't set replyTo
    // else set it to the value of replyTo or fallback to support@dub.co
    ...(replyTo === "noreply" ? {} : { replyTo: replyTo || "support@dub.co" }),
    scheduledAt,
    tags,
    ...(variant === "marketing"
      ? {
          headers: {
            ...(headers || {}),
            "List-Unsubscribe":
              unsubscribeUrl || "https://app.dub.co/account/settings",
          },
        }
      : headers && { headers }),
  };

  // Add render options (react or text) - at least one must be present
  if (react) {
    return { ...baseOptions, react };
  }
  if (text) {
    return { ...baseOptions, text };
  }
  // If none of react or text is provided, we need to ensure at least one is present
  // This shouldn't happen in practice, but we'll default to an empty text
  return { ...baseOptions, text: "" };
};

/** Freeze provider normalization and rendering before durable outbox retention.
 * Sending this result must not rerun environment-based recipient/sender mapping.
 */
export async function prepareResendEmail(opts: ResendEmailOptions) {
  if (!resend) throw new Error("Prepared email transport unavailable");
  const normalized = resendEmailForOptions(opts);
  if (!normalized.react) throw new Error("Prepared email requires a template");
  const { react, ...request } = normalized;
  return { ...request, html: await render(react) };
}

/** Durable idempotent jobs never silently switch to a non-idempotent SMTP
 * fallback. Legacy sendEmail/sendBatchEmail behavior is unchanged.
 */
export async function sendPreparedResendEmail(
  request: CreateEmailOptions,
  idempotencyKey: string,
) {
  if (!resend || !idempotencyKey)
    throw new Error("Prepared email transport unavailable");
  return resend.batch.send([request], { idempotencyKey });
}

// Send email using Resend (Recommended for production)
export const sendEmailViaResend = async (opts: ResendEmailOptions) => {
  if (!resend) {
    console.info(
      "RESEND_API_KEY is not set in the .env. Skipping sending email.",
    );
    return;
  }

  return await resend.emails.send(resendEmailForOptions(opts));
};

export const sendBatchEmailViaResend = async (
  emails: ResendBulkEmailOptions,
  options?: { idempotencyKey?: string },
) => {
  if (!resend) {
    console.info(
      "RESEND_API_KEY is not set in the .env. Skipping sending email.",
    );

    return {
      data: null,
      error: null,
    };
  }

  if (emails.length === 0) {
    return {
      data: null,
      error: null,
    };
  }

  // Filter out emails without to address
  // and format the emails for Resend
  const filteredBatch = emails.reduce(
    (acc, email) => {
      if (!email?.to) {
        return acc;
      }

      acc.push(resendEmailForOptions(email));

      return acc;
    },
    [] as ReturnType<typeof resendEmailForOptions>[],
  );

  if (filteredBatch.length === 0) {
    return {
      data: null,
      error: null,
    };
  }

  const idempotencyKey = options?.idempotencyKey || undefined;

  return await resend.batch.send(
    filteredBatch,
    idempotencyKey ? { idempotencyKey } : undefined,
  );
};
