import { beforeEach, expect, it, vi } from "vitest";
import {
  readLoyaltyCommunicationsInTransaction,
  saveLoyaltyCommunicationsInTransaction,
} from "../../lib/weletic/loyalty/communications-service";

const { lock } = vi.hoisted(() => ({ lock: vi.fn() }));
vi.mock("../../lib/weletic/loyalty/program-write-fence", () => ({
  lockLoyaltyProgramRowIfPresent: lock,
}));
const template = {
  subject: "Hello",
  heading: "Loyalty",
  body: "Your points update",
  actionLabel: "View",
};
const policy = {
  journey: "points_earned",
  enabled: false,
  templates: { en: template, ja: template, vi: template },
};
let metadata: any;
const tx = {
  weleticLoyaltyProgram: {
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    create: vi.fn(),
  },
};
beforeEach(() => {
  vi.resetAllMocks();
  metadata = { unrelated: { preserved: true } };
  tx.weleticLoyaltyProgram.findUnique.mockImplementation(async () => ({
    id: "program-fixture",
    metadata,
  }));
  lock.mockImplementation(async () => ({
    id: "program-fixture",
    storeId: "store-fixture",
    metadata,
  }));
  tx.weleticLoyaltyProgram.updateMany.mockImplementation(async ({ data }) => {
    metadata = data.metadata;
    return { count: 1 };
  });
});
const read = () =>
  readLoyaltyCommunicationsInTransaction(tx as any, "store-fixture");
const save = (revision: string, overrides = {}) =>
  saveLoyaltyCommunicationsInTransaction({
    tx: tx as any,
    storeId: "store-fixture",
    installationGeneration: "generation-fixture",
    request: {
      operation: "save",
      expectedInstallationGeneration: "generation-fixture",
      expectedRevision: revision,
      policy,
      ...overrides,
    },
  });
it("preserves unrelated metadata and advances revision even for identical saves", async () => {
  const before = await read();
  const first = await save(before.revision);
  expect(metadata.unrelated).toEqual({ preserved: true });
  expect(first.policies).toEqual([policy]);
  const second = await save(first.revision);
  expect(second.revision).not.toBe(first.revision);
  await expect(save(first.revision)).rejects.toThrow("state changed");
  expect(tx.weleticLoyaltyProgram.updateMany).toHaveBeenCalledTimes(2);
});
it("rejects stale generations before taking a program lock", async () => {
  const before = await read();
  await expect(
    save(before.revision, { expectedInstallationGeneration: "old" }),
  ).rejects.toThrow("state changed");
  expect(lock).not.toHaveBeenCalled();
  expect(tx.weleticLoyaltyProgram.updateMany).not.toHaveBeenCalled();
});
it("compares the locked metadata and fails closed when the conditional write loses", async () => {
  const before = await read();
  tx.weleticLoyaltyProgram.updateMany.mockResolvedValue({ count: 0 });
  await expect(save(before.revision)).rejects.toThrow("state changed");
  expect(tx.weleticLoyaltyProgram.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: {
        id: "program-fixture",
        storeId: "store-fixture",
        metadata: { equals: { unrelated: { preserved: true } } },
      },
    }),
  );
});
it("does not silently reset malformed policy storage", async () => {
  metadata.loyaltyCommunications = { version: 2, policies: [] };
  await expect(read()).rejects.toThrow();
  expect(tx.weleticLoyaltyProgram.updateMany).not.toHaveBeenCalled();
});
it("creates only a draft program when no program exists", async () => {
  tx.weleticLoyaltyProgram.findUnique.mockResolvedValue(null);
  lock.mockResolvedValue(null);
  const before = await read();
  const after = await save(before.revision);
  expect(after.revision).not.toBe(before.revision);
  expect(tx.weleticLoyaltyProgram.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      storeId: "store-fixture",
      status: "draft",
    }),
  });
  expect(tx.weleticLoyaltyProgram.updateMany).not.toHaveBeenCalled();
});
it("binds revisions to the exact tenant", async () => {
  const other = await readLoyaltyCommunicationsInTransaction(
    tx as any,
    "other-store",
  );
  await expect(save(other.revision)).rejects.toThrow("state changed");
  expect(tx.weleticLoyaltyProgram.updateMany).not.toHaveBeenCalled();
});
