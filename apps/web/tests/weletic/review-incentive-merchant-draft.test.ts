import { merchantReviewIncentiveDraftInputSchema } from "@/lib/weletic/reviews/incentive-merchant-contract";
import { createReviewIncentivePolicyRevision } from "@/lib/weletic/reviews/incentive-policy";
import { draftShopifyMerchantReviewIncentive } from "@/lib/weletic/shopify/merchant-review-incentive-draft";
import { authorizeShopifyMerchantInTransaction } from "@/lib/weletic/shopify/staff-authorization";
import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/weletic/reviews/incentive-policy", () => ({
  createReviewIncentivePolicyRevision: vi.fn(),
}));
vi.mock("@/lib/weletic/shopify/staff-authorization", () => ({
  authorizeShopifyMerchantInTransaction: vi.fn(),
}));
const actor = {
  version: 1,
  storeId: "store",
  appId: "app",
  shop: "test.myshopify.com",
  installationGeneration: "generation",
  userId: "123",
  sessionId: "test.myshopify.com_123",
  sessionDigest: "a".repeat(64),
  authenticatedAt: 1,
  requestId: "b".repeat(64),
};
const input = {
  expectedRevision: 2,
  expectedInstallationGeneration: "generation",
  draft: { kind: "none" },
};
const tx = {} as Prisma.TransactionClient;
const run = (value: unknown = input) =>
  draftShopifyMerchantReviewIncentive({ envelope: actor, input: value });

describe("merchant review policy draft boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(createReviewIncentivePolicyRevision).mockResolvedValue({
      id: "policy",
      revision: 3,
      contentDigest: "c".repeat(64),
    } as Awaited<ReturnType<typeof createReviewIncentivePolicyRevision>>);
  });
  it("uses actor store, requires reviews.configure twice and consumes only at commit", async () => {
    expect(await run()).toEqual({
      policyId: "policy",
      revision: 3,
      contentDigest: "c".repeat(64),
      activated: false,
    });
    const [storeId, draft, fence] = vi.mocked(
      createReviewIncentivePolicyRevision,
    ).mock.calls[0];
    expect(storeId).toBe(actor.storeId);
    expect(draft).toEqual({ kind: "none" });
    expect(fence).toMatchObject({
      expectedRevision: 2,
      expectedInstallationGeneration: "generation",
    });
    await fence!.authorize(tx, "preflight");
    await fence!.authorize(tx, "commit");
    expect(authorizeShopifyMerchantInTransaction).toHaveBeenNthCalledWith(1, {
      tx,
      envelope: actor,
      permission: "reviews.configure",
      recordAction: false,
    });
    expect(authorizeShopifyMerchantInTransaction).toHaveBeenNthCalledWith(2, {
      tx,
      envelope: actor,
      permission: "reviews.configure",
      recordAction: true,
    });
  });
  it("rejects mismatched installation before reaching the writer", async () => {
    await expect(
      run({ ...input, expectedInstallationGeneration: "stale" }),
    ).rejects.toThrow("Installation changed");
    expect(createReviewIncentivePolicyRevision).not.toHaveBeenCalled();
  });
  it.each([
    { ...input, storeId: "other" },
    { ...input, expectedRevision: -1 },
    { ...input, expectedRevision: 2147483647 },
    {
      ...input,
      draft: {
        kind: "coupon",
        rewardDefinitionId: "reward",
        displayTargets: [],
      },
    },
    {
      ...input,
      draft: {
        kind: "points",
        basePoints: "9223372036854775808",
        photoBonusPoints: "0",
        videoBonusPoints: "0",
        maxPoints: "0",
      },
    },
    { ...input, draft: { kind: "none", active: true } },
  ])("rejects forged server fields and invalid revisions/amounts", (value) => {
    expect(
      merchantReviewIncentiveDraftInputSchema.safeParse(value).success,
    ).toBe(false);
  });
});
