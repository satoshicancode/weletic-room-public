import type { Prisma } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";
import { enqueueOutboxJob } from "../../lib/weletic/loyalty/outbox";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/weletic/loyalty/outbox-worker", () => ({}));
vi.mock("@/lib/weletic/shopify/store-compliance-state", () => ({
  assertShopifyStoreAcceptsOperationalWrites: vi.fn(),
}));

const findUnique = vi.fn();
const create = vi.fn();
const store = vi.fn();
const template = {
  subject: "Earned {{points}}",
  heading: "Points",
  body: "Your points",
  actionLabel: "View",
};
function input() {
  return {
    storeId: "store",
    jobType: "LOYALTY_COMMUNICATION" as const,
    idempotencyKey: "purchase-points:test",
    payload: {
      version: 1,
      journey: "points_earned",
      source: "purchase_points_available",
      storeId: "store",
      programId: "program",
      accountId: "account",
      installationGeneration: "g1",
      ledgerEntryId: "ledger",
      orderId: "order",
      occurredAt: "2026-09-10T00:00:00Z",
      points: "20",
      ledgerPoints: "20",
      policyRevision: "a".repeat(64),
      policy: {
        journey: "points_earned",
        enabled: true,
        templates: { en: template, ja: template, vi: template },
      },
    },
    tx: {
      weleticShopifyStore: { findUnique: store },
      weleticLoyaltyOutboxJob: { findUnique, create },
    } as unknown as Prisma.TransactionClient,
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  findUnique.mockResolvedValue(null);
  store.mockResolvedValue({ installationGeneration: "g1" });
  create.mockImplementation(async ({ data }) => data);
});

it("persists exact validated event evidence with the current installation", async () => {
  const data = input();
  const result = await enqueueOutboxJob(data);
  expect(result.created).toBe(true);
  expect(create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      storeId: "store",
      jobType: "LOYALTY_COMMUNICATION",
      payload: data.payload,
    }),
  });
});

it("rejects a foreign payload before idempotency adoption or persistence", async () => {
  const data = input();
  data.payload.storeId = "foreign";
  findUnique.mockResolvedValue({ id: "existing" });
  await expect(enqueueOutboxJob(data)).rejects.toThrow(
    "Loyalty communication store mismatch",
  );
  expect(findUnique).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
});

it.each(["g2", null, undefined])(
  "rejects changed or missing current generation: %s",
  async (installationGeneration) => {
    store.mockResolvedValue({ installationGeneration });
    await expect(enqueueOutboxJob(input())).rejects.toThrow(
      "Loyalty communication installation changed",
    );
    expect(create).not.toHaveBeenCalled();
  },
);

it("rejects a missing store", async () => {
  store.mockResolvedValue(null);
  await expect(enqueueOutboxJob(input())).rejects.toThrow(
    "missing Shopify store",
  );
  expect(create).not.toHaveBeenCalled();
});

it("does not permit a test-only null-generation fallback", async () => {
  const data = input();
  data.tx = {
    weleticLoyaltyOutboxJob: { findUnique, create },
  } as unknown as Prisma.TransactionClient;
  await expect(enqueueOutboxJob(data)).rejects.toThrow("Cannot bind");
  expect(create).not.toHaveBeenCalled();
});

it("preserves an existing event instead of replacing its policy on replay", async () => {
  const existing = { id: "job", payload: input().payload };
  findUnique.mockResolvedValue(existing);
  const data = input();
  data.payload.policyRevision = "b".repeat(64);
  expect(await enqueueOutboxJob(data)).toEqual({
    job: existing,
    created: false,
  });
  expect(create).not.toHaveBeenCalled();
});
