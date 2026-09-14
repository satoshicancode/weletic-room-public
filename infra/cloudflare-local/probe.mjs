import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

// The probe never forwards process.env wholesale. These are deliberately fake,
// loopback-only values, not a deployable public identity or installation.
export function probeEnvironment() {
  return {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: "/tmp",
    NODE_ENV: "production",
    PORT: "3000",
    HOST: "0.0.0.0",
    HOSTNAME: "0.0.0.0",
    CI: "true",
    CI_SEPARATE_VALIDATION: "true",
    NEXT_TELEMETRY_DISABLED: "1",
    DOTENV_FLOW_SILENT: "true",
    // Runtime probes have a 2 GiB container budget; leave room for native
    // allocations, loaded code and the harness. The build overrides this below.
    NODE_OPTIONS: "--max-old-space-size=1024",
    DATABASE_URL: "mysql://probe:probe@127.0.0.1:1/weletic_container_probe",
    PLANETSCALE_DATABASE_URL:
      "http://probe:probe@127.0.0.1:1/weletic_container_probe",
    NEXTAUTH_URL: "http://127.0.0.1:3000",
    NEXTAUTH_SECRET: "synthetic-container-nextauth-not-a-real-secret",
    SHOPIFY_API_KEY: "synthetic-container-client",
    SHOPIFY_API_SECRET: "synthetic-container-shopify-not-a-real-secret",
    SHOPIFY_APP_URL: "https://127.0.0.1:3000",
    WELETIC_API_URL: "https://127.0.0.1:1",
    WELETIC_SHOPIFY_SERVICE_SECRET:
      "synthetic-container-service-not-a-real-secret",
    TINYBIRD_API_KEY: "synthetic",
    TINYBIRD_API_URL: "http://127.0.0.1:1",
    UPSTASH_VECTOR_REST_URL: "http://127.0.0.1:1",
    UPSTASH_VECTOR_REST_TOKEN: "synthetic",
    STRIPE_SECRET_KEY: "sk_test_synthetic_container_probe",
    CRON_SECRET: "synthetic-container-cron-not-a-real-secret",
  };
}

export function probeCommand(role) {
  if (role === "shopify")
    return {
      cwd: `${root}packages/shopify-app`,
      args: [
        "node_modules/@remix-run/serve/dist/cli.js",
        "build/server/index.js",
      ],
    };
  if (role === "web")
    return {
      cwd: `${root}apps/web`,
      args: [
        "node_modules/next/dist/bin/next",
        "start",
        "--port",
        "3000",
        "--hostname",
        "0.0.0.0",
      ],
    };
  if (role === "build-web")
    return {
      cwd: `${root}apps/web`,
      args: ["node_modules/next/dist/bin/next", "build"],
    };
  if (role === "worker")
    return {
      cwd: `${root}apps/web`,
      // Use the real loop with injected synthetic batches, never the live CLI.
      args: [
        "--import",
        "tsx",
        `${root}infra/cloudflare-local/worker-probe.ts`,
      ],
    };
  if (role === "worker-boot")
    return {
      cwd: `${root}apps/web`,
      // Load the real CLI but reject arguments before store lookup or delivery.
      args: [
        "--conditions=react-server",
        "--import=./scripts/runtime/async-local-storage.cjs",
        "--import",
        "tsx",
        "./scripts/loyalty/run-outbox-worker.ts",
        "--unsupported-container-probe",
      ],
    };
  throw new Error("Unsupported local container probe role");
}

export function assertBuildResources(read = readFileSync) {
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
  ) {
    throw new Error(
      "Local Next build requires at most 6 GiB, no swap and at most 2 CPUs",
    );
  }
}

// Numeric cgroup counters only: never dump environment, processes or heap data.
export function buildMemorySample(read = readFileSync) {
  const counter = (name) => {
    try {
      const value = read(`/sys/fs/cgroup/${name}`, "utf8").trim();
      return /^\d+$/.test(value) ? value : null;
    } catch {
      return null;
    }
  };
  const sample = {
    currentBytes: counter("memory.current"),
    peakBytes: counter("memory.peak"),
    swapBytes: counter("memory.swap.current"),
    oom: null,
    oomKill: null,
  };
  try {
    const events = read("/sys/fs/cgroup/memory.events", "utf8");
    for (const [key, field] of [
      ["oom", "oom"],
      ["oom_kill", "oomKill"],
    ]) {
      const match = events.match(new RegExp(`^${key} (\\d+)$`, "m"));
      sample[field] = match?.[1] ?? null;
    }
  } catch {
    // Missing telemetry is explicit and must not hide the compiler exit code.
  }
  return sample;
}

export function monitorBuildMemory({
  sample = buildMemorySample,
  log = console.log,
  schedule = setInterval,
  cancel = clearInterval,
} = {}) {
  const emit = () => log(`[local-build-memory] ${JSON.stringify(sample())}`);
  emit();
  const interval = schedule(emit, 10_000);
  interval.unref();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    cancel(interval);
    emit();
  };
}

export function runProbe(role) {
  if (
    (role === "web" ||
      role === "shopify" ||
      role === "worker-boot" ||
      role === "build-web") &&
    !existsSync("/.dockerenv") &&
    !existsSync("/opt/weletic-local-probe")
  ) {
    throw new Error(
      "Server probes must run inside the isolated local Docker container",
    );
  }
  const command = probeCommand(role);
  const env = probeEnvironment();
  if (role === "build-web") {
    assertBuildResources();
    env.NODE_OPTIONS = "--max-old-space-size=4608";
    env.WELETIC_LOCAL_CONTAINER_BUILD = "1";
  }
  const stopMemoryMonitor =
    role === "build-web" ? monitorBuildMemory() : () => {};
  const child = spawn(process.execPath, command.args, {
    cwd: command.cwd,
    env,
    stdio: "inherit",
  });
  let timer;
  let forcedShutdown = false;
  const stop = (signal) => {
    child.kill(signal);
    timer ??= setTimeout(() => {
      forcedShutdown = true;
      child.kill("SIGKILL");
    }, 15_000);
    timer.unref();
  };
  const term = () => stop("SIGTERM");
  const interrupt = () => stop("SIGINT");
  process.on("SIGTERM", term);
  process.on("SIGINT", interrupt);
  child.on("error", () => {
    console.error("Local container process could not start");
    process.exitCode = 1;
  });
  child.on("close", (code, signal) => {
    stopMemoryMonitor();
    clearTimeout(timer);
    process.off("SIGTERM", term);
    process.off("SIGINT", interrupt);
    console.info(
      `Local child exit: ${JSON.stringify({ role, code, signal, forcedShutdown })}`,
    );
    process.exitCode = code ?? (signal === "SIGTERM" ? 143 : 1);
  });
  return child;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3)
    throw new Error("Exactly one probe role is required");
  runProbe(process.argv[2]);
}
