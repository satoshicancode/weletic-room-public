import {
  isReviewPublicationTransition,
  REVIEW_FLOW_HANDLES,
  reviewFlowEventId,
  ReviewFlowJobSchema,
} from "@/lib/weletic/reviews/flow-contract";
import { describe, expect, it } from "vitest";

const event = {
  handle: REVIEW_FLOW_HANDLES.SUBMITTED,
  reviewId: `wreview_${"a".repeat(20)}`,
  version: 1,
  installationGeneration: "public-installation-1",
  occurredAt: "2026-09-20T00:00:00.000Z",
  rating: 1,
  verifiedPurchase: true,
};

describe("review-owned Flow event contract", () => {
  it.each(Object.values(REVIEW_FLOW_HANDLES))(
    "accepts %s without requiring loyalty enrollment or a favorable rating",
    (handle) => {
      expect(ReviewFlowJobSchema.parse({ ...event, handle })).toEqual({
        ...event,
        handle,
      });
    },
  );
  it.each([
    { email: "fixture@example.test" },
    { body: "Private review content" },
    { token: "invitation" },
    { accountId: "loyalty-account" },
    { customerGid: "gid://shopify/Customer/1" },
    { reviewId: "foreign-shape" },
    { version: 0 },
    { version: 1.5 },
    { version: 2_147_483_648 },
    { installationGeneration: null },
    { installationGeneration: "" },
    { occurredAt: "not-a-date" },
    { rating: 0 },
    { rating: 6 },
    { handle: "weletic-points-earned" },
  ])("rejects invalid or private event material %j", (patch) => {
    expect(ReviewFlowJobSchema.safeParse({ ...event, ...patch }).success).toBe(
      false,
    );
  });
  it("keeps the same identity on replay and separates lifecycle/version events", () => {
    expect(reviewFlowEventId(event)).toBe(reviewFlowEventId({ ...event }));
    expect(reviewFlowEventId(event)).not.toBe(
      reviewFlowEventId({ ...event, handle: REVIEW_FLOW_HANDLES.PUBLISHED }),
    );
    expect(reviewFlowEventId(event)).not.toBe(
      reviewFlowEventId({ ...event, version: 2 }),
    );
  });
  it.each([
    ["pending", "published", true],
    ["hidden", "published", true],
    ["published", "published", false],
    ["published", "hidden", false],
    ["pending", "pending", false],
  ])("publication transition %s → %s is %s", (before, after, expected) => {
    expect(isReviewPublicationTransition(before, after)).toBe(expected);
  });
});
