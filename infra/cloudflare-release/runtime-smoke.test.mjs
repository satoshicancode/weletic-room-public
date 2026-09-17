import assert from "node:assert/strict";
import test from "node:test";
import {
  assertRuntimeImage,
  runtimeSmokeEnvironment,
} from "./runtime-smoke.mjs";
import { createArguments, validateLocalDockerHost } from "./shopify-smoke.mjs";

const id = "sha256:" + "a".repeat(64);
const fixture = (role) => ({
  Id: id,
  Os: "linux",
  Architecture: "amd64",
  Config: {
    User: "node",
    StopSignal: "SIGTERM",
    Entrypoint: ["node", "/workspace/infra/cloudflare-release/start.mjs", role],
    Env: ["NODE_ENV=production", "NEXT_TELEMETRY_DISABLED=1"],
  },
});
for (const role of ["web", "outbox"]) {
  test(`${role}: requires immutable guarded non-root image and no baked secrets`, () => {
    assert.doesNotThrow(() => assertRuntimeImage(fixture(role), role));
    for (const mutate of [
      (image) => {
        image.Architecture = "arm64";
      },
      (image) => {
        image.Config.User = "root";
      },
      (image) => {
        image.Config.Entrypoint = ["node", "unrelated.js"];
      },
      (image) => {
        image.Config.Env.push("WELETIC_WEB_BUILD_PROFILE=loyalty-only");
      },
      (image) => {
        image.Config.Env.push("DATABASE_URL=mysql://example");
      },
    ]) {
      const image = fixture(role);
      mutate(image);
      assert.throws(() => assertRuntimeImage(image, role));
    }
  });
  test(`${role}: runtime fixtures cannot inherit ambient providers or credentials`, () => {
    const env = runtimeSmokeEnvironment(role);
    assert.equal(new URL(env.DATABASE_URL).hostname, "127.0.0.1");
    assert.equal(new URL(env.PLANETSCALE_DATABASE_URL).hostname, "127.0.0.1");
    for (const key of [
      "RESEND_API_KEY",
      "QSTASH_TOKEN",
      "AWS_ACCESS_KEY_ID",
      "WELETIC_WEB_BUILD_PROFILE",
      "WELETIC_LOCAL_CONTAINER_BUILD",
    ])
      assert.equal(env[key], undefined);
    const args = createArguments(id, env);
    for (const arg of [
      "--network=none",
      "--pull=never",
      "--memory=2g",
      "--memory-swap=2g",
      "--cpus=2",
      "--read-only",
      "--cap-drop=ALL",
    ])
      assert.ok(args.includes(arg));
    assert.ok(
      !args.some((s) => s.startsWith("--publish") || s.startsWith("--volume")),
    );
  });
}
test("explicit socket only; role and image identity cannot choose arbitrary execution", () => {
  assert.throws(() => runtimeSmokeEnvironment("shell"));
  assert.throws(() => assertRuntimeImage(fixture("web"), "shell"));
  for (const host of [
    "tcp://example:2375",
    "ssh://example",
    "",
    "unix:///tmp/sock?override",
  ])
    assert.throws(() => validateLocalDockerHost(host));
  assert.equal(
    validateLocalDockerHost("unix:///tmp/isolated.sock"),
    "unix:///tmp/isolated.sock",
  );
  assert.equal(
    runtimeSmokeEnvironment("outbox").WELETIC_OUTBOX_STORE_DOMAIN,
    "smoke-fixture.myshopify.com",
  );
});
