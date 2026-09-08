import { execFileSync } from "node:child_process";
import { get } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hasRetainedEnvironment } from "./init.mjs";
import { buildRuntimeEnvironment } from "./runtime-policy.mjs";
import { privateCredentialFiles } from "./verify.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(join(root, "apps/web/package.json"));
const { parse } = require("dotenv-flow");

async function main() {
  if (
    process.argv.slice(2).join(" ") !== "--confirm-local-runtime-probes" ||
    hasRetainedEnvironment(root) ||
    !privateCredentialFiles(root)
  )
    throw new Error("Unsafe probe configuration");
  const web = parse(join(root, "apps/web/.env.loyalty.local"));
  const shopify = parse(join(root, "packages/shopify-app/.env.loyalty.local"));
  const env = buildRuntimeEnvironment("shopify", web, shopify, process.env);
  const checks = [];
  async function check(id, operation) {
    try {
      checks.push({ id, passed: Boolean(await operation()) });
    } catch {
      checks.push({ id, passed: false });
    }
  }
  // No authenticated mutation, cron execution, store auth or customer session.
  for (const [id, port, path, method, status] of [
    [
      "unsigned_web_session",
      8890,
      "/api/internal/shopify/sessions?id=runtime-probe",
      "GET",
      401,
    ],
    [
      "unsigned_shopify_internal",
      3002,
      "/api/internal/admin-session",
      "GET",
      401,
    ],
    ["unsigned_cron_get", 8890, "/api/cron/weletic/loyalty/outbox", "GET", 401],
    [
      "unsigned_cron_post",
      8890,
      "/api/cron/weletic/loyalty/outbox",
      "POST",
      400,
    ],
  ])
    await check(id, async () => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        redirect: "manual",
        signal: AbortSignal.timeout(60000),
      });
      await response.arrayBuffer();
      return response.status === status;
    });
  await check("foreign_shopify_host_refused", async () => {
    // Native fetch normalizes Host. Use HTTP to test the actual foreign header.
    return await new Promise((resolve, reject) => {
      const request = get(
        "http://127.0.0.1:3002/api/internal/admin-session",
        {
          headers: { Host: "foreign.invalid" },
          signal: AbortSignal.timeout(10000),
        },
        (response) => {
          response.resume();
          response.once("end", () => resolve(response.statusCode === 403));
          response.once("error", reject);
        },
      );
      request.once("error", reject);
    });
  });
  await check("production_signed_session_read", () => {
    // The production client generates its own HMAC. Only its boolean result is
    // returned; credentials and any upstream error/body remain captured.
    const result = execFileSync(
      process.execPath,
      [
        "--import",
        require.resolve("tsx"),
        "--input-type=module",
        "-e",
        `
      import {randomUUID} from "node:crypto";
      import {weleticApiJson} from "./packages/shopify-app/app/weletic-api.server.ts";
      const response = await weleticApiJson("/api/internal/shopify/sessions?id=runtime-probe-" + randomUUID());
      process.stdout.write(JSON.stringify({passed: Array.isArray(response.sessions) && response.sessions.length === 0}));
    `,
      ],
      {
        cwd: root,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30000,
      },
    );
    return JSON.parse(result).passed === true;
  });
  await check("login_renders_without_plausible", async () => {
    // Use HTTP for the exact Host, without DNS or automatic redirects. Require
    // the actual login title, not just any successful HTML fallback page.
    const response = await new Promise((resolve, reject) => {
      const request = get(
        "http://127.0.0.1:8890/login",
        {
          headers: { Host: "app.localhost:8890" },
          signal: AbortSignal.timeout(60000),
        },
        (response) => {
          let html = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            html += chunk;
            if (html.length > 4 * 1024 * 1024) {
              response.destroy(new Error("Oversized response"));
            }
          });
          response.once("end", () =>
            resolve({ status: response.statusCode, html }),
          );
          response.once("error", reject);
        },
      );
      request.once("error", reject);
    });
    const { html } = response;
    return (
      response.status === 200 &&
      html.includes("<html") &&
      html.includes("<title>Sign in to") &&
      !html.includes("next-plausible-script") &&
      !html.includes("next-plausible-init")
    );
  });
  const passed = checks.every((check) => check.passed);
  console.log(
    JSON.stringify(
      {
        status: passed ? "local_runtime_checks_passed" : "failed",
        checks,
        shopifyAcceptance: false,
      },
      null,
      2,
    ),
  );
  if (!passed) process.exitCode = 1;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch(() => {
    console.error("Local runtime probes refused or failed; details redacted.");
    process.exitCode = 1;
  });
}
