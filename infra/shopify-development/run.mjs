import { execFileSync, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hasRetainedEnvironment } from "./init.mjs";
import {
  buildRuntimeEnvironment,
  createRuntimeLogSink,
  runtimeArguments,
} from "./runtime-policy.mjs";
import { privateCredentialFiles } from "./verify.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const webDirectory = join(root, "apps/web");
const require = createRequire(join(webDirectory, "package.json"));
const { parse } = require("dotenv-flow");
const cleanOs = () =>
  Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "LANG", "TZ"]
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]]),
  );

export function parseRuntimeFlags(args) {
  const names = ["app", "retained-web", "retained-shopify"];
  if (args.length !== 4 || !args.includes("--confirm-local-runtime"))
    throw new Error("Invalid flags");
  const values = Object.fromEntries(
    names.map((name) => {
      const matches = args.filter((arg) => arg.startsWith(`--${name}=`));
      if (matches.length !== 1 || !matches[0].slice(name.length + 3))
        throw new Error("Invalid flags");
      return [name, matches[0].slice(name.length + 3)];
    }),
  );
  if (!["web", "shopify"].includes(values.app)) throw new Error("Invalid app");
  return values;
}

async function assertFreePort(port) {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", () =>
      reject(new Error("Requested loopback port is already in use")),
    );
    server.listen(port, "127.0.0.1", () => server.close(resolve));
  });
}

async function main() {
  if (Number(process.versions.node.split(".")[0]) !== 24)
    throw new Error("Node 24 required");
  const flags = parseRuntimeFlags(process.argv.slice(2));
  if (hasRetainedEnvironment(root) || !privateCredentialFiles(root))
    throw new Error("Unsafe environment files");
  const paths = [
    join(webDirectory, ".env.loyalty.local"),
    join(root, "packages/shopify-app/.env.loyalty.local"),
    flags["retained-web"],
    flags["retained-shopify"],
  ].map((path) => realpathSync(path));
  if (new Set(paths).size !== 4)
    throw new Error("Four distinct files required");
  const [web, shopify] = paths.slice(0, 2).map((path) => parse(path));
  const env = buildRuntimeEnvironment(flags.app, web, shopify, process.env);
  const report = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--import",
        require.resolve("tsx"),
        join(webDirectory, "scripts/dev/check-shopify-development.ts"),
        ...["web", "shopify", "retained-web", "retained-shopify"].map(
          (key, index) => `--${key}=${paths[index]}`,
        ),
      ],
      {
        cwd: webDirectory,
        env: cleanOs(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30000,
      },
    ),
  );
  if (report.status !== "configuration_consistent")
    throw new Error("Configuration preflight failed");
  // Live checks may write and remove bounded synthetic Redis/media probes.
  execFileSync(
    process.execPath,
    [
      join(root, "infra/shopify-development/verify.mjs"),
      "--confirm-local-probes",
    ],
    {
      cwd: root,
      env: cleanOs(),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120000,
    },
  );
  const port = flags.app === "web" ? 8890 : 3002;
  await assertFreePort(port);
  const directory =
    flags.app === "web" ? webDirectory : join(root, "packages/shopify-app");
  const appRequire = createRequire(join(directory, "package.json"));
  const binary =
    flags.app === "web"
      ? appRequire.resolve("next/dist/bin/next")
      : appRequire.resolve("@remix-run/dev/dist/cli.js");
  // Direct framework executables: no generic dev scripts, CLI app linking,
  // migration, sync poller, tunnel, scheduler, install or deployment hooks.
  const child = spawn(
    process.execPath,
    [binary, ...runtimeArguments(flags.app)],
    { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const out = createRuntimeLogSink([web, shopify], (line) =>
    process.stdout.write(line),
  );
  const err = createRuntimeLogSink([web, shopify], (line) =>
    process.stderr.write(line),
  );
  child.stdout.on("data", (data) => out.write(data));
  child.stderr.on("data", (data) => err.write(data));
  const stop = () => child.kill("SIGTERM");
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  child.once("error", () => {
    console.error("Isolated runtime failed to start.");
    process.exitCode = 1;
  });
  child.once("close", (code, signal) => {
    out.end();
    err.end();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    process.exitCode = signal === "SIGTERM" ? 0 : code ?? 1;
  });
  console.log(
    `Starting isolated ${flags.app} on loopback port ${port}. No installation or delivery activated; public exposure remains unconfigured.`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch(() => {
    console.error(
      "Isolated runtime refused or failed. Check private configuration, preflight checks and port availability; no secret values are printed.",
    );
    process.exitCode = 1;
  });
}
