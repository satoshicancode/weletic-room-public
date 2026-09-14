import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stopRunContainers } from "./container-cleanup.mjs";
import { processGroupExists, signalProcessGroup } from "./process-group.mjs";

if (process.argv.length !== 2)
  throw new Error("Local emulator accepts no additional arguments");
const directory = fileURLToPath(new URL("./", import.meta.url));
const dockerHost = execFileSync(
  "docker",
  ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
  {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: homedir() },
    timeout: 10000,
  },
).trim();
if (!dockerHost.startsWith("unix:///"))
  throw new Error("Only a local Unix Docker socket is permitted");

const state = mkdtempSync(join(tmpdir(), "weletic-cloudflare-emulator-"));
const runName = `weletic-local-probe-${randomBytes(6).toString("hex")}`;
writeFileSync(
  join(state, "config.json"),
  JSON.stringify({
    cliPluginsExtraDirs:
      process.platform === "darwin"
        ? ["/Applications/Docker.app/Contents/Resources/cli-plugins"]
        : [],
  }),
  { mode: 0o600 },
);
const config = join(state, "wrangler.json");
writeFileSync(
  config,
  JSON.stringify({
    name: runName,
    main: join(directory, "worker.mjs"),
    compatibility_date: "2026-08-15",
    workers_dev: false,
    preview_urls: false,
    routes: [],
    containers: [
      {
        class_name: "LoyaltyProbe",
        image: join(directory, "Dockerfile"),
        image_build_context: directory,
        max_instances: 1,
      },
    ],
    durable_objects: {
      bindings: [{ name: "PROBE", class_name: "LoyaltyProbe" }],
    },
    migrations: [
      { tag: "local-probe-v1", new_sqlite_classes: ["LoyaltyProbe"] },
    ],
  }),
  { mode: 0o600 },
);
console.info(`Local emulator state: ${state}`);
console.info(`Local emulator run: ${runName}`);
const child = spawn(
  process.execPath,
  [
    join(directory, "node_modules/wrangler/bin/wrangler.js"),
    "dev",
    "--local",
    "--config",
    config,
    "--ip",
    "127.0.0.1",
    "--port",
    "8794",
    "--inspector-port",
    "0",
    "--persist-to",
    join(state, "state"),
  ],
  {
    cwd: state,
    detached: true,
    env: {
      PATH: process.env.PATH,
      HOME: state,
      XDG_CONFIG_HOME: state,
      DOCKER_CONFIG: state,
      DOCKER_HOST: dockerHost,
      CI: "true",
      WRANGLER_SEND_METRICS: "false",
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
    },
    stdio: "inherit",
  },
);
let timeout;
let closing = false;
const stop = () => {
  if (closing || !child.pid) return;
  signalProcessGroup(child.pid, "SIGTERM");
  timeout ??= setTimeout(
    () => signalProcessGroup(child.pid, "SIGKILL"),
    20_000,
  );
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
child.on("error", () => {
  console.error("Local emulator could not start");
  process.exitCode = 1;
});
child.on("close", async (code) => {
  closing = true;
  if (child.pid && processGroupExists(child.pid)) {
    // A wrapper may exit before workerd. Keep the watchdog referenced until
    // descendants are gone; wrapper exit alone must not cancel cleanup.
    timeout ??= setTimeout(
      () => signalProcessGroup(child.pid, "SIGKILL"),
      20_000,
    );
  } else {
    clearTimeout(timeout);
  }
  process.exitCode = code ?? 1;
  try {
    // Wait for workerd to exit before enumerating Docker resources so it cannot
    // race cleanup by creating another container after the inventory snapshot.
    const deadline = Date.now() + 21_000;
    while (child.pid && processGroupExists(child.pid)) {
      if (Date.now() >= deadline)
        throw new Error("Emulator process group remains");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    clearTimeout(timeout);
    const stopped = stopRunContainers(runName, (args) =>
      execFileSync("docker", args, {
        encoding: "utf8",
        timeout: 15_000,
        env: {
          PATH: process.env.PATH,
          HOME: state,
          DOCKER_CONFIG: state,
          DOCKER_HOST: dockerHost,
        },
      }),
    );
    console.info(
      `Local emulator cleanup verified; stopped ${stopped} retained containers`,
    );
  } catch (error) {
    console.error(`Local emulator cleanup failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
});
