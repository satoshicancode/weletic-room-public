import { beforeEach, expect, it, vi } from "vitest";
import {
  defaultLoyaltyNudgeSettings,
  verifyLoyaltyNudgeResponse,
} from "../../lib/weletic/loyalty/nudge-contract";
import {
  readLoyaltyNudgesInTransaction,
  saveLoyaltyNudgesInTransaction,
} from "../../lib/weletic/loyalty/nudge-service";
const mocks = vi.hoisted(() => ({ lock: vi.fn(), maintenance: vi.fn() }));
vi.mock("../../lib/weletic/loyalty/program-write-fence", () => ({
  lockLoyaltyProgramRowIfPresent: mocks.lock,
}));
vi.mock("../../lib/weletic/loyalty/maintenance-write-fence", () => ({
  assertLoyaltyMaintenanceWriteAllowed: mocks.maintenance,
}));
let program: any;
const findUnique = vi.fn();
const updateMany = vi.fn();
const tx = { weleticLoyaltyProgram: { findUnique, updateMany } } as any;
beforeEach(() => {
  vi.resetAllMocks();
  program = {
    id: "program",
    storeId: "store",
    updatedAt: new Date("2026-09-10T00:00:00Z"),
    metadata: { unrelated: { keep: true } },
  };
  findUnique.mockImplementation(async () => program);
  mocks.lock.mockResolvedValue({ id: "program" });
  updateMany.mockImplementation(async ({ data }) => {
    program = { ...program, metadata: data.metadata };
    return { count: 1 };
  });
});
async function request() {
  return {
    operation: "save" as const,
    expectedInstallationGeneration: "g1",
    expectedRevision: (await readLoyaltyNudgesInTransaction(tx, "store"))
      .revision,
    settings: defaultLoyaltyNudgeSettings(),
  };
}
const save = (input: unknown) =>
  saveLoyaltyNudgesInTransaction({
    tx,
    storeId: "store",
    installationGeneration: "g1",
    request: input,
  });
it("preserves metadata, increments revision and fences the exact stored snapshot", async () => {
  const input = await request();
  const previous = structuredClone(program.metadata);
  const result = await save(input);
  expect(program.metadata.unrelated).toEqual({ keep: true });
  expect(program.metadata.loyaltyNudgeSequence).toBe(1);
  expect(result.revision).not.toBe(input.expectedRevision);
  expect(updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: {
        id: "program",
        storeId: "store",
        updatedAt: program.updatedAt,
        metadata: { equals: previous },
      },
    }),
  );
  expect(Object.keys(updateMany.mock.calls[0][0].data)).toEqual(["metadata"]);
});
it("rejects a different generation before locking", async () => {
  await expect(
    save({ ...(await request()), expectedInstallationGeneration: "g0" }),
  ).rejects.toThrow();
  expect(mocks.lock).not.toHaveBeenCalled();
  expect(updateMany).not.toHaveBeenCalled();
});
it("rejects stale revisions including unrelated metadata changes", async () => {
  const input = await request();
  program.metadata.unrelated.keep = false;
  await expect(save(input)).rejects.toThrow();
  expect(updateMany).not.toHaveBeenCalled();
});
it.each(["missing", "foreign", "lock_mismatch", "maintenance", "overflow"])(
  "fails closed for %s",
  async (mode) => {
    const input = await request();
    if (mode === "missing") {
      program = null;
      mocks.lock.mockResolvedValue(null);
    }
    if (mode === "foreign") program.storeId = "foreign";
    if (mode === "lock_mismatch") mocks.lock.mockResolvedValue({ id: "other" });
    if (mode === "maintenance")
      mocks.maintenance.mockImplementation(() => {
        throw Error("maintenance");
      });
    if (mode === "overflow") {
      program.metadata.loyaltyNudgeSequence = Number.MAX_SAFE_INTEGER;
      input.expectedRevision = (
        await readLoyaltyNudgesInTransaction(tx, "store")
      ).revision;
    }
    await expect(save(input)).rejects.toThrow();
    expect(updateMany).not.toHaveBeenCalled();
  },
);
it("does not retry lost CAS", async () => {
  updateMany.mockResolvedValue({ count: 0 });
  await expect(save(await request())).rejects.toThrow();
  expect(updateMany).toHaveBeenCalledTimes(1);
});
it("reads disabled defaults without initializing absent programs", async () => {
  program = null;
  const state = await readLoyaltyNudgesInTransaction(tx, "store");
  expect(state.programConfigured).toBe(false);
  expect(state.settings.policies.every((p) => !p.enabled)).toBe(true);
  expect(updateMany).not.toHaveBeenCalled();
});
it.each([[], "invalid", { loyaltyNudgeSequence: -1 }, { loyaltyNudges: {} }])(
  "rejects corrupt metadata instead of replacing it",
  async (metadata) => {
    program.metadata = metadata;
    await expect(readLoyaltyNudgesInTransaction(tx, "store")).rejects.toThrow();
    expect(updateMany).not.toHaveBeenCalled();
  },
);
it("requires a changed, exact, authorized save acknowledgement", async () => {
  const input = await request();
  const response = {
    ...(await save(input)),
    storeId: "store",
    installationGeneration: "g1",
    capabilities: { configure: true },
  };
  expect(verifyLoyaltyNudgeResponse(input, response)).toEqual(response);
  for (const changed of [
    { revision: input.expectedRevision },
    { installationGeneration: "g0" },
    { capabilities: { configure: false } },
    { programConfigured: false },
  ]) {
    expect(() =>
      verifyLoyaltyNudgeResponse(input, { ...response, ...changed }),
    ).toThrow();
  }
  const settings = defaultLoyaltyNudgeSettings();
  settings.policies[0].enabled = true;
  expect(() =>
    verifyLoyaltyNudgeResponse(input, { ...response, settings }),
  ).toThrow();
});
