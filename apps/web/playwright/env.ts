/// <reference types="node" />

import * as z from "zod/v4";

const envSchema = z.object({
  E2E_PARTNER_EMAIL: z.email().default("e2e-partner@example.com"),
  E2E_PARTNER_PASSWORD: z.string().min(1).default("Password123"),
});

const rawEmail = process.env.E2E_PARTNER_EMAIL?.trim();
const rawPassword = process.env.E2E_PARTNER_PASSWORD?.trim();

const env = envSchema.parse({
  ...process.env,
  E2E_PARTNER_EMAIL: rawEmail || "partner1@dub-internal-test.com",
  E2E_PARTNER_PASSWORD: rawPassword || "password",
});

export { env };
