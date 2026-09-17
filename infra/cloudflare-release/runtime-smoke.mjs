import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  PUBLIC_LOYALTY_API_ORIGIN as api,
  PUBLIC_LOYALTY_APP_ORIGIN as app,
  PUBLIC_LOYALTY_CLIENT_ID as client,
} from "../../packages/shopify-app/app/public-runtime-policy.mjs";
import { validateLocalDockerHost, withContainer } from "./shopify-smoke.mjs";

export function runtimeSmokeEnvironment(role) {
  assert.ok(["web", "outbox"].includes(role));
  return {
    SHOPIFY_API_KEY: client,
    SHOPIFY_APP_URL: app,
    NEXTAUTH_URL: api,
    NEXT_PUBLIC_APP_DOMAIN: api,
    WELETIC_ENFORCE_CRON_AUTH: "1",
    SHOPIFY_WEBHOOK_URL: `${api}/api/shopify/integration/webhook`,
    SHOPIFY_WEBHOOK_SECRET: "synthetic-release-webhook-not-a-real-secret",
    NEXTAUTH_SECRET: "synthetic-release-session-not-a-real-secret",
    CRON_SECRET: "synthetic-release-cron-not-a-real-secret",
    WELETIC_SHOPIFY_SERVICE_SECRET:
      "synthetic-release-gateway-not-a-real-secret",
    DATABASE_URL: "mysql://smoke:smoke@127.0.0.1:1/smoke",
    PLANETSCALE_DATABASE_URL: "http://smoke:smoke@127.0.0.1:1/smoke",
    TINYBIRD_API_KEY: "synthetic",
    TINYBIRD_API_URL: "http://127.0.0.1:1",
    UPSTASH_VECTOR_REST_URL: "http://127.0.0.1:1",
    UPSTASH_VECTOR_REST_TOKEN: "synthetic",
    STRIPE_SECRET_KEY: "sk_test_synthetic_release",
    NODE_OPTIONS: "--max-old-space-size=1024",
    ...(role === "outbox"
      ? { WELETIC_OUTBOX_STORE_DOMAIN: "smoke-fixture.myshopify.com" }
      : {}),
  };
}

export function assertRuntimeImage(image, role) {
  assert.ok(["web", "outbox"].includes(role));
  assert.match(image.Id, /^sha256:[a-f0-9]{64}$/);
  assert.equal(image.Os, "linux");
  assert.equal(image.Architecture, "amd64");
  assert.equal(image.Config.User, "node");
  assert.equal(image.Config.StopSignal, "SIGTERM");
  assert.deepEqual(image.Config.Entrypoint, [
    "node",
    "/workspace/infra/cloudflare-release/start.mjs",
    role,
  ]);
  const env = Object.fromEntries(
    image.Config.Env.map((s) => {
      const i = s.indexOf("=");
      return [s.slice(0, i), s.slice(i + 1)];
    }),
  );
  assert.equal(env.NODE_ENV, "production");
  for (const key of [
    ...Object.keys(runtimeSmokeEnvironment(role)),
    "WELETIC_WEB_BUILD_PROFILE",
    "WELETIC_LOCAL_CONTAINER_BUILD",
  ])
    assert.equal(env[key], undefined, `Unexpected baked configuration: ${key}`);
}

export async function runtimeSmoke(role, imageId, host) {
  assert.ok(["web", "outbox"].includes(role));
  assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
  validateLocalDockerHost(host);
  const state = mkdtempSync(join(tmpdir(), "weletic-runtime-smoke-"));
  const run = (args, timeout = 40_000) => {
    const result = spawnSync("docker", args, {
      env: {
        PATH: process.env.PATH,
        HOME: state,
        DOCKER_CONFIG: state,
        DOCKER_HOST: host,
      },
      encoding: "utf8",
      timeout,
      maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status !== 0)
      throw new Error("Isolated Docker operation failed");
    return (
      args[0] === "logs" ? result.stdout + result.stderr : result.stdout
    ).trim();
  };
  try {
    assertRuntimeImage(JSON.parse(run(["image", "inspect", imageId]))[0], role);
    await withContainer(
      imageId,
      {},
      async (id) => {
        assert.equal(run(["wait", id]), "1");
        assert.equal(
          run(["logs", id]),
          "Cloudflare runtime admission rejected",
        );
      },
      run,
    );
    await withContainer(
      imageId,
      runtimeSmokeEnvironment(role),
      async (id, active) => {
        if (role === "outbox") {
          // Real guarded entrypoint and native Prisma load, but no reachable DB.
          // Failure before scope resolution must prevent all job delivery.
          assert.equal(run(["wait", id]), "1");
          const logs = run(["logs", id]);
          assert.match(logs, /PrismaClientInitializationError/);
          assert.match(logs, /Can't reach database server at/);
          assert.match(logs, /worker .* stopped/);
          assert.doesNotMatch(
            logs,
            /started scope=|processed=|Cannot find module/,
          );
        } else {
          let ready = false;
          for (let attempt = 0; attempt < 40; attempt++) {
            active();
            assert.equal(
              JSON.parse(run(["inspect", id]))[0].State.Running,
              true,
              "Web exited before readiness",
            );
            try {
              run(
                [
                  "exec",
                  id,
                  "node",
                  "-e",
                  `
              const http = require('node:http');
              const check = (path, status, host='loyalty-api-dev.weletic.com') => new Promise((resolve,reject) => {
                const req = http.request({hostname:'127.0.0.1',port:3000,path,method:'POST',headers:{host}}, res => {
                  res.resume(); res.on('end',()=>res.statusCode===status?resolve():reject(new Error('status')));
                }); req.setTimeout(2500,()=>req.destroy(new Error('timeout'))); req.on('error',reject); req.end();
              });
              (async()=>{
                await check('/api/auth/signin',404);
                await check('/api/internal/shopify/installation/status',404,'other.invalid');
                await check('/api/internal/shopify/installation/status',401);
              })().catch(()=>process.exit(1));
            `,
                ],
                12_000,
              );
              ready = true;
              break;
            } catch {
              await delay(250);
            }
          }
          assert.equal(ready, true, "Real Next route/auth smoke failed");
          run(["stop", "--time=30", id]);
        }
        const container = JSON.parse(run(["inspect", id]))[0];
        assert.equal(container.HostConfig.NetworkMode, "none");
        assert.deepEqual(container.HostConfig.PortBindings, {});
        assert.equal(container.State.OOMKilled, false);
        assert.ok(
          (role === "web" ? [0, 143] : [1]).includes(container.State.ExitCode),
        );
      },
      run,
    );
    console.log(
      JSON.stringify({
        role,
        imageId,
        result: "passed",
        liveAcceptance: false,
        network: "none",
      }),
    );
  } finally {
    rmSync(state, { recursive: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.argv.length, 5);
    await runtimeSmoke(process.argv[2], process.argv[3], process.argv[4]);
  } catch {
    console.error("Isolated runtime smoke failed; no deployment performed");
    process.exitCode = 1;
  }
}
