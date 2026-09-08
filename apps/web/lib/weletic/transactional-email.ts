import type { ResendEmailOptions } from "@dub/email/resend/types";
import { z } from "zod";

type EmailEnvironment = Partial<
  Pick<
    NodeJS.ProcessEnv,
    | "WELETIC_TRANSACTIONAL_EMAIL_FROM"
    | "WELETIC_TRANSACTIONAL_EMAIL_REPLY_TO"
    | "RESEND_API_KEY"
    | "SMTP_HOST"
  >
>;

function readMailbox(value: string | undefined, setting: string) {
  if (!value?.trim()) return undefined;
  // Do not permit multiple recipients or header injection in configuration.
  const trimmed = value.trim();
  const named = trimmed.match(/^[^<>,;:"\\]+<([^<>,;]+)>$/);
  const address = named ? named[1].trim() : trimmed;
  if (
    /[\u0000-\u001f\u007f]/.test(value) ||
    !z.string().email().safeParse(address).success
  ) {
    // Configuration errors must never echo addresses or other environment data.
    throw new Error(`${setting} must contain one valid email mailbox.`);
  }
  return trimmed;
}

/** Only Weletic referral/review producers opt into this policy. Shared Dub
 * senders retain their defaults. External delivery requires an approved sender;
 * local MailHog and an unconfigured transport retain development compatibility. */
export function getWeleticTransactionalEmailOptions(
  env: EmailEnvironment | NodeJS.ProcessEnv = process.env,
): Pick<ResendEmailOptions, "from" | "replyTo"> {
  const from = readMailbox(
    env.WELETIC_TRANSACTIONAL_EMAIL_FROM,
    "WELETIC_TRANSACTIONAL_EMAIL_FROM",
  );
  const replyTo = readMailbox(
    env.WELETIC_TRANSACTIONAL_EMAIL_REPLY_TO,
    "WELETIC_TRANSACTIONAL_EMAIL_REPLY_TO",
  );
  const smtpHost = env.SMTP_HOST?.trim().toLowerCase();
  const localSmtp =
    smtpHost !== undefined &&
    ["localhost", "127.0.0.1", "::1", "[::1]", "mailhog", "mailpit"].includes(
      smtpHost,
    );
  if (!from && (env.RESEND_API_KEY || (smtpHost && !localSmtp))) {
    throw new Error(
      "WELETIC_TRANSACTIONAL_EMAIL_FROM is required for external Weletic email delivery.",
    );
  }
  if (from) {
    // The shared Resend adapter otherwise defaults reply-to to Dub support.
    return { from, replyTo: replyTo ?? "noreply" };
  }
  return replyTo ? { replyTo } : {};
}
