import assert from "node:assert/strict";
import test from "node:test";
import { stopRunContainers } from "./container-cleanup.mjs";

const run = "weletic-local-probe-012345abcdef";
const id = "a".repeat(64);
const name = `workerd-${run}-LoyaltyProbe-${"b".repeat(64)}-proxy`;

test("cleanup stops only exact IDs belonging to this random run", () => {
  const calls = [];
  let lists = 0;
  const result = stopRunContainers(run, (args) => {
    calls.push(args);
    return args[0] === "ps" && lists++ === 0 ? `${id}\t${name}\n` : "";
  });
  assert.equal(result, 1);
  assert.deepEqual(calls[1], ["stop", "--timeout", "10", id]);
  assert.equal(calls.length, 3);
});

test("cleanup refuses broad, foreign, malformed and oversized inventories", () => {
  assert.throws(() => stopRunContainers("weletic", () => assert.fail()));
  for (const output of [
    `${id}\tweletic-import-scale-mysql`,
    `${id}\t${name.replace("012345abcdef", "ffffffffffff")}`,
    `short-id\t${name}`,
    `${id}\t${name}\textra`,
    Array(3).fill(`${id}\t${name}`).join("\n"),
  ]) {
    assert.throws(() =>
      stopRunContainers(run, (args) => {
        assert.equal(args[0], "ps");
        return output;
      }),
    );
  }
});

test("cleanup propagates Docker failure and verifies final absence", () => {
  assert.throws(() =>
    stopRunContainers(run, () => {
      throw new Error("unavailable");
    }),
  );
  assert.throws(() => stopRunContainers(run, () => `${id}\t${name}`), /remain/);
  assert.equal(
    stopRunContainers(run, () => ""),
    0,
  );
});

test("a disappearing application container does not prevent proxy cleanup", () => {
  const proxyId = "c".repeat(64);
  const stopped = [];
  let lists = 0;
  const count = stopRunContainers(run, (args) => {
    if (args[0] === "ps") {
      return lists++ === 0
        ? `${id}\t${name.slice(0, -6)}\n${proxyId}\t${name}`
        : "";
    }
    stopped.push(args[3]);
    if (args[3] === id) throw new Error("No such container");
    return "";
  });
  assert.equal(count, 2);
  assert.deepEqual(stopped, [id, proxyId]);
});
