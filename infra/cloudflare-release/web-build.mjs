import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  PUBLIC_LOYALTY_API_ORIGIN as api,
  PUBLIC_LOYALTY_APP_ORIGIN as app,
  PUBLIC_LOYALTY_CLIENT_ID as client,
} from "../../packages/shopify-app/app/public-runtime-policy.mjs";

// Build inputs only. No inherited secrets, network providers or runtime bypass.
export function webBuildEnvironment() {
  return {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: "/tmp",
    NODE_ENV: "production",
    CI: "true",
    CI_SEPARATE_VALIDATION: "true",
    NEXT_TELEMETRY_DISABLED: "1",
    DOTENV_FLOW_SILENT: "true",
    NODE_OPTIONS: "--max-old-space-size=4608",
    WELETIC_WEB_BUILD_PROFILE: "loyalty-only",
    NEXT_PUBLIC_APP_DOMAIN: api,
    NEXT_PUBLIC_API_DOMAIN: api,
    NEXT_PUBLIC_ADMIN_DOMAIN: "https://disabled-admin.invalid",
    NEXT_PUBLIC_PARTNERS_DOMAIN: "https://disabled-partners.invalid",
    NEXTAUTH_URL: api,
    SHOPIFY_API_KEY: client,
    SHOPIFY_APP_URL: app,
    WELETIC_API_URL: api,
    DATABASE_URL: "mysql://build:build@127.0.0.1:1/build_only",
    PLANETSCALE_DATABASE_URL: "http://build:build@127.0.0.1:1/build_only",
    NEXTAUTH_SECRET: "build-only-session-placeholder-not-runtime",
    SHOPIFY_API_SECRET: "build-only-shopify-placeholder-not-runtime",
    WELETIC_SHOPIFY_SERVICE_SECRET:
      "build-only-gateway-placeholder-not-runtime",
    CRON_SECRET: "build-only-cron-placeholder-not-runtime",
    TINYBIRD_API_KEY: "build-only",
    TINYBIRD_API_URL: "http://127.0.0.1:1",
    UPSTASH_VECTOR_REST_URL: "http://127.0.0.1:1",
    UPSTASH_VECTOR_REST_TOKEN: "build-only",
    STRIPE_SECRET_KEY: "sk_test_build_only_placeholder",
  };
}

export function assertWebBuildContext(
  exists = existsSync,
  read = readFileSync,
) {
  const directory = fileURLToPath(new URL("../../apps/web/", import.meta.url));
  if (
    !exists("/.dockerenv") ||
    [".env", ".env.local", ".env.production", ".env.production.local"].some(
      (name) => exists(directory + name),
    )
  )
    throw new Error("Release build context rejected");
  const value = (name) => read(`/sys/fs/cgroup/${name}`, "utf8").trim();
  const memory = value("memory.max");
  const cpu = value("cpu.max").split(/\s+/);
  if (
    !/^[0-9]+$/.test(memory) ||
    BigInt(memory) <= 0n ||
    BigInt(memory) > 6442450944n ||
    value("memory.swap.max") !== "0" ||
    cpu.length !== 2 ||
    cpu.some((part) => !/^[0-9]+$/.test(part) || BigInt(part) <= 0n) ||
    BigInt(cpu[0]) > 2n * BigInt(cpu[1])
  )
    throw new Error("Release build resources rejected");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error("Unsupported build arguments");
  assertWebBuildContext();
  const child = spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "build"],
    {
      cwd: fileURLToPath(new URL("../../apps/web/", import.meta.url)),
      env: webBuildEnvironment(),
      stdio: "inherit",
      shell: false,
    },
  );
  child.once("error", () => {
    process.exitCode = 1;
  });
  child.once("close", (code) => {
    process.exitCode = code ?? 1;
  });
}
