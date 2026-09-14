import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildMemorySample } from "./probe.mjs";
import { waitForStableServer } from "./server-probe-request.mjs";

const role = process.argv[2];
assert.ok(role === "shopify" || role === "web", "Choose a server probe role");
const child = spawn(
  process.execPath,
  [fileURLToPath(new URL("./probe.mjs", import.meta.url)), role],
  {
    stdio: ["ignore", "inherit", "inherit"],
  },
);
const closed = new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", (code, signal) => resolve({ code, signal }));
});
let ready = false;
try {
  await waitForStableServer(
    role,
    () => child.exitCode === null && child.signalCode === null,
  );
  ready = true;
  console.info(`Local ${role} readiness remained stable for five samples`);
} finally {
  // Start a fresh deadline, leaving the child's existing 15-second graceful
  // shutdown allowance intact even when readiness took nearly 30 seconds.
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 20_000);
  child.kill("SIGTERM");
  const result = await closed;
  clearTimeout(watchdog);
  console.info(`Local ${role} shutdown: ${JSON.stringify(result)}`);
  console.info(`Local ${role} memory: ${JSON.stringify(buildMemorySample())}`);
  assert.notEqual(result.signal, "SIGKILL", "Server shutdown exceeded timeout");
  if (ready) {
    assert.ok(
      result.code === 0 || result.code === 143,
      "Server did not exit cleanly after SIGTERM",
    );
  }
}
