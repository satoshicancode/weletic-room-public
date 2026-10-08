import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  PUBLIC_LOYALTY_API_ORIGIN,
  PUBLIC_LOYALTY_APP_ORIGIN,
  PUBLIC_LOYALTY_CLIENT_ID,
  PUBLIC_LOYALTY_SCOPES,
} from "../../packages/shopify-app/app/public-runtime-policy.mjs";
import { assertCloudflareIngressPair } from "./ingress-policy.mjs";

function fixture() {
  const common = {
    NODE_ENV: "production",
    WELETIC_FEATURE_PROFILE: "core-v1",
    SHOPIFY_API_KEY: PUBLIC_LOYALTY_CLIENT_ID,
    SHOPIFY_APP_URL: PUBLIC_LOYALTY_APP_ORIGIN,
    WELETIC_SHOPIFY_SERVICE_SECRET: "synthetic-service-secret-not-real".repeat(
      2,
    ),
  };
  return {
    web: {
      SHOPIFY_PARTNER_APP_ID: "gid://shopify/App/1",
      SHOPIFY_PARTNER_ORGANIZATION_ID: "123",
      SHOPIFY_PARTNER_API_TOKEN: "synthetic-partner-api-token-not-real",
      WELETIC_SHOPIFY_PUBLIC_PLAN_HANDLE: "core-monthly",
      WELETIC_SHOPIFY_PRIVATE_PLAN_HANDLE: "company-free",
      ...common,
      WELETIC_ENFORCE_CRON_AUTH: "1",
      NEXTAUTH_URL: PUBLIC_LOYALTY_API_ORIGIN,
      NEXT_PUBLIC_APP_DOMAIN: PUBLIC_LOYALTY_API_ORIGIN,
      SHOPIFY_WEBHOOK_URL: `${PUBLIC_LOYALTY_API_ORIGIN}/api/shopify/integration/webhook`,
      NEXTAUTH_SECRET: "synthetic-session-secret-not-real".repeat(2),
      CRON_SECRET: "synthetic-cron-secret-not-real".repeat(2),
      SHOPIFY_WEBHOOK_SECRET: "synthetic-app-secret-not-real".repeat(2),
    },
    shopify: {
      SHOPIFY_APP_HANDLE: "weletic-room",
      WELETIC_SUPPORT_EMAIL: "support@example.test",
      ...common,
      SHOPIFY_APP_DISTRIBUTION: "app_store",
      WELETIC_API_URL: PUBLIC_LOYALTY_API_ORIGIN,
      SHOPIFY_API_SECRET: "synthetic-app-secret-not-real".repeat(2),
      SCOPES: PUBLIC_LOYALTY_SCOPES.join(","),
    },
  };
}

test("passes static ingress without claiming deployment or changing input", () => {
  const input = fixture();
  const original = structuredClone(input);
  assert.deepEqual(assertCloudflareIngressPair(input), {
    status: "static_ingress_checks_passed",
    deploymentAuthorized: false,
    servicesVerified: false,
    liveAcceptanceVerified: false,
  });
  assert.deepEqual(input, original);
});

for (const role of ["web", "shopify"]) {
  for (const [key, value] of [
    ["NODE_ENV", "development"],
    ["SHOPIFY_API_KEY", "legacy-custom-client"],
    ["SHOPIFY_APP_URL", "https://foreign.invalid"],
    ["WELETIC_ISOLATED_DEVELOPMENT", "1"],
    ["WELETIC_ISOLATED_DEVELOPMENT", ""],
    ["NEXT_PUBLIC_WELETIC_ISOLATED_DEVELOPMENT", "1"],
  ]) {
    test(`rejects ${role} ${key} mismatch`, () => {
      const input = fixture();
      input[role][key] = value;
      assert.throws(() => assertCloudflareIngressPair(input), /Unsafe/);
    });
  }
}

for (const [role, key, value] of [
  ["web", "WELETIC_ENFORCE_CRON_AUTH", "0"],
  ["web", "NEXTAUTH_URL", "http://app.localhost:8890"],
  ["web", "NEXT_PUBLIC_APP_DOMAIN", "https://app.weletic.com"],
  ["web", "SHOPIFY_WEBHOOK_URL", `${PUBLIC_LOYALTY_API_ORIGIN}/wrong`],
  ["web", "CRON_SECRET", "short"],
  ["web", "SHOPIFY_WEBHOOK_SECRET", "different-webhook-secret".repeat(3)],
  ["web", "DEV_WEBHOOK_URL", "https://foreign.invalid"],
  ["shopify", "SHOPIFY_APP_DISTRIBUTION", "custom"],
  ["shopify", "WELETIC_API_URL", "https://foreign.invalid"],
  ["shopify", "SCOPES", `${PUBLIC_LOYALTY_SCOPES.join(",")},write_gift_cards`],
  ["shopify", "WELETIC_SHOPIFY_SERVICE_SECRET", "different".repeat(8)],
]) {
  test(`rejects unsafe ${role} ${key}`, () => {
    const input = fixture();
    input[role][key] = value;
    assert.throws(() => assertCloudflareIngressPair(input), /Unsafe/);
  });
}

test("Vercel's flag does not substitute for explicit Cloudflare cron admission", () => {
  const input = fixture();
  input.web.VERCEL = "1";
  delete input.web.WELETIC_ENFORCE_CRON_AUTH;
  assert.throws(() => assertCloudflareIngressPair(input), /Unsafe/);
});

test("rejects effective secret reuse despite padding", () => {
  const input = fixture();
  input.web.CRON_SECRET = ` ${input.shopify.SHOPIFY_API_SECRET} `;
  assert.throws(() => assertCloudflareIngressPair(input), /Unsafe/);
});

test("rejects padded web service secrets because web HMAC uses raw bytes", () => {
  const input = fixture();
  input.web.WELETIC_SHOPIFY_SERVICE_SECRET = ` ${input.shopify.WELETIC_SHOPIFY_SERVICE_SECRET} `;
  assert.throws(() => assertCloudflareIngressPair(input), /Unsafe/);
});

test("accepts padded Shopify service secrets that its requireEnv trims", () => {
  const input = fixture();
  input.shopify.WELETIC_SHOPIFY_SERVICE_SECRET = ` ${input.web.WELETIC_SHOPIFY_SERVICE_SECRET} `;
  assertCloudflareIngressPair(input);
});

test("accepts explicit disabled isolation flags", () => {
  const input = fixture();
  for (const env of Object.values(input)) {
    env.WELETIC_ISOLATED_DEVELOPMENT = "0";
    env.NEXT_PUBLIC_WELETIC_ISOLATED_DEVELOPMENT = "0";
  }
  assertCloudflareIngressPair(input);
});

test("rejects malformed envelopes and non-string environment values", () => {
  for (const input of [
    null,
    [],
    {},
    { ...fixture(), worker: {} },
    { ...fixture(), web: [] },
    { ...fixture(), shopify: { NODE_ENV: 1 } },
  ]) {
    assert.throws(() => assertCloudflareIngressPair(input), /Unsafe/);
  }
});

const cli = fileURLToPath(new URL("./preflight.mjs", import.meta.url));
function run(input, args = []) {
  return spawnSync(process.execPath, [cli, ...args], {
    input,
    encoding: "utf8",
    timeout: 5000,
    env: { NODE_ENV: "development", CRON_SECRET: "ambient-poison" },
  });
}

test("CLI returns only nonsecret static status and ignores ambient config", () => {
  const result = run(JSON.stringify(fixture()));
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(JSON.parse(result.stdout).deploymentAuthorized, false);
  assert.doesNotMatch(result.stdout, /synthetic|ambient-poison/);
});

test("CLI rejects invalid, oversized and argument input without disclosing it", () => {
  for (const [input, args] of [
    ['{"private-secret":"never-print-me"', []],
    [JSON.stringify(fixture()), ["unexpected"]],
    ["never-print-me".repeat(100_000), []],
    [JSON.stringify({ web: { SECRET: "never-print-me" } }), []],
  ]) {
    const result = run(input, args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      "Cloudflare ingress preflight rejected input\n",
    );
  }
});
