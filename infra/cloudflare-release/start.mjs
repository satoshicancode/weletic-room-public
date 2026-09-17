import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";
import { assertCloudflareRuntime } from "./runtime-policy.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

export function runtimeCommand(role, env = process.env) {
  if (role === "outbox")
    return {
      cwd: `${root}apps/web`,
      args: [
        "--conditions=react-server",
        "--import=./scripts/runtime/async-local-storage.cjs",
        "--import",
        "tsx",
        "./scripts/loyalty/run-outbox-worker.ts",
        `--store=${env.WELETIC_OUTBOX_STORE_DOMAIN}`,
      ],
    };
  if (role === "web")
    return {
      cwd: `${root}apps/web`,
      args: [`${root}infra/cloudflare-release/loyalty-web.mjs`],
    };
  if (role === "shopify")
    return {
      cwd: `${root}packages/shopify-app`,
      args: [
        "node_modules/@remix-run/serve/dist/cli.js",
        "build/server/index.js",
      ],
    };
  throw new Error("Cloudflare runtime admission rejected");
}

export function startRuntime(
  role,
  {
    env = process.env,
    parent = process,
    launch = spawn,
    exists = existsSync,
    schedule = setTimeout,
    cancel = clearTimeout,
  } = {},
) {
  // Snapshot before validation so the exact checked map is passed to the child.
  const childEnv = {
    ...env,
    PORT: "3000",
    HOST: "0.0.0.0",
    HOSTNAME: "0.0.0.0",
  };
  assertCloudflareRuntime(role, childEnv);
  const command = runtimeCommand(role, childEnv);
  // Next/Remix must not load unvalidated configuration after admission.
  for (const name of [
    ".env",
    ".env.local",
    ".env.production",
    ".env.production.local",
  ]) {
    if (exists(`${command.cwd}/${name}`))
      throw new Error("Cloudflare runtime admission rejected");
  }
  const child = launch(process.execPath, command.args, {
    cwd: command.cwd,
    env: childEnv,
    stdio: "inherit",
    shell: false,
  });
  let timer;
  let failed = false;
  const stop = (signal) => {
    child.kill(signal);
    timer ??= schedule(() => child.kill("SIGKILL"), 25_000);
    timer.unref();
  };
  const term = () => stop("SIGTERM");
  const interrupt = () => stop("SIGINT");
  parent.on("SIGTERM", term);
  parent.on("SIGINT", interrupt);
  child.once("error", () => {
    failed = true;
    parent.stderr.write("Cloudflare runtime process failed\n");
    parent.exitCode = 1;
  });
  child.once("close", (code, signal) => {
    cancel(timer);
    parent.off("SIGTERM", term);
    parent.off("SIGINT", interrupt);
    parent.exitCode = failed
      ? 1
      : code ?? 128 + (constants.signals[signal] ?? 1);
  });
  return child;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error();
    startRuntime(process.argv[2]);
  } catch {
    // Never print error objects, environment values or private filesystem paths.
    process.stderr.write("Cloudflare runtime admission rejected\n");
    process.exitCode = 1;
  }
}
