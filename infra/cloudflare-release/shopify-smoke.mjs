import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  PUBLIC_LOYALTY_API_ORIGIN,
  PUBLIC_LOYALTY_APP_ORIGIN,
  PUBLIC_LOYALTY_CLIENT_ID,
  PUBLIC_LOYALTY_SCOPES,
} from "../../packages/shopify-app/app/public-runtime-policy.mjs";

// Local-only evidence. Never forward host application environment to Docker.
export function smokeEnvironment() {
  return {
    SHOPIFY_API_KEY: PUBLIC_LOYALTY_CLIENT_ID,
    SHOPIFY_API_SECRET: "synthetic-release-smoke-shopify-not-a-secret",
    WELETIC_SHOPIFY_SERVICE_SECRET:
      "synthetic-release-smoke-gateway-not-a-secret",
    SHOPIFY_APP_DISTRIBUTION: "app_store",
    SHOPIFY_APP_URL: PUBLIC_LOYALTY_APP_ORIGIN,
    WELETIC_API_URL: PUBLIC_LOYALTY_API_ORIGIN,
    SCOPES: PUBLIC_LOYALTY_SCOPES.join(","),
    NODE_OPTIONS: "--max-old-space-size=1024",
  };
}

export function assertImage(image) {
  assert.match(image.Id, /^sha256:[a-f0-9]{64}$/);
  assert.equal(image.Os, "linux");
  assert.equal(image.Architecture, "amd64");
  assert.equal(image.Config.User, "node");
  assert.deepEqual(image.Config.Entrypoint, [
    "node",
    "/workspace/infra/cloudflare-release/start.mjs",
    "shopify",
  ]);
  assert.equal(image.Config.StopSignal, "SIGTERM");
  const env = Object.fromEntries(
    image.Config.Env.map((entry) => {
      const split = entry.indexOf("=");
      return [entry.slice(0, split), entry.slice(split + 1)];
    }),
  );
  assert.equal(env.NODE_ENV, "production");
  for (const key of Object.keys(smokeEnvironment()))
    assert.equal(env[key], undefined);
  assert.equal(env.WELETIC_LOCAL_CONTAINER_BUILD, undefined);
  assert.equal(env.WELETIC_SHOPIFY_BUILD_TARGET, undefined);
}

export function createArguments(imageId, env) {
  assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
  return [
    "create",
    "--pull=never",
    "--network=none",
    "--memory=2g",
    "--memory-swap=2g",
    "--cpus=2",
    "--pids-limit=128",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--read-only",
    "--tmpfs=/tmp:rw,noexec,nosuid,size=64m",
    "--stop-timeout=30",
    ...Object.entries(env).flatMap(([key, value]) => [
      "--env",
      `${key}=${value}`,
    ]),
    imageId,
  ];
}

export function validateLocalDockerHost(host) {
  assert.match(host, /^unix:\/\/\/[^?#\u0000]+$/);
  return host;
}

let dockerEnv;
function docker(args, timeout = 40_000) {
  assert.ok(dockerEnv, "Local Docker connection not initialized");
  try {
    const result = spawnSync("docker", args, {
      encoding: "utf8",
      timeout,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      env: dockerEnv,
    });
    if (result.error || result.status !== 0) throw new Error();
    return (
      args[0] === "logs" ? result.stdout + result.stderr : result.stdout
    ).trim();
  } catch {
    // Do not expose Docker error objects or container logs/environment values.
    throw new Error("Local release image check failed");
  }
}

export async function withContainer(
  imageId,
  env,
  check,
  run = docker,
  parent = process,
) {
  const name = `weletic-release-smoke-${randomBytes(12).toString("hex")}`;
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
  };
  const assertRunning = () =>
    assert.equal(interrupted, false, "Smoke interrupted");
  parent.on("SIGINT", interrupt);
  parent.on("SIGTERM", interrupt);
  try {
    const args = createArguments(imageId, env);
    args.splice(
      1,
      0,
      "--name",
      name,
      "--label",
      `weletic.release-smoke=${name}`,
    );
    const id = run(args);
    assert.match(id, /^[a-f0-9]{64}$/);
    assertRunning();
    run(["start", id]);
    await check(id, assertRunning);
    assertRunning();
  } finally {
    try {
      // A timed-out create may have succeeded without returning its ID. Recover
      // only this random invocation's exact name+label, never a project prefix.
      for (let pass = 0; pass < 3; pass++) {
        const rows = run([
          "ps",
          "-a",
          "--no-trunc",
          "--filter",
          `label=weletic.release-smoke=${name}`,
          "--format",
          "{{.ID}}\t{{.Names}}",
        ]);
        if (rows) {
          const [id, actualName, extra] = rows.split("\t");
          assert.match(id, /^[a-f0-9]{64}$/);
          assert.equal(actualName, name);
          assert.equal(extra, undefined);
          run(["rm", "--force", id]);
        }
        if (pass < 2) await delay(250);
      }
      assert.equal(
        run([
          "ps",
          "-a",
          "--filter",
          `label=weletic.release-smoke=${name}`,
          "--format",
          "{{.ID}}",
        ]),
        "",
        "Owned smoke container remains",
      );
    } finally {
      parent.off("SIGINT", interrupt);
      parent.off("SIGTERM", interrupt);
    }
  }
  assertRunning();
}

export async function smoke(imageId) {
  assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
  const discovery = spawnSync(
    "docker",
    ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: { PATH: process.env.PATH, HOME: homedir() },
    },
  );
  assert.equal(discovery.status, 0);
  const host = validateLocalDockerHost(discovery.stdout.trim());
  const state = mkdtempSync(join(tmpdir(), "weletic-release-smoke-"));
  dockerEnv = {
    PATH: process.env.PATH,
    HOME: state,
    DOCKER_CONFIG: state,
    DOCKER_HOST: host,
  };
  try {
    const [image] = JSON.parse(docker(["image", "inspect", imageId]));
    assertImage(image);
    await withContainer(imageId, {}, async (id) => {
      assert.equal(docker(["wait", id]), "1");
      assert.equal(
        docker(["logs", id]),
        "Cloudflare runtime admission rejected",
      );
    });
    await withContainer(
      imageId,
      smokeEnvironment(),
      async (id, assertRunning) => {
        let ready = false;
        for (let attempt = 0; attempt < 30; attempt++) {
          assertRunning();
          const [container] = JSON.parse(docker(["inspect", id]));
          assert.equal(
            container.State.Running,
            true,
            "Release server exited before readiness",
          );
          try {
            docker(
              [
                "exec",
                id,
                "node",
                "-e",
                `
          fetch('http://127.0.0.1:3000/__release_smoke_missing__', {
            signal: AbortSignal.timeout(1500), redirect: 'manual'
          }).then(async r => {
            await r.text();
            if (r.status !== 404 || r.headers.get('x-content-type-options') !== 'nosniff' ||
                !r.headers.get('content-security-policy')?.includes("frame-ancestors 'none'")) process.exit(1);
          }).catch(() => process.exit(1));
        `,
              ],
              5000,
            );
            ready = true;
            break;
          } catch {
            await delay(250);
          }
        }
        assert.equal(ready, true, "Release HTTP readiness failed");
        const [running] = JSON.parse(docker(["inspect", id]));
        assert.equal(running.HostConfig.NetworkMode, "none");
        assert.deepEqual(running.HostConfig.PortBindings, {});
        docker(["stop", "--time=30", id]);
        const [stopped] = JSON.parse(docker(["inspect", id]));
        assert.equal(stopped.State.OOMKilled, false);
        assert.ok(
          [0, 143].includes(stopped.State.ExitCode),
          "Release shutdown failed",
        );
      },
    );
    console.log(
      JSON.stringify({
        imageId,
        result: "passed",
        network: "none",
        liveAcceptance: false,
      }),
    );
  } finally {
    dockerEnv = undefined;
    rmSync(state, { recursive: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.argv.length, 3);
    await smoke(process.argv[2]);
  } catch {
    console.error(
      "Local Shopify release smoke failed; no deployment performed",
    );
    process.exitCode = 1;
  }
}
