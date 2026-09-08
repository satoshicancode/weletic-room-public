import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getProgram: vi.fn(),
  setProgram: vi.fn(),
  findUnique: vi.fn(),
}));

vi.mock("@/lib/api/metadata-cache", () => ({
  metadataCache: {
    getProgram: mocks.getProgram,
    setProgram: mocks.setProgram,
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    program: {
      findUnique: mocks.findUnique,
    },
  },
}));

import { getProgramOrThrow } from "@/lib/api/programs/get-program-or-throw";

const serializedProgram = {
  id: "prog_123",
  workspaceId: "ws_123",
  name: "Partner Program",
  slug: "partners",
  logo: null,
  domain: null,
  url: null,
  description: null,
  primaryRewardEvent: "sale",
  minPayoutAmount: 1000,
  accountingCurrency: "usd",
  addedToMarketplaceAt: "2026-08-01T00:00:00.000Z",
  messagingEnabledAt: null,
  partnerNetworkEnabledAt: null,
  payoutMode: "internal",
  rewards: null,
  discounts: null,
  categories: [],
  defaultFolderId: "fold_123",
  defaultGroupId: "grp_123",
  supportEmail: null,
  helpUrl: null,
  termsUrl: null,
  referralFormData: null,
  applicationRequirements: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
  startedAt: "2026-08-03T00:00:00.000Z",
  deactivatedAt: null,
  inviteEmailData: null,
};

describe("getProgramOrThrow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rehydrates dates from a Redis-serialized program cache hit", async () => {
    mocks.getProgram.mockResolvedValue(serializedProgram);

    const program = await getProgramOrThrow({
      workspaceId: "ws_123",
      programId: "prog_123",
      include: { categories: true },
    });

    expect(program.workspaceId).toBe("ws_123");
    expect(program.createdAt).toEqual(new Date(serializedProgram.createdAt));
    expect(program.updatedAt).toEqual(new Date(serializedProgram.updatedAt));
    expect(program.startedAt).toEqual(new Date(serializedProgram.startedAt));
    expect(program.addedToMarketplaceAt).toEqual(
      new Date(serializedProgram.addedToMarketplaceAt),
    );
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("falls back to Prisma when cached program data is invalid", async () => {
    mocks.getProgram.mockResolvedValue({
      ...serializedProgram,
      createdAt: true,
    });
    mocks.findUnique.mockResolvedValue({
      ...serializedProgram,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-02T00:00:00.000Z"),
      startedAt: new Date("2026-08-03T00:00:00.000Z"),
      addedToMarketplaceAt: new Date("2026-08-01T00:00:00.000Z"),
      categories: [],
    });

    const program = await getProgramOrThrow({
      workspaceId: "ws_123",
      programId: "prog_123",
      include: { categories: true },
    });

    expect(program.createdAt).toBeInstanceOf(Date);
    expect(mocks.findUnique).toHaveBeenCalledOnce();
    expect(mocks.setProgram).toHaveBeenCalledOnce();
  });

  it("bypasses serialization-unsafe cache entries for relation includes", async () => {
    const partnerCreatedAt = new Date("2026-08-04T00:00:00.000Z");
    mocks.findUnique.mockResolvedValue({
      ...serializedProgram,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-02T00:00:00.000Z"),
      startedAt: new Date("2026-08-03T00:00:00.000Z"),
      addedToMarketplaceAt: new Date("2026-08-01T00:00:00.000Z"),
      partners: [{ id: "partner_123", createdAt: partnerCreatedAt }],
    });

    const program = await getProgramOrThrow({
      workspaceId: "ws_123",
      programId: "prog_123",
      include: { partners: true },
    });

    expect(mocks.getProgram).not.toHaveBeenCalled();
    expect(program.partners[0].createdAt).toBe(partnerCreatedAt);
    expect(mocks.setProgram).not.toHaveBeenCalled();
  });
});
