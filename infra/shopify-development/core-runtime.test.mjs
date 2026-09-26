import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyCoreRuntimeConfiguration,
  readCoreRuntimeConfiguration,
} from "./core-runtime.mjs";
import { createRuntimeLogSink } from "./runtime-policy.mjs";

const config = {
  SHOPIFY_PARTNER_APP_ID: "gid://shopify/App/1",
  SHOPIFY_PARTNER_ORGANIZATION_ID: "123",
  SHOPIFY_PARTNER_API_TOKEN: "synthetic-partner-token",
  WELETIC_SHOPIFY_PUBLIC_PLAN_HANDLE: "core-monthly",
  WELETIC_SHOPIFY_PRIVATE_PLAN_HANDLE: "company-free",
  SHOPIFY_APP_HANDLE: "weletic-loyalty-reviews-dev",
  WELETIC_SUPPORT_EMAIL: "support@example.test",
};
const base = {
  WELETIC_ISOLATED_DEVELOPMENT: "1",
  DATABASE_URL: "mysql://synthetic-local-target",
  SHOPIFY_API_KEY: "synthetic-app",
};

test("core pair preserves isolated targets and confines Partner credentials to web", () => {
  const web = applyCoreRuntimeConfiguration("web", base, config);
  const shopify = applyCoreRuntimeConfiguration(
    "shopify",
    {
      ...base,
      SHOPIFY_PARTNER_API_TOKEN: "stale-credential",
      WELETIC_FEATURE_PROFILE: "legacy",
    },
    config,
  );
  assert.equal(web.SHOPIFY_PARTNER_API_TOKEN, config.SHOPIFY_PARTNER_API_TOKEN);
  assert.equal(web.SHOPIFY_APP_HANDLE, undefined);
  assert.equal(shopify.SHOPIFY_PARTNER_API_TOKEN, undefined);
  assert.equal(shopify.SHOPIFY_PARTNER_APP_ID, undefined);
  assert.equal(shopify.SHOPIFY_APP_HANDLE, config.SHOPIFY_APP_HANDLE);
  for (const env of [web, shopify]) {
    assert.equal(env.WELETIC_FEATURE_PROFILE, "core-v1");
    assert.equal(env.WELETIC_RELEASE_PROFILE, "loyalty-only");
    assert.equal(env.DATABASE_URL, base.DATABASE_URL);
    assert.equal(env.SHOPIFY_API_KEY, base.SHOPIFY_API_KEY);
  }
  assert.equal(base.WELETIC_FEATURE_PROFILE, undefined);
  const output = [];
  const sink = createRuntimeLogSink([web], (line) => output.push(line));
  sink.write(`provider rejected ${config.SHOPIFY_PARTNER_API_TOKEN}\n`);
  sink.end();
  assert.equal(output.join(""), "provider rejected [REDACTED]\n");
});

test("core pair fails closed for missing, invalid or extra authority on either role", () => {
  for (const role of ["web", "shopify"]) {
    for (const key of Object.keys(config)) {
      const incomplete = { ...config };
      delete incomplete[key];
      assert.throws(() =>
        applyCoreRuntimeConfiguration(role, base, incomplete),
      );
    }
    for (const invalid of [
      null,
      [],
      { ...config, DATABASE_URL: "mysql://foreign.invalid/shared" },
      { ...config, WELETIC_FEATURE_PROFILE: "legacy" },
      { ...config, SHOPIFY_PARTNER_API_TOKEN: "" },
      { ...config, SHOPIFY_PARTNER_APP_ID: "wrong-app" },
      { ...config, WELETIC_SUPPORT_EMAIL: "" },
      { ...config, WELETIC_SHOPIFY_PRIVATE_PLAN_HANDLE: "core-monthly" },
    ])
      assert.throws(() => applyCoreRuntimeConfiguration(role, base, invalid));
  }
  assert.throws(() => applyCoreRuntimeConfiguration("outbox", base, config));
  assert.throws(() => applyCoreRuntimeConfiguration("web", {}, config));
});

test("core file rejects shared permissions, symlinks and oversized input", () => {
  const root = mkdtempSync(join(tmpdir(), "core-runtime-"));
  try {
    const path = join(root, "core.json");
    writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
    assert.deepEqual(readCoreRuntimeConfiguration(path), config);
    const link = join(root, "link.json");
    symlinkSync(path, link);
    assert.throws(() => readCoreRuntimeConfiguration(link));
    chmodSync(path, 0o644);
    assert.throws(() => readCoreRuntimeConfiguration(path));
    chmodSync(path, 0o600);
    writeFileSync(path, " ".repeat(8193));
    assert.throws(() => readCoreRuntimeConfiguration(path));
    assert.throws(() => readCoreRuntimeConfiguration(root));
  } finally {
    rmSync(root, { recursive: true });
  }
});
