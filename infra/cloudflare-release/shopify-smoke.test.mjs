import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { assertCloudflareRuntime } from "./runtime-policy.mjs";
import {
  assertImage,
  createArguments,
  smokeEnvironment,
  validateLocalDockerHost,
  withContainer,
} from "./shopify-smoke.mjs";

const id = `sha256:${"a".repeat(64)}`;
function candidate() {
  return {
    Id: id,
    Os: "linux",
    Architecture: "amd64",
    Config: {
      User: "node",
      StopSignal: "SIGTERM",
      Env: ["NODE_ENV=production"],
      Entrypoint: [
        "node",
        "/workspace/infra/cloudflare-release/start.mjs",
        "shopify",
      ],
    },
  };
}

test("synthetic environment satisfies the real guard without host credentials", () => {
  const env = smokeEnvironment();
  assertCloudflareRuntime("shopify", { ...env, NODE_ENV: "production" });
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.WELETIC_ISOLATED_DEVELOPMENT, undefined);
  assert.match(env.SHOPIFY_API_SECRET, /^synthetic-/);
  assert.notEqual(env.SHOPIFY_API_SECRET, env.WELETIC_SHOPIFY_SERVICE_SECRET);
});

test("requires local immutable image identity and intended Linux runtime", () => {
  assertImage(candidate());
  for (const mutate of [
    (i) => {
      i.Id = "mutable:tag";
    },
    (i) => {
      i.Architecture = "arm64";
    },
    (i) => {
      i.Config.User = "root";
    },
    (i) => {
      i.Config.Entrypoint = ["sh", "-c", "anything"];
    },
    (i) => {
      i.Config.Env.push("WELETIC_SHOPIFY_BUILD_TARGET=node");
    },
    (i) => {
      i.Config.Env.push("SHOPIFY_API_SECRET=should-not-be-baked");
    },
  ]) {
    const image = candidate();
    mutate(image);
    assert.throws(() => assertImage(image));
  }
});

test("container creation cannot publish ports or reach an external network", () => {
  const args = createArguments(id, smokeEnvironment());
  for (const flag of [
    "--network=none",
    "--memory=2g",
    "--memory-swap=2g",
    "--cpus=2",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
  ]) {
    assert.ok(args.includes(flag));
  }
  assert.equal(args.at(-1), id);
  assert.ok(
    !args.some((a) => /^(--publish|-p|--volume|-v|--env-file)(=|$)/.test(a)),
  );
  assert.throws(() => createArguments("mutable:tag", {}));
});

test("rejects remote Docker engines", () => {
  assert.equal(
    validateLocalDockerHost("unix:///var/run/docker.sock"),
    "unix:///var/run/docker.sock",
  );
  for (const host of [
    "tcp://remote:2375",
    "ssh://remote",
    "unix://remote/socket",
    "unix:///socket?redirect=remote",
  ])
    assert.throws(() => validateLocalDockerHost(host));
});

for (const scenario of ["normal", "SIGINT", "SIGTERM", "uncertain-create"]) {
  test(`exact cleanup after ${scenario}`, async () => {
    let name,
      exists = false,
      removed = 0;
    const parent = new EventEmitter();
    const run = (args) => {
      if (args[0] === "create") {
        name = args[args.indexOf("--name") + 1];
        exists = true;
        if (scenario === "uncertain-create") throw new Error("timeout");
        return "b".repeat(64);
      }
      if (args[0] === "ps") return exists ? `${"b".repeat(64)}\t${name}` : "";
      if (args[0] === "rm") {
        assert.equal(args[2], "b".repeat(64));
        exists = false;
        removed++;
      }
      return "";
    };
    const work = withContainer(
      id,
      {},
      async (_, assertRunning) => {
        if (scenario.startsWith("SIG")) parent.emit(scenario);
        assertRunning();
      },
      run,
      parent,
    );
    if (scenario === "normal") await work;
    else await assert.rejects(work);
    assert.equal(removed, 1);
    assert.equal(exists, false);
    assert.equal(parent.listenerCount("SIGTERM"), 0);
    assert.equal(parent.listenerCount("SIGINT"), 0);
  });
}
