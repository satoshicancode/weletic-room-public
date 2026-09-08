const requiredIntegrationEnv = [
  "E2E_BASE_URL",
  "E2E_TOKEN",
  "E2E_TOKEN_MEMBER",
  "E2E_TOKEN_OLD",
  "E2E_PUBLISHABLE_KEY",
] as const;

const missing = requiredIntegrationEnv.filter(
  (name) => !process.env[name]?.trim(),
);

if (missing.length > 0) {
  throw new Error(
    `Integration tests require deployment credentials. Missing: ${missing.join(", ")}`,
  );
}

new URL(process.env.E2E_BASE_URL!);
