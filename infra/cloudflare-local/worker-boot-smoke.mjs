import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const child = spawn(
  process.execPath,
  [fileURLToPath(new URL("./probe.mjs", import.meta.url)), "worker-boot"],
  {
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let output = "";
const capture = (chunk) => {
  output = (output + chunk.toString()).slice(-16000);
};
child.stdout.on("data", capture);
child.stderr.on("data", capture);
const watchdog = setTimeout(() => child.kill("SIGTERM"), 20000);
try {
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(result, { code: 1, signal: null }, output);
  assert.match(output, /Unknown argument; supported flags/, output);
  assert.match(output, /worker .* stopped/, output);
  assert.doesNotMatch(output, /started scope=|processed=/);
  console.info(
    "Real worker CLI booted and rejected invalid arguments before delivery",
  );
} finally {
  clearTimeout(watchdog);
}
