import type { Prisma } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";
import {
  enqueueRewardExpiryReminderJobs,
  readRewardExpirySweepCursor,
  REWARD_EXPIRY_SWEEP_KEY,
} from "../../lib/weletic/loyalty/reward-expiry-scheduler";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  fence: vi.fn(),
  produce: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: { $queryRaw: mocks.query } }));
vi.mock("../../lib/weletic/loyalty/merchant-write-fence", () => ({
  withActiveStoreLoyaltyMutation: mocks.fence,
}));
vi.mock(
  "../../lib/weletic/loyalty/reward-expiry-communication-producer",
  () => ({ enqueueDueRewardExpiryCommunication: mocks.produce }),
);
beforeEach(() => {
  vi.resetAllMocks();
  mocks.produce.mockResolvedValue("enqueued");
});
const at = new Date("2026-10-10T00:00:00Z");
function fixture(count = 1, ids = ["a", "b", "c"]) {
  const programs = Array.from({ length: count }, (_, n) => ({
    id: `p${n}`,
    storeId: `s${n}`,
    installationGeneration: "generation",
    metadata: { preserved: "merchant-value" } as Prisma.JsonObject,
  }));
  const findMany = vi.fn(async ({ where, take }) =>
    ids
      .filter((id) => !where.id?.gt || id > where.id.gt)
      .slice(0, take)
      .map((id) => ({ id })),
  );
  const update = vi.fn(async ({ where, data }) => {
    const p = programs.find((p) => p.id === where.id)!;
    p.metadata = data.metadata;
    return p;
  });
  const tx = {
    weleticLoyaltyProgram: {
      findUnique: vi.fn(async ({ where }) =>
        programs.find((p) => p.storeId === where.storeId),
      ),
      update,
    },
    weleticRewardRedemption: { findMany },
  };
  // Unit model of rotation only; real MySQL JSON ordering has separate coverage.
  mocks.query.mockImplementation(async (sql) =>
    [...programs]
      .sort((a, b) => {
        const stamp = (p: typeof a) =>
          String(
            (
              p.metadata[REWARD_EXPIRY_SWEEP_KEY] as
                | Prisma.JsonObject
                | undefined
            )?.lastScannedAt ?? "",
          );
        return (
          stamp(a).localeCompare(stamp(b)) || a.storeId.localeCompare(b.storeId)
        );
      })
      .slice(0, Number(sql.values.at(-1))),
  );
  mocks.fence.mockImplementation(async ({ operation }) => {
    const before = programs.map((p) => structuredClone(p.metadata));
    try {
      return await operation(tx);
    } catch (error) {
      programs.forEach((p, index) => {
        p.metadata = before[index];
      });
      throw error;
    }
  });
  return { programs, findMany, update, tx };
}
it("advances over ineligible and existing rows, wraps, and preserves merchant metadata", async () => {
  const { programs } = fixture();
  mocks.produce
    .mockResolvedValueOnce("ineligible")
    .mockResolvedValueOnce("existing");
  expect(
    await enqueueRewardExpiryReminderJobs({ now: at, batchSize: 2 }),
  ).toMatchObject({
    rewardsScanned: 2,
    ineligible: 1,
    alreadyQueued: 1,
    jobsEnqueued: 0,
  });
  expect(readRewardExpirySweepCursor(programs[0].metadata, "generation")).toBe(
    "b",
  );
  expect(
    await enqueueRewardExpiryReminderJobs({
      now: new Date(at.getTime() + 1000),
      batchSize: 2,
    }),
  ).toMatchObject({ rewardsScanned: 1, jobsEnqueued: 1 });
  expect(
    readRewardExpirySweepCursor(programs[0].metadata, "generation"),
  ).toBeNull();
  expect(programs[0].metadata.preserved).toBe("merchant-value");
  await enqueueRewardExpiryReminderJobs({
    now: new Date(at.getTime() + 2000),
    batchSize: 2,
  });
  expect(mocks.produce.mock.calls.map(([x]) => x.redemptionId)).toEqual([
    "a",
    "b",
    "c",
    "a",
    "b",
  ]);
});
it("gives more than five programs turns without letting the first store exhaust the budget", async () => {
  fixture(
    7,
    Array.from({ length: 30 }, (_, i) => String(i).padStart(3, "0")),
  );
  const first = await enqueueRewardExpiryReminderJobs({
    now: at,
    batchSize: 500,
  });
  expect(first).toMatchObject({ programsScanned: 5, rewardsScanned: 50 });
  const before = mocks.produce.mock.calls.length;
  await enqueueRewardExpiryReminderJobs({
    now: new Date(at.getTime() + 1000),
    batchSize: 500,
  });
  const stores = new Set(
    mocks.produce.mock.calls.slice(before).map(([x]) => x.storeId),
  );
  expect(stores.has("s5")).toBe(true);
  expect(stores.has("s6")).toBe(true);
});
it("preserves retry position after a queue failure but records the failed turn", async () => {
  const { programs } = fixture();
  mocks.produce
    .mockResolvedValueOnce("enqueued")
    .mockRejectedValueOnce(new Error("synthetic queue failure"));
  const result = await enqueueRewardExpiryReminderJobs({
    now: at,
    batchSize: 2,
  });
  expect(result).toMatchObject({
    jobsEnqueued: 0,
    rewardsScanned: 0,
    programFailures: [{ storeId: "s0", checkpointRetained: true }],
  });
  expect(
    readRewardExpirySweepCursor(programs[0].metadata, "generation"),
  ).toBeNull();
  expect(programs[0].metadata[REWARD_EXPIRY_SWEEP_KEY]).toMatchObject({
    lastScannedAt: at.toISOString(),
  });
  await enqueueRewardExpiryReminderJobs({
    now: new Date(at.getTime() + 1000),
    batchSize: 2,
  });
  expect(mocks.produce.mock.calls.map(([x]) => x.redemptionId)).toEqual([
    "a",
    "b",
    "a",
    "b",
  ]);
});
it("does not bypass an admission or maintenance fence to update progress", async () => {
  const { update } = fixture();
  mocks.fence.mockRejectedValue(new Error("synthetic blocked store"));
  expect(await enqueueRewardExpiryReminderJobs({ now: at })).toMatchObject({
    programFailures: [{ storeId: "s0", checkpointRetained: false }],
  });
  expect(mocks.produce).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
});
it("resets a malformed or different-generation cursor without changing receipt provenance", () => {
  expect(readRewardExpirySweepCursor(null, "generation")).toBeNull();
  expect(
    readRewardExpirySweepCursor(
      { [REWARD_EXPIRY_SWEEP_KEY]: "invalid" },
      "generation",
    ),
  ).toBeNull();
  const metadata = {
    [REWARD_EXPIRY_SWEEP_KEY]: {
      installationGeneration: "old",
      lastRedemptionId: "z",
      lastScannedAt: at.toISOString(),
    },
  };
  expect(readRewardExpirySweepCursor(metadata, "generation")).toBeNull();
  expect(readRewardExpirySweepCursor(metadata, "old")).toBe("z");
});
it("bounds invalid batch inputs and rejects an invalid clock before discovery", async () => {
  fixture(
    7,
    Array.from({ length: 20 }, (_, i) => String(i)),
  );
  await expect(
    enqueueRewardExpiryReminderJobs({ now: new Date(NaN) }),
  ).rejects.toThrow("clock");
  expect(mocks.query).not.toHaveBeenCalled();
  expect(
    await enqueueRewardExpiryReminderJobs({ now: at, batchSize: NaN }),
  ).toMatchObject({ programsScanned: 5, rewardsScanned: 50 });
  const query = mocks.query.mock.calls[0][0];
  expect(query.strings.join(" ")).toContain("s.storeAccessState = 'active'");
  expect(query.strings.join(" ")).toContain("JSON_CONTAINS_PATH");
});
