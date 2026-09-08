import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkDevelopmentEnvironment,
  DEVELOPMENT_SHOPIFY_CLIENT_ID,
  DEVELOPMENT_SHOPIFY_SCOPES,
  type DevelopmentEnvironmentFiles,
} from "../../lib/weletic/shopify/development-preflight";

function fixture() {
  return {
    web: {
      DATABASE_URL:
        "mysql://loyalty_dev:secret@127.0.0.1:3307/weletic_loyalty_dev",
      PLANETSCALE_DATABASE_URL:
        "http://loyalty_dev:secret@127.0.0.1:3902/weletic_loyalty_dev",
      UPSTASH_REDIS_REST_URL: "http://127.0.0.1:8079",
      UPSTASH_REDIS_REST_TOKEN: "r".repeat(40),
      STORAGE_ENDPOINT: "http://127.0.0.1:9002",
      STORAGE_BASE_URL: "http://127.0.0.1:9002/dev-public",
      STORAGE_PRIVATE_BUCKET: "dev-private",
      STORAGE_PUBLIC_BUCKET: "dev-public",
      STORAGE_ACCESS_KEY_ID: "dev-storage",
      STORAGE_SECRET_ACCESS_KEY: "m".repeat(40),
      SHOPIFY_WEBHOOK_SECRET: "a".repeat(40),
      WELETIC_SHOPIFY_SERVICE_SECRET: "s".repeat(40),
      ENCRYPTION_KEY: "e".repeat(64),
      NEXTAUTH_SECRET: "n".repeat(40),
      CRON_SECRET: "c".repeat(40),
      NEXTAUTH_URL: "http://app.localhost:8890",
      NEXT_PUBLIC_APP_DOMAIN: "http://app.localhost:8890",
      SHOPIFY_APP_URL: "http://127.0.0.1:3002",
      SHOPIFY_WEBHOOK_URL:
        "http://app.localhost:8890/api/shopify/integration/webhook",
      WELETIC_ENFORCE_CRON_AUTH: "1",
    },
    shopify: {
      SHOPIFY_API_KEY: DEVELOPMENT_SHOPIFY_CLIENT_ID,
      SHOPIFY_API_SECRET: "a".repeat(40),
      SHOPIFY_APP_DISTRIBUTION: "app_store",
      PORT: "3002",
      SHOPIFY_APP_URL: "http://127.0.0.1:3002",
      WELETIC_API_URL: "http://app.localhost:8890",
      WELETIC_SHOPIFY_SERVICE_SECRET: "s".repeat(40),
      SCOPES: DEVELOPMENT_SHOPIFY_SCOPES.join(","),
    },
    retainedWeb: {
      DATABASE_URL: "mysql://root:old@localhost:3306/planetscale",
      PLANETSCALE_DATABASE_URL: "http://localhost:3900/planetscale",
      UPSTASH_REDIS_REST_URL: "https://retained-redis.invalid",
      STORAGE_PRIVATE_BUCKET: "retained-private",
      STORAGE_PUBLIC_BUCKET: "retained-public",
      STORAGE_ENDPOINT: "https://retained-storage.invalid",
      NEXTAUTH_URL: "http://localhost:8888",
      WELETIC_SHOPIFY_SERVICE_SECRET: "old".repeat(32),
      ENCRYPTION_KEY: "f".repeat(64),
      NEXTAUTH_SECRET: "old-auth".repeat(8),
      CRON_SECRET: "old-cron".repeat(8),
    },
    retainedShopify: {
      SHOPIFY_API_KEY: "retained-app",
      SHOPIFY_API_SECRET: "old-app".repeat(32),
      SHOPIFY_APP_URL: "https://retained-shopify.invalid",
      WELETIC_API_URL: "http://localhost:8888",
    },
  } satisfies DevelopmentEnvironmentFiles;
}

describe("offline Shopify development environment preflight", () => {
  it("reports only configuration consistency, never live readiness", () => {
    expect(checkDevelopmentEnvironment(fixture())).toMatchObject({
      status: "configuration_consistent",
      liveReady: false,
    });
  });

  it.each([
    ["web", "DATABASE_URL", "mysql://root:old@localhost:3306/planetscale"],
    [
      "web",
      "DATABASE_URL",
      "mysql://root:secret@localhost:3307/weletic_loyalty_dev",
    ],
    [
      "web",
      "DATABASE_URL",
      "mysql://dev:secret@remote.invalid/weletic_loyalty_dev",
    ],
    ["web", "DATABASE_URL", "not a URL"],
    ["web", "NEXT_PUBLIC_APP_DOMAIN", "app.localhost:8890"],
    [
      "web",
      "DATABASE_URL",
      "mysql://dev%zz:secret@localhost/weletic_loyalty_dev",
    ],
    ["web", "PLANETSCALE_DATABASE_URL", "http://localhost:3900/planetscale"],
    ["web", "UPSTASH_REDIS_REST_URL", "https://retained-redis.invalid"],
    ["web", "UPSTASH_GLOBAL_REDIS_REST_URL", "https://retained-redis.invalid"],
    ["web", "STORAGE_PRIVATE_BUCKET", "retained-public"],
    ["web", "STORAGE_PUBLIC_BUCKET", "dev-private"],
    ["web", "STORAGE_BASE_URL", "https://media.invalid"],
    ["web", "WELETIC_SHOPIFY_SERVICE_SECRET", "old".repeat(32)],
    ["web", "ENCRYPTION_KEY", ""],
    ["web", "CRON_SECRET", "replace-with-a-new-secret-of-32-characters"],
    ["web", "SHOPIFY_APP_URL", "http://127.0.0.1:3000"],
    [
      "web",
      "SHOPIFY_WEBHOOK_URL",
      "https://app.weletic.com/api/shopify/integration/webhook",
    ],
    ["web", "WELETIC_ENFORCE_CRON_AUTH", "0"],
    ["web", "RESEND_API_KEY", "secret-must-not-leak"],
    ["web", "SMTP_HOST", "smtp.provider.invalid"],
    ["web", "QSTASH_TOKEN", "secret-must-not-leak"],
    ["shopify", "CLOUDFLARE_TUNNEL_TOKEN", "secret-must-not-leak"],
    ["shopify", "SHOPIFY_API_KEY", "retained-app"],
    ["shopify", "PORT", "3000"],
    ["shopify", "SHOPIFY_APP_DISTRIBUTION", "single_merchant"],
    ["shopify", "SCOPES", "read_orders"],
    [
      "shopify",
      "SCOPES",
      `${DEVELOPMENT_SHOPIFY_SCOPES.join(",")},read_all_orders`,
    ],
    ["retainedWeb", "DATABASE_URL", ""],
  ] as const)("blocks unsafe %s.%s", (file, key, value) => {
    const input: DevelopmentEnvironmentFiles = fixture();
    input[file] = { ...input[file], [key]: value };
    const report = checkDevelopmentEnvironment(input);
    expect(report.status).toBe("blocked");
    expect(JSON.stringify(report)).not.toContain("secret-must-not-leak");
  });

  it("detects loopback aliases and credential/query changes to retained endpoints", () => {
    const input = fixture();
    input.retainedWeb.UPSTASH_REDIS_REST_URL = "http://localhost:8079/?old=1";
    expect(checkDevelopmentEnvironment(input).checks).toContainEqual({
      id: "dedicated_local_redis",
      passed: false,
    });
  });

  it("does not mutate environment maps or leak values", () => {
    const input = fixture();
    const before = JSON.stringify(input);
    Object.values(input).forEach(Object.freeze);
    const serialized = JSON.stringify(checkDevelopmentEnvironment(input));
    expect(JSON.stringify(input)).toBe(before);
    for (const value of [
      input.web.DATABASE_URL,
      input.shopify.SHOPIFY_API_SECRET,
    ]) {
      expect(serialized).not.toContain(value);
    }
  });

  it("rejects userinfo in otherwise matching service URLs", () => {
    const input = fixture();
    input.web.SHOPIFY_APP_URL = "http://secret:password@127.0.0.1:3002";
    input.shopify.SHOPIFY_APP_URL = input.web.SHOPIFY_APP_URL;
    expect(checkDevelopmentEnvironment(input).checks).toContainEqual({
      id: "loopback_service_urls",
      passed: false,
    });
  });

  it("rejects matching service URLs with an unexpected base path", () => {
    const input = fixture();
    input.web.SHOPIFY_APP_URL += "/wrong-path";
    input.shopify.SHOPIFY_APP_URL = input.web.SHOPIFY_APP_URL;
    expect(checkDevelopmentEnvironment(input).status).toBe("blocked");
  });

  it("rejects the same encryption key expressed with different encodings", () => {
    const input = fixture();
    input.web.ENCRYPTION_KEY = Buffer.from(
      input.retainedWeb.ENCRYPTION_KEY,
      "hex",
    ).toString("base64");
    expect(checkDevelopmentEnvironment(input).status).toBe("blocked");
  });

  it("CLI ignores ambient credentials, refuses duplicate paths, and redacts errors", () => {
    const directory = mkdtempSync(join(tmpdir(), "weletic-preflight-"));
    try {
      const input = fixture();
      const flags = ["web", "shopify", "retained-web", "retained-shopify"];
      const args = Object.values(input).map((env, index) => {
        const path = join(directory, `${index}.env`);
        writeFileSync(
          path,
          Object.entries(env)
            .map(([key, value]) => `${key}=${value}`)
            .join("\n"),
        );
        return `--${flags[index]}=${path}`;
      });
      const run = (extra: string[]) =>
        spawnSync(
          process.execPath,
          [
            "--import=tsx",
            resolve("scripts/dev/check-shopify-development.ts"),
            ...extra,
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              RESEND_API_KEY: "ambient-secret",
              DATABASE_URL: "bad",
            },
          },
        );
      const result = run(args);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).liveReady).toBe(false);
      const duplicate = run([
        args[0],
        `--shopify=${join(directory, "0.env")}`,
        ...args.slice(2),
      ]);
      expect(duplicate.status).toBe(2);
      const missing = run([
        `--web=${directory}/secret-must-not-leak`,
        ...args.slice(1),
      ]);
      expect(missing.status).toBe(2);
      expect(missing.stderr).not.toContain("secret-must-not-leak");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
