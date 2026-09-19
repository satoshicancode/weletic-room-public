import {
  readReviewIncentivePolicySnapshot,
  reviewIncentivePolicyDigest,
} from "@/lib/weletic/reviews/incentive-policy";
import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/weletic/reviews/transaction", () => ({
  withReviewMutation: vi.fn(),
}));

const snapshot = {
  version: 1,
  award: {
    kind: "points",
    basePoints: "10",
    photoBonusPoints: "5",
    videoBonusPoints: "8",
    maxPoints: "18",
  },
};
const record = () => ({
  id: "policy-1",
  storeId: "store-1",
  snapshot,
  contentDigest: reviewIncentivePolicyDigest(snapshot),
});
function setup(row: unknown = record()) {
  const findUnique = vi.fn().mockResolvedValue(row);
  const tx = {
    weleticReviewIncentivePolicy: { findUnique },
  } as unknown as Prisma.TransactionClient;
  return { tx, findUnique };
}

describe("invitation policy reader", () => {
  it("recognizes only explicit null as historical and does not query settings", async () => {
    const { tx, findUnique } = setup();
    await expect(
      readReviewIncentivePolicySnapshot(tx, "store-1", null),
    ).resolves.toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });
  it.each([undefined, "", " ", "policy/1", 0, false, {}, "a".repeat(192)])(
    "rejects malformed references before reading the database: %j",
    async (id) => {
      const { tx, findUnique } = setup();
      await expect(
        readReviewIncentivePolicySnapshot(tx, "store-1", id),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(findUnique).not.toHaveBeenCalled();
    },
  );
  it("reads only the owned invitation policy and returns its exact promise", async () => {
    const { tx, findUnique } = setup();
    await expect(
      readReviewIncentivePolicySnapshot(tx, "store-1", "policy-1"),
    ).resolves.toEqual(snapshot);
    expect(findUnique).toHaveBeenCalledExactlyOnceWith({
      where: { storeId_id: { storeId: "store-1", id: "policy-1" } },
    });
  });
  it.each([
    null,
    { ...record(), storeId: "foreign" },
    { ...record(), id: "other-policy" },
    { ...record(), contentDigest: "0".repeat(64) },
    {
      ...record(),
      snapshot: { ...snapshot, award: { ...snapshot.award, basePoints: "11" } },
    },
    { ...record(), snapshot: { version: 1, award: { kind: "unrecognized" } } },
  ])(
    "fails closed for missing, foreign, malformed or altered policies",
    async (row) => {
      const { tx } = setup(row);
      await expect(
        readReviewIncentivePolicySnapshot(tx, "store-1", "policy-1"),
      ).rejects.toMatchObject({
        code: "unavailable",
        message: "Review incentive policy is unavailable",
      });
    },
  );
  it("preserves explicit none without converting to the legacy null path", async () => {
    const none = { version: 1, award: { kind: "none" } };
    const { tx } = setup({
      ...record(),
      snapshot: none,
      contentDigest: reviewIncentivePolicyDigest(none),
    });
    await expect(
      readReviewIncentivePolicySnapshot(tx, "store-1", "policy-1"),
    ).resolves.toEqual(none);
  });
});
