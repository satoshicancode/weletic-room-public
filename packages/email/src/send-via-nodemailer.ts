import { pretty, render } from "@react-email/render";
import nodemailer from "nodemailer";
import type { ResendEmailOptions } from "./resend/types";

/** Render once before durable retention, with the same defaults as SMTP send. */
export async function prepareNodeMailerEmail(opts: ResendEmailOptions) {
  if (!opts.react) throw new Error("Prepared email requires a template");
  return {
    to: opts.to,
    from: opts.from || "noreply@example.com",
    subject: opts.subject,
    ...(opts.text !== undefined ? { text: opts.text } : {}),
    ...(opts.replyTo && opts.replyTo !== "noreply"
      ? { replyTo: Array.isArray(opts.replyTo) ? opts.replyTo : [opts.replyTo] }
      : {}),
    html: await pretty(await render(opts.react)),
  };
}

// Send email using NodeMailer (Recommended for local development)
export const sendViaNodeMailer = async ({
  to,
  from,
  replyTo,
  subject,
  text,
  react,
  html,
}: Pick<
  ResendEmailOptions,
  "to" | "from" | "replyTo" | "subject" | "text" | "react" | "html"
>) => {
  const port = Number(process.env.SMTP_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("SMTP_PORT must be an integer between 1 and 65535.");
  }
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    ...(process.env.SMTP_USER || process.env.SMTP_PASSWORD
      ? {
          auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASSWORD,
          },
        }
      : {}),
    secure: port === 465,
    tls: {
      rejectUnauthorized: true,
    },
  });

  return await transporter.sendMail({
    from: from || "noreply@example.com",
    ...(replyTo && replyTo !== "noreply" ? { replyTo } : {}),
    to,
    subject,
    text,
    // Durable jobs pass already-rendered HTML without a React template. Legacy
    // callers retain their rendering behavior and are not silently reinterpreted.
    ...(react
      ? { html: await pretty(await render(react)) }
      : html
        ? { html }
        : {}),
  });
};
