import { describe, expect, it, vi } from "vitest";
import {
  importStageEvidence,
  observeImportStage,
} from "./helpers/import-stage-evidence";

describe("isolated import stage evidence", () => {
  it("retains only allowlisted markers, never private failure material", () => {
    const result = importStageEvidence("commit_batch", {
      name: "PrismaClientKnownRequestError",
      code: "P2028",
      message: "private shopper",
      meta: { sql: "private SQL" },
      cause: "token",
      stack: "signed URL",
    });
    expect(result).toEqual({
      stage: "commit_batch",
      prismaCode: "P2028",
      errorKind: "PrismaClientKnownRequestError",
    });
    expect(JSON.stringify(result)).not.toMatch(/private|token|signed/);
  });
  it.each([
    null,
    "private",
    42,
    { name: "private", code: "private" },
    { code: "P2028 private" },
  ])("handles unknown errors without reflection leaks: %j", (error) => {
    expect(importStageEvidence("rollback_batch", error)).toEqual({
      stage: "rollback_batch",
      prismaCode: null,
      errorKind: "unclassified",
    });
  });
  it("does not invoke error getters or stringify the original error", () => {
    const getter = vi.fn(() => {
      throw new Error("private");
    });
    const error = Object.defineProperties(
      {},
      {
        name: { get: getter },
        code: { get: getter },
        toJSON: { value: getter },
      },
    );
    expect(importStageEvidence("commit_recovery", error).errorKind).toBe(
      "unclassified",
    );
    expect(getter).not.toHaveBeenCalled();
  });
  it("returns successful values untouched without reporting", async () => {
    const value = { completed: false };
    const run = vi.fn(async () => value);
    const report = vi.fn();
    expect(await observeImportStage("commit_batch", run, report)).toBe(value);
    expect(run).toHaveBeenCalledTimes(1);
    expect(report).not.toHaveBeenCalled();
  });
  it("reports the stage and rethrows the identical failure without retry", async () => {
    const error = Object.assign(new Error("private"), {
      name: "HistoricalImportConflictError",
    });
    const run = vi.fn(async () => {
      throw error;
    });
    const report = vi.fn();
    await expect(
      observeImportStage("rollback_continuation", run, report),
    ).rejects.toBe(error);
    expect(run).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith({
      stage: "rollback_continuation",
      prismaCode: null,
      errorKind: "HistoricalImportConflictError",
    });
  });
  it("preserves the failure even when the reporter throws", async () => {
    const original = new Error("original");
    await expect(
      observeImportStage(
        "commit_batch",
        async () => {
          throw original;
        },
        () => {
          throw new Error("report failed");
        },
      ),
    ).rejects.toBe(original);
  });
});
