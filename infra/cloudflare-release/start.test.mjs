import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  PUBLIC_LOYALTY_API_ORIGIN as api,
  PUBLIC_LOYALTY_APP_ORIGIN as app,
  PUBLIC_LOYALTY_CLIENT_ID as client,
  PUBLIC_LOYALTY_SCOPES,
} from "../../packages/shopify-app/app/public-runtime-policy.mjs";
import { assertCloudflareRuntime } from "./runtime-policy.mjs";
import { runtimeCommand, startRuntime } from "./start.mjs";

function fixture(role) {
  return {
    NODE_ENV: "production",
    SHOPIFY_API_KEY: client,
    SHOPIFY_APP_URL: app,
    WELETIC_SHOPIFY_SERVICE_SECRET: "synthetic-service".repeat(4),
    ...(role !== "shopify"
      ? {
          WELETIC_ENFORCE_CRON_AUTH: "1",
          NEXTAUTH_URL: api,
          NEXT_PUBLIC_APP_DOMAIN: api,
          SHOPIFY_WEBHOOK_URL: `${api}/api/shopify/integration/webhook`,
          NEXTAUTH_SECRET: "synthetic-session".repeat(4),
          CRON_SECRET: "synthetic-cron".repeat(4),
          SHOPIFY_WEBHOOK_SECRET: "synthetic-app".repeat(4),
          ...(role === "outbox"
            ? { WELETIC_OUTBOX_STORE_DOMAIN: "yamaxdev.myshopify.com" }
            : {}),
        }
      : {
          SHOPIFY_APP_DISTRIBUTION: "app_store",
          WELETIC_API_URL: api,
          SHOPIFY_API_SECRET: "synthetic-app".repeat(4),
          SCOPES: PUBLIC_LOYALTY_SCOPES.join(","),
        }),
  };
}

function harness(role = "web", changes = {}) {
  const parent = new EventEmitter();
  const child = new EventEmitter();
  const signals = [];
  const launches = [];
  const errors = [];
  const timers = [];
  const cancelled = [];
  child.kill = (signal) => {
    signals.push(signal);
    return true;
  };
  parent.stderr = { write: (message) => errors.push(message) };
  const options = {
    env: { ...fixture(role), ...changes },
    parent,
    exists: () => false,
    launch: (...args) => {
      launches.push(args);
      return child;
    },
    schedule: (fn, ms) => {
      const timer = { fn, ms, unref() {} };
      timers.push(timer);
      return timer;
    },
    cancel: (timer) => cancelled.push(timer),
  };
  return {
    options,
    parent,
    child,
    signals,
    launches,
    errors,
    timers,
    cancelled,
  };
}

for (const role of ["web", "shopify", "outbox"]) {
  test(`${role}: fixed command, snapshot and no cross-role secret requirement`, () => {
    const h = harness(role);
    startRuntime(role, h.options);
    assert.equal(h.launches.length, 1);
    const [bin, args, options] = h.launches[0];
    assert.equal(bin, process.execPath);
    assert.deepEqual(args, runtimeCommand(role, h.options.env).args);
    assert.equal(options.shell, false);
    assert.equal(options.env.PORT, "3000");
    assert.equal(options.env.HOST, "0.0.0.0");
    h.options.env.NODE_ENV = "development";
    assert.equal(options.env.NODE_ENV, "production");
    h.child.emit("close", 0, null);
    assert.equal(h.parent.exitCode, 0);
  });
  for (const [key, value] of [
    ["NODE_ENV", "development"],
    ["SHOPIFY_API_KEY", "legacy"],
    ["SHOPIFY_APP_URL", "http://localhost"],
    ["WELETIC_LOCAL_CONTAINER_BUILD", "1"],
    ["WELETIC_SHOPIFY_BUILD_TARGET", "node"],
    ["WELETIC_WEB_BUILD_PROFILE", "loyalty-only"],
    ["WELETIC_ISOLATED_DEVELOPMENT", "1"],
    ["NEXT_PUBLIC_WELETIC_ISOLATED_DEVELOPMENT", "1"],
    ["WELETIC_SHOPIFY_SERVICE_SECRET", "short"],
  ])
    test(`${role}: rejects ${key} before launch`, () => {
      const h = harness(role, { [key]: value });
      assert.throws(() => startRuntime(role, h.options), /admission rejected/);
      assert.equal(h.launches.length, 0);
    });
  for (const name of [
    ".env",
    ".env.local",
    ".env.production",
    ".env.production.local",
  ]) {
    test(`${role}: rejects ${name} before framework loads it`, () => {
      const h = harness(role);
      h.options.exists = (path) =>
        path === `${runtimeCommand(role).cwd}/${name}`;
      assert.throws(() => startRuntime(role, h.options), /admission rejected/);
      assert.equal(h.launches.length, 0);
    });
  }
}

test("outbox release cannot fall back to global scope or accept CLI injection", () => {
  for (const value of [
    undefined,
    "",
    "ALL",
    "https://yamaxdev.myshopify.com",
    "yamaxdev.myshopify.com --once",
    "yamaxdev.myshopify.com\n",
    "*.myshopify.com",
  ]) {
    const h = harness("outbox", { WELETIC_OUTBOX_STORE_DOMAIN: value });
    assert.throws(() => startRuntime("outbox", h.options));
    assert.equal(h.launches.length, 0);
  }
  const h = harness("outbox");
  startRuntime("outbox", h.options);
  assert.equal(h.launches[0][1].at(-1), "--store=yamaxdev.myshopify.com");
});

test("role-local auth, callback, scope and secret invariants", () => {
  for (const [role, key, value] of [
    ["web", "WELETIC_ENFORCE_CRON_AUTH", "0"],
    ["web", "DEV_WEBHOOK_URL", "https://other.invalid"],
    ["web", "SHOPIFY_WEBHOOK_URL", `${api}/wrong`],
    ["web", "NEXTAUTH_URL", app],
    ["web", "NEXT_PUBLIC_APP_DOMAIN", app],
    ["web", "CRON_SECRET", "short"],
    ["web", "SHOPIFY_WEBHOOK_SECRET", undefined],
    ["web", "SHOPIFY_WEBHOOK_SECRET", fixture("web").CRON_SECRET],
    [
      "web",
      "SHOPIFY_WEBHOOK_SECRET",
      ` ${fixture("web").SHOPIFY_WEBHOOK_SECRET}`,
    ],
    ["web", "NEXTAUTH_SECRET", fixture("web").CRON_SECRET],
    [
      "web",
      "WELETIC_SHOPIFY_SERVICE_SECRET",
      ` ${fixture("web").WELETIC_SHOPIFY_SERVICE_SECRET}`,
    ],
    ["shopify", "SCOPES", "read_products"],
    ["shopify", "SHOPIFY_APP_DISTRIBUTION", "custom"],
    ["shopify", "WELETIC_API_URL", app],
    [
      "shopify",
      "SHOPIFY_API_SECRET",
      fixture("shopify").WELETIC_SHOPIFY_SERVICE_SECRET,
    ],
  ])
    assert.throws(() =>
      assertCloudflareRuntime(role, { ...fixture(role), [key]: value }),
    );
  for (const role of ["worker", "build-web", "", undefined]) {
    const h = harness();
    assert.throws(() => startRuntime(role, h.options));
    assert.equal(h.launches.length, 0);
  }
});

test("only an explicit memory Node option is admitted", () => {
  for (const role of ["web", "shopify"]) {
    assertCloudflareRuntime(role, {
      ...fixture(role),
      NODE_OPTIONS: "--max-old-space-size=1024",
    });
    for (const value of [
      "",
      "--require=dotenv/config",
      "--import=/private/loader.mjs",
      "--inspect",
      "--max-old-space-size=1024 --require=dotenv/config",
    ]) {
      const h = harness(role, { NODE_OPTIONS: value });
      assert.throws(() => startRuntime(role, h.options));
      assert.equal(h.launches.length, 0);
    }
  }
});

for (const signal of ["SIGTERM", "SIGINT"])
  test(`forwards ${signal}, bounds shutdown and removes handlers`, () => {
    const h = harness();
    startRuntime("web", h.options);
    h.parent.emit(signal);
    h.parent.emit(signal);
    assert.deepEqual(h.signals, [signal, signal]);
    assert.equal(h.timers.length, 1);
    assert.equal(h.timers[0].ms, 25_000);
    h.timers[0].fn();
    assert.equal(h.signals.at(-1), "SIGKILL");
    h.child.emit("close", null, "SIGKILL");
    assert.equal(h.parent.exitCode, 137);
    assert.deepEqual(h.cancelled, h.timers);
    assert.equal(h.parent.listenerCount("SIGTERM"), 0);
    assert.equal(h.parent.listenerCount("SIGINT"), 0);
  });

test("preserves nonzero exit and signal status; spawn failures never disclose errors", () => {
  for (const [code, signal, expected] of [
    [17, null, 17],
    [null, "SIGTERM", 143],
    [null, "SIGINT", 130],
  ]) {
    const h = harness();
    startRuntime("web", h.options);
    h.child.emit("close", code, signal);
    assert.equal(h.parent.exitCode, expected);
  }
  const h = harness();
  startRuntime("web", h.options);
  h.child.emit("error", new Error("private-secret"));
  h.child.emit("close", -2, null);
  assert.equal(h.parent.exitCode, 1);
  assert.deepEqual(h.errors, ["Cloudflare runtime process failed\n"]);
});

test("CLI rejects malformed invocation without starting a server or leaking values", () => {
  const path = fileURLToPath(new URL("./start.mjs", import.meta.url));
  for (const args of [[], ["worker"], ["web", "extra"], ["web"], ["shopify"]]) {
    const result = spawnSync(process.execPath, [path, ...args], {
      env: { NODE_ENV: "development", SHOPIFY_API_SECRET: "private-secret" },
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "Cloudflare runtime admission rejected\n");
  }
});
