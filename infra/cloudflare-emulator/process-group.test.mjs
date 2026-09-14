import assert from "node:assert/strict";
import test from "node:test";
import { processGroupExists, signalProcessGroup } from "./process-group.mjs";

test("shutdown targets the child process group, never a broad or missing PID", () => {
  const calls = [];
  const kill = (...args) => calls.push(args);
  signalProcessGroup(123, "SIGTERM", kill);
  signalProcessGroup(123, "SIGKILL", kill);
  assert.deepEqual(calls, [
    [-123, "SIGTERM"],
    [-123, "SIGKILL"],
  ]);
  for (const pid of [undefined, null, 0, 1, -123, "123"]) {
    assert.throws(() => signalProcessGroup(pid, "SIGTERM", kill));
  }
  assert.throws(() => signalProcessGroup(123, "SIGINT", kill));
  assert.equal(calls.length, 2);
});

test("only an already-exited process group is ignored", () => {
  signalProcessGroup(123, "SIGTERM", () => {
    throw Object.assign(new Error(), { code: "ESRCH" });
  });
  assert.throws(() =>
    signalProcessGroup(123, "SIGTERM", () => {
      throw Object.assign(new Error(), { code: "EPERM" });
    }),
  );
});

test("wrapper exit does not imply its process group has exited", () => {
  assert.equal(
    processGroupExists(123, () => {}),
    true,
  );
  assert.equal(
    processGroupExists(123, () => {
      throw Object.assign(new Error(), { code: "ESRCH" });
    }),
    false,
  );
  assert.throws(() =>
    processGroupExists(123, () => {
      throw Object.assign(new Error(), { code: "EPERM" });
    }),
  );
  assert.throws(() => processGroupExists(0, () => {}));
});
