import { pretty, render } from "@react-email/render";
import nodemailer from "nodemailer";
import type { ResendEmailOptions } from "./resend/types";

// Send email using NodeMailer (Recommended for local development)
export const sendViaNodeMailer = async ({
  to,
  from,
  replyTo,
  subject,
  text,
  react,
}: Pick<
  ResendEmailOptions,
  "to" | "from" | "replyTo" | "subject" | "text" | "react"
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
    ...(react ? { html: await pretty(await render(react)) } : {}),
  });
};
