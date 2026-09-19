import { createHash } from "node:crypto";
import { Resend } from "resend";

const configuredKey = process.env.RESEND_API_KEY;
export const resend = configuredKey ? new Resend(configuredKey) : null;

// Private evidence for durable jobs: identify the actual singleton credential,
// not a subsequently changed environment variable. Never expose in public APIs.
export const resendCredentialIdentity = configuredKey
  ? createHash("sha256")
      .update(JSON.stringify(["resend-credential-v1", configuredKey]))
      .digest("hex")
  : null;
export const isResendCredentialCurrent = () =>
  Boolean(configuredKey) && process.env.RESEND_API_KEY === configuredKey;
