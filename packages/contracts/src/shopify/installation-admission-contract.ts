import * as z from "zod/v4";

export const installationAdmissionStateSchema = z.enum([
  "pending_approval",
  "mapped",
  "uninstalled",
  "redacted",
]);

// This projection intentionally carries no shop/user/store IDs, credentials,
// generation, operator notes or mutation authority into the document.
export const installationAdmissionStatusSchema = z
  .object({
    status: z.enum([
      "pending_approval",
      "active",
      "suspended",
      "reauthenticate",
      "unavailable",
    ]),
  })
  .strict();
export type InstallationAdmissionStatus = z.infer<
  typeof installationAdmissionStatusSchema
>;

// SDK-verified bearer claims are attested by the existing signed gateway.
// Not a merchant actor and never accepted by data, export, or write endpoints.
export const installationStatusIdentitySchema = z
  .object({
    appId: z.string().regex(/^[a-z0-9_-]{1,191}$/),
    shop: z
      .string()
      .max(255)
      .regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/),
    userId: z.string().regex(/^[1-9][0-9]{0,19}$/),
    issuedAt: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
  })
  .strict();

export function assertFreshInstallationStatusIdentity(
  value: unknown,
  appId: string,
  now: Date,
) {
  const identity = installationStatusIdentitySchema.parse(value);
  const seconds = Math.floor(now.getTime() / 1000);
  if (
    !Number.isSafeInteger(seconds) ||
    identity.appId !== appId ||
    identity.issuedAt > seconds ||
    identity.issuedAt < seconds - 60 ||
    identity.expiresAt <= seconds ||
    identity.issuedAt >= identity.expiresAt
  )
    throw new Error("Invalid installation status identity");
  return identity;
}
