import { describe, expect, it, vi } from "vitest";
import {
  ImportPollEvidence,
  pollImportWorkerUntilEligible,
  sanitizeImportPollEvidence,
} from "./helpers/import-worker-poll";

const empty = { processed: 0, succeeded: 0, failed: 0, deadLettered: 0 };
const done = { ...empty, processed: 1, succeeded: 1 };
const evidence = (): ImportPollEvidence => ({
  applicationNow: 1_000,
  databaseNow: 1_002,
  job: {
    status: "pending",
    scheduledFor: 1_002,
    nextRetryAt: null,
    attempts: 0,
    lockedAt: null,
  },
  source: {
    status: "committing",
    revision: 2,
    leaseExpiresAt: 1_002,
    completedRows: 50,
  },
});
function fixture(data = evidence()) {
  let clock = 1_000;
  const run = vi.fn().mockResolvedValueOnce(empty).mockResolvedValue(done);
  const readEvidence = vi.fn(async () => data);
  const sleep = vi.fn(async (ms: number) => {
    clock += ms;
  });
  const report = vi.fn();
  return {
    run,
    readEvidence,
    sleep,
    report,
    now: () => clock,
    monotonicNow: () => clock,
    phase: "committing" as const,
    previousRows: 50,
  };
}

describe("isolated import polling harness", () => {
  it("waits only until an observed future due time and preserves the result", async () => {
    const input = fixture();
    expect(await pollImportWorkerUntilEligible(input)).toEqual(done);
    expect(input.sleep).toHaveBeenCalledExactlyOnceWith(3);
    expect(input.run).toHaveBeenCalledTimes(2);
    expect(input.report).toHaveBeenCalledTimes(1);
  });
  it("uses the later retry timestamp", async () => {
    const data = evidence();
    data.job!.nextRetryAt = 1_500;
    const input = fixture(data);
    await pollImportWorkerUntilEligible(input);
    expect(input.sleep).toHaveBeenCalledExactlyOnceWith(501);
  });
  it("preserves the expected rollback phase", async () => {
    const data = evidence();
    data.source!.status = "rolling_back";
    const input = fixture(data);
    expect(
      await pollImportWorkerUntilEligible({ ...input, phase: "rolling_back" }),
    ).toEqual(done);
  });
  it("includes diagnostic-read time in the eligibility budget", async () => {
    const input = fixture();
    let elapsed = 0;
    input.readEvidence.mockImplementation(async () => {
      elapsed = 10_000;
      return evidence();
    });
    await expect(
      pollImportWorkerUntilEligible({ ...input, monotonicNow: () => elapsed }),
    ).rejects.toThrow("bounded poll budget");
    expect(input.sleep).not.toHaveBeenCalled();
  });
  it.each([
    { ...empty, processed: 1 },
    { ...empty, failed: 1 },
    { ...empty, deadLettered: 1 },
    { ...empty, succeeded: 1 },
  ])("does not retry or conceal a nonempty summary: %j", async (result) => {
    const input = fixture();
    input.run.mockReset().mockResolvedValue(result);
    expect(await pollImportWorkerUntilEligible(input)).toEqual(result);
    expect(input.readEvidence).not.toHaveBeenCalled();
    expect(input.sleep).not.toHaveBeenCalled();
  });
  it.each([
    [
      "already due",
      (data: ImportPollEvidence) => (data.job!.scheduledFor = 999),
    ],
    ["missing job", (data: ImportPollEvidence) => (data.job = null)],
    ["missing source", (data: ImportPollEvidence) => (data.source = null)],
    ["claimed job", (data: ImportPollEvidence) => (data.job!.lockedAt = 999)],
    ["failed job", (data: ImportPollEvidence) => (data.job!.status = "failed")],
    [
      "attempt consumed",
      (data: ImportPollEvidence) => (data.job!.attempts = 1),
    ],
    [
      "source changed",
      (data: ImportPollEvidence) => (data.source!.status = "contained"),
    ],
    [
      "rows advanced",
      (data: ImportPollEvidence) => (data.source!.completedRows = 51),
    ],
    [
      "live source lease",
      (data: ImportPollEvidence) => (data.source!.leaseExpiresAt = 1_003),
    ],
    [
      "invalid timestamp",
      (data: ImportPollEvidence) => (data.job!.lockedAt = NaN),
    ],
  ] as const)("fails without retrying: %s", async (_label, change) => {
    const data = evidence();
    change(data);
    const input = fixture(data);
    await expect(pollImportWorkerUntilEligible(input)).rejects.toThrow(
      "Unexplained empty",
    );
    expect(input.sleep).not.toHaveBeenCalled();
    expect(input.report).toHaveBeenCalledTimes(1);
  });
  it("rejects a due time beyond the ten-second budget", async () => {
    const data = evidence();
    data.job!.scheduledFor = 11_001;
    const input = fixture(data);
    await expect(pollImportWorkerUntilEligible(input)).rejects.toThrow(
      "bounded poll budget",
    );
    expect(input.sleep).not.toHaveBeenCalled();
  });
  it("bounds repeated rescheduling to three polls", async () => {
    const input = fixture();
    input.run.mockReset().mockResolvedValue(empty);
    input.readEvidence.mockImplementation(async () => {
      const data = evidence();
      data.job!.scheduledFor = input.now() + 2;
      return data;
    });
    await expect(pollImportWorkerUntilEligible(input)).rejects.toThrow(
      "bounded poll budget",
    );
    expect(input.run).toHaveBeenCalledTimes(3);
    expect(input.sleep).toHaveBeenCalledTimes(2);
  });
  it("does not tolerate another empty poll after the due time passes", async () => {
    const input = fixture();
    input.run.mockReset().mockResolvedValue(empty);
    await expect(pollImportWorkerUntilEligible(input)).rejects.toThrow(
      "Unexplained empty",
    );
    expect(input.run).toHaveBeenCalledTimes(2);
  });
  it("never emits extra fields or unrecognized status text", () => {
    const data = evidence();
    Object.assign(data, { customerEmail: "private@example.test" });
    Object.assign(data.job!, {
      payload: "secret-payload",
      lockedBy: "secret-token",
    });
    Object.assign(data.source!, {
      leaseId: "secret-lease",
      sourceSha256: "secret-hash",
    });
    data.job!.status = "private-status";
    const safe = sanitizeImportPollEvidence(data);
    expect(safe.job!.status).toBe("unknown");
    expect(JSON.stringify(safe)).not.toMatch(
      /private|secret|payload|lockedBy|leaseId|sourceSha256|customerEmail/,
    );
  });
});
