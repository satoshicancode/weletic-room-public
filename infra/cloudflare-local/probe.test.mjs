import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertBuildResources,
  buildMemorySample,
  monitorBuildMemory,
  probeCommand,
  probeEnvironment,
  runProbe,
} from "./probe.mjs";
import {
  assertServerProbeResponse,
  serverProbeRequest,
  waitForStableServer,
} from "./server-probe-request.mjs";

test("readiness waits for five consecutive responses after cold-start timeouts", async () => {
  let time = 0;
  let calls = 0;
  const response = {
    status: 307,
    headers: new Headers({
      location: "/login?next=%2F__local_container_probe__",
    }),
  };
  await waitForStableServer("web", () => true, {
    now: () => time,
    wait: async () => {
      time += calls === 1 ? 24_000 : 1000;
    },
    fetchResponse: async () => {
      calls += 1;
      if (calls === 1) throw new Error("cold start timeout");
      return response;
    },
  });
  assert.equal(calls, 6);
  assert.equal(time, 28_000);

  time = 0;
  calls = 0;
  await waitForStableServer("web", () => true, {
    now: () => time,
    wait: async () => {
      time += 1000;
    },
    fetchResponse: async () => {
      calls += 1;
      if (calls === 3) throw new Error("transient timeout");
      return response;
    },
  });
  assert.equal(calls, 8, "A timeout resets the consecutive-response count");
});

test("readiness rejects an exited server, bad HTTP response and exhausted deadline", async () => {
  await assert.rejects(
    waitForStableServer("web", () => false),
    /Server exited/,
  );
  await assert.rejects(
    waitForStableServer("web", () => true, {
      fetchResponse: async () => ({ status: 500 }),
    }),
    /must redirect/,
  );
  let time = 0;
  await assert.rejects(
    waitForStableServer("web", () => true, {
      now: () => time,
      wait: async () => {
        time += 1000;
      },
      fetchResponse: async () => {
        throw new Error("timeout");
      },
    }),
    /within 30 seconds/,
  );
  assert.equal(time, 30_000);
});

test("web HTTP smoke uses anonymous app routing and validates the login redirect", () => {
  assertServerProbeResponse("web", {
    status: 307,
    headers: new Headers({
      location: "/login?next=%2F__local_container_probe__",
    }),
  });
  assert.deepEqual(serverProbeRequest("web"), {
    url: "http://127.0.0.1:3000/__local_container_probe__",
    headers: { host: "app.localhost:8888" },
  });
  assert.deepEqual(serverProbeRequest("shopify").headers, {});
  assert.throws(() => serverProbeRequest("arbitrary"));
  const response = (status, location) => ({
    status,
    headers: new Headers({ location }),
  });
  assertServerProbeResponse(
    "web",
    response(
      307,
      "http://app.localhost:8888/login?next=%2F__local_container_probe__",
    ),
  );
  for (const [status, location] of [
    [200, "http://app.localhost/login"],
    [500, "http://app.localhost/login"],
    [307, "http://app.localhost/wrong"],
    [307, "http://app.localhost/login?next=/wrong"],
  ]) {
    assert.throws(() =>
      assertServerProbeResponse("web", response(status, location)),
    );
  }
  assertServerProbeResponse("shopify", response(404, "http://app.localhost/"));
  assert.throws(() =>
    assertServerProbeResponse(
      "shopify",
      response(500, "http://app.localhost/"),
    ),
  );
});

test("build memory telemetry emits only allowlisted numeric counters", () => {
  const values = {
    "memory.current": "123\n",
    "memory.peak": "456\n",
    "memory.swap.current": "0\n",
    "memory.events":
      "low 0\nhigh 0\nmax 10\noom 2\noom_kill 1\nprivate ignored\n",
  };
  const paths = [];
  const result = buildMemorySample((path) => {
    paths.push(path);
    return values[path.split("/").at(-1)];
  });
  assert.deepEqual(result, {
    currentBytes: "123",
    peakBytes: "456",
    swapBytes: "0",
    oom: "2",
    oomKill: "1",
  });
  assert.equal(paths.length, 4);
  assert.ok(paths.every((path) => path.startsWith("/sys/fs/cgroup/memory.")));
  for (const read of [
    () => {
      throw new Error("private error must not be logged");
    },
    () => "invalid private value",
  ]) {
    assert.deepEqual(buildMemorySample(read), {
      currentBytes: null,
      peakBytes: null,
      swapBytes: null,
      oom: null,
      oomKill: null,
    });
  }
});

test("memory monitor samples initially, periodically and once on cleanup", () => {
  const logs = [];
  let tick;
  let unref = 0;
  let cancelled = 0;
  const handle = { unref: () => unref++ };
  const stop = monitorBuildMemory({
    sample: () => ({ currentBytes: "123" }),
    log: (line) => logs.push(line),
    schedule: (callback, delay) => {
      assert.equal(delay, 10_000);
      tick = callback;
      return handle;
    },
    cancel: (timer) => {
      assert.equal(timer, handle);
      cancelled++;
    },
  });
  assert.equal(logs.length, 1);
  tick();
  stop();
  stop();
  assert.equal(logs.length, 3);
  assert.equal(unref, 1);
  assert.equal(cancelled, 1);
  assert.ok(
    logs.every(
      (line) => line === '[local-build-memory] {"currentBytes":"123"}',
    ),
  );
});

test("Next build refuses missing, unlimited or excessive cgroup resources", () => {
  const valid = {
    "memory.max": "6442450944",
    "memory.swap.max": "0",
    "cpu.max": "200000 100000",
  };
  const reader = (values) => (path) => values[path.split("/").at(-1)];
  assertBuildResources(reader(valid));
  for (const override of [
    { "memory.max": "max" },
    { "memory.max": "6442450945" },
    { "memory.max": "0" },
    { "memory.swap.max": "1" },
    { "cpu.max": "max 100000" },
    { "cpu.max": "200001 100000" },
    { "cpu.max": "0 100000" },
    { "cpu.max": "100000 0" },
    { "cpu.max": "100000 100000 extra" },
  ])
    assert.throws(() =>
      assertBuildResources(reader({ ...valid, ...override })),
    );
  assert.throws(() =>
    assertBuildResources(() => {
      throw new Error("cgroup unavailable");
    }),
  );
});

test("probe does not inherit host credentials or execution overrides", () => {
  const before = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = "--require=/private/override.cjs";
  try {
    const env = probeEnvironment();
    assert.equal(env.CLOUDFLARE_API_TOKEN, undefined);
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(env.NODE_OPTIONS, "--max-old-space-size=1024");
    for (const [name, value] of Object.entries(env)) {
      if (name.endsWith("_URL"))
        assert.equal(new URL(value).hostname, "127.0.0.1");
    }
  } finally {
    if (before === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = before;
  }
});

test("only fixed local commands are allowed", () => {
  for (const role of ["shopify", "web", "worker", "worker-boot", "build-web"]) {
    assert.ok(probeCommand(role).args.length > 0);
  }
  for (const role of [
    "deploy",
    "worker --store=yamaxdev.myshopify.com",
    "",
    "../worker",
  ]) {
    assert.throws(() => probeCommand(role), /Unsupported/);
  }
  assert.ok(probeCommand("worker").args.at(-1).endsWith("worker-probe.ts"));
});

test(
  "host execution rejects servers, live CLI boot and Next env-file loading",
  { skip: existsSync("/.dockerenv") || existsSync("/opt/weletic-local-probe") },
  () => {
    for (const role of ["web", "shopify", "worker-boot", "build-web"]) {
      assert.throws(() => runProbe(role), /isolated local Docker container/);
    }
  },
);

test(
  "SIGTERM completes the in-flight synthetic batch before exiting",
  { timeout: 10000 },
  async () => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("./probe.mjs", import.meta.url)), "worker"],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    let sent = false;
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 8000);
    try {
      const result = await new Promise((resolve, reject) => {
        child.on("error", reject);
        child.stdout.on("data", (data) => {
          output += data.toString();
          if (!sent && output.includes("Synthetic batch started")) {
            sent = true;
            child.kill("SIGTERM");
          }
        });
        child.stderr.on("data", (data) => {
          output += data.toString();
        });
        child.on("close", (code, signal) => resolve({ code, signal }));
      });
      assert.equal(sent, true, output);
      assert.deepEqual(result, { code: 0, signal: null }, output);
      assert.equal(
        output.split("Synthetic batch started").length - 1,
        1,
        output,
      );
      assert.match(output, /Synthetic worker stopped after batch completion/);
    } finally {
      clearTimeout(watchdog);
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }
  },
);
