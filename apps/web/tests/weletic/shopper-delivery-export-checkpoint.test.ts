import { exportShopperDeliveryPage } from "@/lib/weletic/merchant-settings/delivery-export-checkpoint";
import { deliveryExportWhere } from "@/lib/weletic/merchant-settings/delivery-privacy";
import { shopperDeliveryContentDigest } from "@/lib/weletic/merchant-settings/delivery-reservations";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  store: vi.fn(),
  reviews: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticShopperDeliveryReservation: { findMany: mocks.reviews },
  },
}));
vi.mock("@/lib/weletic/shopify/compliance-artifacts", () => ({
  readComplianceReviewCheckpoint: mocks.read,
  storeEncryptedComplianceArtifact: mocks.store,
}));
const identities = [
  {
    identityKind: "customer_email" as const,
    identityKeyId: "key",
    customerDigest: "A".repeat(64),
  },
];
const input = {
  requestId: "request",
  storeId: "store",
  identities,
  kind: "shopper_delivery" as const,
  sequence: 0,
  afterId: null,
  expiresAt: new Date("2030-01-01"),
  lease: { workerId: "worker", leaseVersion: 1 },
};
const saved = {
  format: "shopper_delivery_rows_v1",
  kind: "shopper_delivery",
  sequence: 0,
  afterId: null,
  identityDigest: shopperDeliveryContentDigest(identities),
  hasMore: true,
  rows: [{ id: "A" }],
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.read.mockResolvedValue(null);
  mocks.reviews.mockResolvedValue([]);
});
it("recovers after lost publication acknowledgement despite changed membership", async () => {
  const kind = "shopper_delivery" as const;
  const query = mocks.reviews;
  let published: unknown = null;
  mocks.read.mockImplementation(async () => published);
  mocks.store.mockImplementation(async ({ value }) => {
    published = value;
    throw new Error("lost acknowledgement");
  });
  query.mockResolvedValue(
    Array.from({ length: 21 }, (_, n) => ({
      id: `A${String(n).padStart(2, "0")}`,
    })),
  );
  await expect(exportShopperDeliveryPage({ ...input, kind })).rejects.toThrow(
    "lost acknowledgement",
  );
  // First and boundary rows are deleted; a newly inserted row changes the page.
  query.mockResolvedValue([{ id: "A01" }, { id: "A18x" }, { id: "A20" }]);
  expect(await exportShopperDeliveryPage({ ...input, kind })).toEqual({
    lastId: "A19",
    count: 20,
    hasMore: true,
  });
  expect(query).toHaveBeenCalledTimes(1);
  expect(mocks.store).toHaveBeenCalledTimes(1);
});
it("uses the actual winning artifact instead of the losing page", async () => {
  mocks.reviews.mockResolvedValue([{ id: "B" }]);
  mocks.read.mockResolvedValueOnce(null).mockResolvedValueOnce(saved);
  expect(await exportShopperDeliveryPage(input)).toEqual({
    lastId: "A",
    count: 1,
    hasMore: true,
  });
});
it.each([
  { sequence: 1 },
  { kind: "store_review_requests" },
  { afterId: "other" },
  { identityDigest: "f".repeat(64) },
  { rows: [] },
  { format: "unknown" },
])("rejects incompatible saved checkpoints: %j", async (change) => {
  mocks.read.mockResolvedValue({ ...saved, ...change });
  await expect(exportShopperDeliveryPage(input)).rejects.toThrow(
    "checkpoint invalid",
  );
  expect(mocks.reviews).not.toHaveBeenCalled();
});
it("uses keyset continuation when the preceding row has been deleted", async () => {
  await exportShopperDeliveryPage({ ...input, afterId: "deleted-row" });
  expect(mocks.reviews).toHaveBeenCalledWith(
    expect.objectContaining({
      where: {
        ...deliveryExportWhere("store", identities),
        id: { gt: "deleted-row" },
      },
      take: 21,
    }),
  );
  expect(mocks.reviews.mock.calls[0][0]).not.toHaveProperty("cursor");
});
it.each([
  { rows: [{ id: "A" }, { id: "A" }], afterId: null },
  { rows: [{ id: "A" }], afterId: "A" },
])("rejects duplicate or repeated cursor rows", async ({ rows, afterId }) => {
  mocks.read.mockResolvedValue({ ...saved, rows, afterId });
  await expect(
    exportShopperDeliveryPage({ ...input, afterId }),
  ).rejects.toThrow("does not advance");
  expect(mocks.reviews).not.toHaveBeenCalled();
});
it("does not advance if publication cannot be recovered", async () => {
  mocks.reviews.mockResolvedValue([{ id: "A" }]);
  await expect(exportShopperDeliveryPage(input)).rejects.toThrow(
    "publication unresolved",
  );
});
it.each([-1, NaN, 1.5, 2147483647, Number.MAX_SAFE_INTEGER])(
  "rejects invalid sequence %s before IO",
  async (sequence) => {
    await expect(
      exportShopperDeliveryPage({ ...input, sequence }),
    ).rejects.toThrow("sequence invalid");
    expect(mocks.read).not.toHaveBeenCalled();
  },
);
