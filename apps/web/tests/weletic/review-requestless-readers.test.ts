import { listAdminReviews } from "@/lib/weletic/reviews/admin";
import { reviewParticipationContentDigest } from "@/lib/weletic/reviews/incentive-evidence";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

describe("requestless review reader boundaries", () => {
  it("returns no incentive/retry or private author/request in merchant rows", async () => {
    const claims = vi.fn();
    const db = {
      weleticProductReview: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "review",
            version: 1,
            createdAt: new Date(),
            status: "published",
            rating: 1,
            title: "Feedback",
            body: "Feedback body",
            displayName: "Shopper",
            merchantReply: null,
            verifiedPurchase: true,
            incentivized: true,
            rewardStatus: "pending",
            rewardReason: null,
            shopperId: "private-owner",
            participationStatus: "validated",
            request: null,
            product: { title: "Product", externalId: "product" },
            media: [],
          },
        ]),
      },
      weleticReviewRequest: { findMany: vi.fn() },
      weleticReviewIncentiveClaim: { findMany: claims },
    };
    const page = await listAdminReviews(
      "store",
      {},
      db as unknown as Parameters<typeof listAdminReviews>[2],
    );
    expect(page.items[0]).toMatchObject({
      verifiedPurchase: false,
      incentivized: false,
      rewardPolicy: "none",
      canRetryReward: false,
    });
    expect(page.items[0]).not.toHaveProperty("shopperId");
    expect(page.items[0]).not.toHaveProperty("request");
    expect(claims).not.toHaveBeenCalled();
  });

  it("does not fabricate incentive evidence for a requestless review", () => {
    expect(() =>
      reviewParticipationContentDigest({
        id: "review",
        requestId: null,
        title: "Feedback",
        body: "Feedback body",
        mediaIds: [],
      }),
    ).toThrow("Invitation evidence is required");
  });
});
