import { describe, expect, it, vi } from "vitest";
import {
  parseOutboxWorkerArgs,
  runOutboxWorker,
} from "../../scripts/loyalty/outbox-worker-runtime";

const shopDomain = "n0pvef-cs.myshopify.com";
const success = {
  processed: 1,
  succeeded: 1,
  failed: 0,
  deadLettered: 0,
};

function createDependencies() {
  return {
    workerId: "test-worker",
    findStore: vi.fn().mockResolvedValue({ id: "store-exact", shopDomain }),
    processBatch: vi.fn().mockResolvedValue(success),
    shouldStop: vi.fn().mockReturnValue(false),
    waitForNextPoll: vi.fn().mockResolvedValue(undefined),
    logger: { info: vi.fn(), error: vi.fn() },
  };
}

describe("outbox worker CLI arguments", () => {
  it("preserves global continuous operation without arguments", () => {
    expect(parseOutboxWorkerArgs([])).toEqual({ once: false });
  });

  it("accepts an exact store and once in either order", () => {
    for (const args of [
      [`--store=${shopDomain}`, "--once"],
      ["--once", `--store=${shopDomain}`],
    ]) {
      expect(parseOutboxWorkerArgs(args)).toEqual({ shopDomain, once: true });
    }
  });

  it.each([
    ["--once", "--once"],
    [`--store=${shopDomain}`, `--store=${shopDomain}`],
    [`--store=${shopDomain}`, "--store=other.myshopify.com"],
    ["--store"],
    ["--store", shopDomain],
    ["--store="],
    ["--store=https://n0pvef-cs.myshopify.com"],
    ["--store=N0PVEF-CS.myshopify.com"],
    ["--store=n0pvef-cs.myshopify.com/"],
    ["--store=n0pvef-cs.myshopify.com.evil.com"],
    ["--store=n0pvef-cs.myshopify.com:443"],
    ["--store=n0pvef-cs.myshopify.com "],
    ["--store=n0pvef-cs.myshopify.com\n"],
    ["--store=n0pvef-cs.myshopify.com\r\n"],
    ["--store=*.myshopify.com"],
    ["--store=-bad.myshopify.com"],
    ["--store=bad-.myshopify.com"],
    ["--store=bad_name.myshopify.com"],
    [`--store=${"a".repeat(64)}.myshopify.com`],
    ["--once=true"],
    ["--stores=n0pvef-cs.myshopify.com"],
    ["--help"],
    ["--"],
    ["unexpected"],
  ])("rejects unsupported or ambiguous arguments: %j", (...args) => {
    expect(() => parseOutboxWorkerArgs(args)).toThrow();
  });
});

describe("outbox worker runtime", () => {
  it("resolves the exact domain and runs only that store once", async () => {
    const dependencies = createDependencies();
    await runOutboxWorker([`--store=${shopDomain}`, "--once"], dependencies);

    expect(dependencies.findStore).toHaveBeenCalledExactlyOnceWith(shopDomain);
    expect(dependencies.processBatch).toHaveBeenCalledExactlyOnceWith({
      batchSize: 50,
      workerId: "test-worker",
      storeId: "store-exact",
    });
    expect(dependencies.waitForNextPoll).not.toHaveBeenCalled();
    expect(dependencies.logger.info).toHaveBeenCalledWith(
      expect.stringContaining(`scope=store=${shopDomain} storeId=store-exact`),
    );
  });

  it("rejects invalid arguments before reading stores or processing jobs", async () => {
    const dependencies = createDependencies();
    await expect(
      runOutboxWorker(["--store=wrong"], dependencies),
    ).rejects.toThrow("exact lowercase");
    expect(dependencies.findStore).not.toHaveBeenCalled();
    expect(dependencies.processBatch).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { id: "other-store", shopDomain: "alias.myshopify.com" },
    { id: "other-store", shopDomain: "N0PVEF-CS.myshopify.com" },
    { id: "", shopDomain },
  ])("rejects an unknown or non-exact store result: %j", async (store) => {
    const dependencies = createDependencies();
    dependencies.findStore.mockResolvedValue(store);
    await expect(
      runOutboxWorker([`--store=${shopDomain}`, "--once"], dependencies),
    ).rejects.toThrow("No store matches the exact domain");
    expect(dependencies.processBatch).not.toHaveBeenCalled();
  });

  it("does not fall back to global scope when lookup throws", async () => {
    const dependencies = createDependencies();
    dependencies.findStore.mockRejectedValue(new Error("lookup unavailable"));
    await expect(
      runOutboxWorker([`--store=${shopDomain}`], dependencies),
    ).rejects.toThrow("lookup unavailable");
    expect(dependencies.processBatch).not.toHaveBeenCalled();
  });

  it("retains global no-argument compatibility and makes global scope explicit", async () => {
    const dependencies = createDependencies();
    dependencies.processBatch.mockImplementation(async () => {
      dependencies.shouldStop.mockReturnValue(true);
      return success;
    });
    await runOutboxWorker([], dependencies);
    expect(dependencies.findStore).not.toHaveBeenCalled();
    expect(dependencies.processBatch).toHaveBeenCalledExactlyOnceWith({
      batchSize: 50,
      workerId: "test-worker",
    });
    expect(dependencies.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("scope=GLOBAL (all stores) mode=continuous"),
    );
    expect(dependencies.waitForNextPoll).not.toHaveBeenCalled();
  });

  it("fails once mode on thrown batch errors without waiting or retrying", async () => {
    const dependencies = createDependencies();
    dependencies.processBatch.mockRejectedValue(new Error("batch unavailable"));
    await expect(runOutboxWorker(["--once"], dependencies)).rejects.toThrow(
      "batch unavailable",
    );
    expect(dependencies.processBatch).toHaveBeenCalledTimes(1);
    expect(dependencies.waitForNextPoll).not.toHaveBeenCalled();
  });

  it.each([
    { failed: 1, deadLettered: 0 },
    { failed: 0, deadLettered: 1 },
    { failed: 1, deadLettered: 1 },
  ])("fails once mode on unsuccessful batch counts: %j", async (counts) => {
    const dependencies = createDependencies();
    dependencies.processBatch.mockResolvedValue({ ...success, ...counts });
    await expect(runOutboxWorker(["--once"], dependencies)).rejects.toThrow(
      `failed=${counts.failed} deadLettered=${counts.deadLettered}`,
    );
    expect(dependencies.processBatch).toHaveBeenCalledTimes(1);
    expect(dependencies.waitForNextPoll).not.toHaveBeenCalled();
  });

  it("exits successfully after one empty batch", async () => {
    const dependencies = createDependencies();
    dependencies.processBatch.mockResolvedValue({
      processed: 0,
      succeeded: 0,
      failed: 0,
      deadLettered: 0,
    });
    await runOutboxWorker(["--once"], dependencies);
    expect(dependencies.processBatch).toHaveBeenCalledTimes(1);
    expect(dependencies.waitForNextPoll).not.toHaveBeenCalled();
  });

  it("retries continuous batches under the same store scope and stops gracefully", async () => {
    const dependencies = createDependencies();
    dependencies.processBatch
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce({ ...success, failed: 1, deadLettered: 1 })
      .mockImplementationOnce(async () => {
        dependencies.shouldStop.mockReturnValue(true);
        return success;
      });
    await runOutboxWorker([`--store=${shopDomain}`], dependencies);

    expect(dependencies.findStore).toHaveBeenCalledTimes(1);
    expect(dependencies.processBatch).toHaveBeenCalledTimes(3);
    for (const [options] of dependencies.processBatch.mock.calls) {
      expect(options).toEqual({
        storeId: "store-exact",
        batchSize: 50,
        workerId: "test-worker",
      });
    }
    expect(dependencies.waitForNextPoll).toHaveBeenCalledTimes(2);
    expect(dependencies.logger.error).toHaveBeenCalledTimes(1);
  });

  it("does not begin a batch after shutdown was requested", async () => {
    const dependencies = createDependencies();
    dependencies.shouldStop.mockReturnValue(true);
    await runOutboxWorker([], dependencies);
    expect(dependencies.processBatch).not.toHaveBeenCalled();
    expect(dependencies.waitForNextPoll).not.toHaveBeenCalled();
  });
});
