import { inspectReviewPrivacyReaderCoverage } from "@/lib/weletic/reviews/privacy-readiness";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  store: vi.fn(),
  raw: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: mocks.transaction },
}));
beforeEach(() => {
  vi.resetAllMocks();
  mocks.transaction.mockImplementation((fn) =>
    fn({
      weleticShopifyStore: { findUnique: mocks.store },
      $queryRaw: mocks.raw,
    }),
  );
  mocks.store.mockResolvedValue({
    installationGeneration: "g1",
    complianceState: "active",
    storeAccessState: "active",
    reviewSettings: { enabled: true },
  });
  mocks.raw.mockResolvedValue([
    {
      total: BigInt(3),
      eligible: BigInt(1),
      suppressed: BigInt(1),
      unknown: BigInt(1),
    },
  ]);
});
const inspect = () =>
  inspectReviewPrivacyReaderCoverage({
    storeId: "store-a",
    installationGeneration: "g1",
  });
it("reports snapshot counts without owner identities or proofs", async () => {
  expect(await inspect()).toEqual({
    status: "inspected",
    readerCoverageComplete: false,
    counts: { total: 3, eligible: 1, suppressed: 1, unknown: 1 },
  });
  expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), {
    isolationLevel: "RepeatableRead",
  });
  expect(mocks.raw.mock.calls[0][0].values).toContain("store-a");
});
it("does not classify authoritative suppression as missing coverage", async () => {
  mocks.raw.mockResolvedValue([
    {
      total: BigInt(1),
      eligible: BigInt(0),
      suppressed: BigInt(1),
      unknown: BigInt(0),
    },
  ]);
  expect(await inspect()).toMatchObject({
    readerCoverageComplete: true,
    counts: { suppressed: 1, unknown: 0 },
  });
});
it.each(["pending_approval", "suspended"])(
  "does not certify a %s store",
  async (storeAccessState) => {
    mocks.store.mockResolvedValue({
      installationGeneration: "g1",
      complianceState: "active",
      storeAccessState,
    });
    expect(await inspect()).toEqual({
      status: "store_unavailable",
      readerCoverageComplete: false,
      counts: null,
    });
    expect(mocks.raw).not.toHaveBeenCalled();
  },
);
it("does not certify disabled reviews as an empty passing store", async () => {
  mocks.store.mockResolvedValue({
    installationGeneration: "g1",
    complianceState: "active",
    storeAccessState: "active",
    reviewSettings: { enabled: false },
  });
  expect(await inspect()).toEqual({
    status: "module_disabled",
    readerCoverageComplete: false,
    counts: null,
  });
  expect(mocks.raw).not.toHaveBeenCalled();
});
it("rejects stale generations", async () => {
  mocks.store.mockResolvedValue({ installationGeneration: "g2" });
  await expect(inspect()).rejects.toThrow("installation unavailable");
  expect(mocks.raw).not.toHaveBeenCalled();
});
it.each([
  {
    total: BigInt(3),
    eligible: BigInt(2),
    suppressed: BigInt(2),
    unknown: BigInt(0),
  },
  {
    total: BigInt("9007199254740992"),
    eligible: BigInt("9007199254740992"),
    suppressed: BigInt(0),
    unknown: BigInt(0),
  },
])("rejects invalid partitions or unsafe counts", async (row) => {
  mocks.raw.mockResolvedValue([row]);
  await expect(inspect()).rejects.toThrow("totals invalid");
});
