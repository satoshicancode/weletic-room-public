import {
  loyaltyAppearanceRequestSchema,
  loyaltyAppearanceResponseSchema,
} from "@/lib/weletic/loyalty/appearance-contract";
import {
  readLoyaltyAppearanceInTransaction,
  saveLoyaltyAppearanceInTransaction,
} from "@/lib/weletic/loyalty/appearance-service";
import { DEFAULT_LOYALTY_BRANDING } from "@/lib/weletic/loyalty/branding";
import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const lock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/weletic/loyalty/program-write-fence", () => ({
  lockLoyaltyProgramRowIfPresent: lock,
}));
const findUnique = vi.fn();
const updateMany = vi.fn();
const tx = {
  weleticLoyaltyProgram: { findUnique, updateMany },
} as unknown as Prisma.TransactionClient;
const fixture = () => ({
  id: "program-1",
  storeId: "store-1",
  name: "Rewards",
  branding: { ...DEFAULT_LOYALTY_BRANDING },
  metadata: { unrelated: "preserve", loyaltyAppearanceSequence: 0 },
  updatedAt: new Date("2026-09-10T00:00:00Z"),
});
let program = fixture();
const read = () => readLoyaltyAppearanceInTransaction(tx, "store-1");
async function request() {
  return {
    operation: "save",
    expectedInstallationGeneration: "generation-1",
    expectedRevision: (await read()).revision,
    branding: { ...DEFAULT_LOYALTY_BRANDING, launcherText: "My rewards" },
  };
}
const save = (request: unknown) =>
  saveLoyaltyAppearanceInTransaction({
    tx,
    storeId: "store-1",
    installationGeneration: "generation-1",
    request,
  });

describe("loyalty appearance revision service", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    program = fixture();
    lock.mockResolvedValue({ id: program.id, storeId: program.storeId });
    findUnique.mockImplementation(async () => program);
    updateMany.mockImplementation(async ({ data }) => {
      program = { ...program, ...data };
      return { count: 1 };
    });
  });

  it("reads without creating, locking or changing a program", async () => {
    findUnique.mockResolvedValue(null);
    expect(await read()).toMatchObject({
      programConfigured: false,
      branding: DEFAULT_LOYALTY_BRANDING,
    });
    expect(lock).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("keeps legacy embedded whitespace readable without rewriting storage", async () => {
    program.branding.panelWelcomeSubtitle = "Line 1\nLine 2";
    program.branding.launcherText = "My\tRewards";
    const state = await read();
    const result = loyaltyAppearanceResponseSchema.parse({
      ...state,
      storeId: "store-1",
      installationGeneration: "generation-1",
      capabilities: { configure: true },
    });
    expect(result.branding).toEqual(program.branding);
    expect(
      loyaltyAppearanceRequestSchema.safeParse({
        operation: "save",
        expectedInstallationGeneration: "generation-1",
        expectedRevision: state.revision,
        branding: result.branding,
      }).success,
    ).toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("preserves unrelated metadata and changes revision even for a repeated value", async () => {
    const input = await request();
    const first = await save(input);
    expect(first.revision).not.toBe(input.expectedRevision);
    expect(program.metadata).toEqual({
      unrelated: "preserve",
      loyaltyAppearanceSequence: 1,
    });
    const second = await save({ ...input, expectedRevision: first.revision });
    expect(second.revision).not.toBe(first.revision);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "program-1",
          storeId: "store-1",
          updatedAt: fixture().updatedAt,
          branding: { equals: fixture().branding },
          metadata: { equals: fixture().metadata },
        }),
      }),
    );
  });

  it.each([
    "generation",
    "revision",
    "foreign-store",
    "replaced-program",
    "absent-program",
    "exhausted-sequence",
  ])("rejects %s before writing", async (kind) => {
    const input = await request();
    if (kind === "generation") input.expectedInstallationGeneration = "stale";
    if (kind === "revision") input.expectedRevision = "b".repeat(64);
    if (kind === "foreign-store") program.storeId = "foreign";
    if (kind === "replaced-program") program.id = "replacement";
    if (kind === "absent-program") lock.mockResolvedValue(null);
    if (kind === "exhausted-sequence") {
      program.metadata.loyaltyAppearanceSequence = Number.MAX_SAFE_INTEGER;
      input.expectedRevision = (await read()).revision;
    }
    await expect(save(input)).rejects.toThrow();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("rejects a lost compare-and-swap", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    await expect(save(await request())).rejects.toThrow("changed");
  });

  it.each([null, "1", -1, 1.5])(
    "rejects malformed stored sequence %j",
    async (sequence) => {
      findUnique.mockResolvedValue({
        ...program,
        metadata: { loyaltyAppearanceSequence: sequence },
      });
      await expect(read()).rejects.toThrow("revision");
      expect(updateMany).not.toHaveBeenCalled();
    },
  );

  it("blocks appearance writes under a malformed maintenance lease", async () => {
    const input = await request();
    findUnique.mockResolvedValue({
      ...program,
      metadata: { ...program.metadata, __weleticLoyaltyMaintenanceLeaseV1: {} },
    });
    await expect(save(input)).rejects.toThrow("maintenance");
    expect(updateMany).not.toHaveBeenCalled();
  });
});
