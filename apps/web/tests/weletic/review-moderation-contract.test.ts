import {
  reviewModerationActorSchema as actorSchema,
  auditedReviewModerationInputSchema as inputSchema,
  auditedReviewModerationResponseSchema as responseSchema,
} from "@/lib/weletic/reviews/moderation-contract";
import { describe, expect, it } from "vitest";

const input = {
  reviewId: "review-1",
  version: 1,
  status: "published",
  reason: "approved",
};

describe("audited review moderation contract", () => {
  it("requires a reason and an explicit change", () => {
    expect(inputSchema.parse(input)).toEqual(input);
    expect(inputSchema.safeParse({ ...input, reason: undefined }).success).toBe(
      false,
    );
    expect(inputSchema.safeParse({ ...input, status: undefined }).success).toBe(
      false,
    );
    expect(
      inputSchema.safeParse({
        ...input,
        status: undefined,
        merchantReply: null,
      }).success,
    ).toBe(true);
  });

  it.each([0, -1, 1.5, 2_147_483_647, Number.MAX_SAFE_INTEGER])(
    "rejects invalid or exhausted expected version %s",
    (version) =>
      expect(inputSchema.safeParse({ ...input, version }).success).toBe(false),
  );

  it("permits the final representable version increment", () => {
    expect(
      inputSchema.safeParse({ ...input, version: 2_147_483_646 }).success,
    ).toBe(true);
    expect(
      responseSchema.safeParse({
        reviewId: "review-1",
        auditId: "audit-1",
        version: 2_147_483_647,
        status: "published",
      }).success,
    ).toBe(true);
  });

  it.each([
    { actor: { kind: "workspace", userId: "owner" } },
    { storeId: "other-store" },
    { owner: true },
    { retryReward: true },
    { verifiedPurchase: true },
    { participationStatus: "validated" },
    { reason: "low_rating" },
    { reason: "confirmed_fraud" },
  ])("rejects browser authority or incentive fields %j", (extra) => {
    expect(inputSchema.safeParse({ ...input, ...extra }).success).toBe(false);
  });

  it("bounds explanations and requires details for other", () => {
    expect(inputSchema.safeParse({ ...input, reason: "other" }).success).toBe(
      false,
    );
    expect(
      inputSchema.safeParse({ ...input, reason: "other", reasonDetails: "  " })
        .success,
    ).toBe(false);
    expect(
      inputSchema.parse({
        ...input,
        reason: "other",
        reasonDetails: "  explanation  ",
      }).reasonDetails,
    ).toBe("explanation");
    expect(
      inputSchema.safeParse({ ...input, reasonDetails: "x".repeat(1001) })
        .success,
    ).toBe(false);
    expect(
      inputSchema.safeParse({ ...input, merchantReply: "x".repeat(5001) })
        .success,
    ).toBe(false);
  });

  it("keeps actor namespaces explicit without accepting tokens or authority flags", () => {
    const actor = {
      kind: "shopify",
      userId: "123",
      appId: "app-1",
      installationGeneration: "generation-1",
      merchantActionId: "a".repeat(64),
    };
    expect(actorSchema.parse(actor)).toEqual(actor);
    expect(
      actorSchema.safeParse({ ...actor, userId: "9007199254740992" }).success,
    ).toBe(false);
    expect(
      actorSchema.safeParse({ ...actor, accessToken: "synthetic" }).success,
    ).toBe(false);
    expect(actorSchema.safeParse({ ...actor, owner: true }).success).toBe(
      false,
    );
    expect(
      actorSchema.safeParse({ ...actor, merchantActionId: undefined }).success,
    ).toBe(false);
    expect(
      actorSchema.parse({ kind: "workspace", userId: "workspace-user" }),
    ).toEqual({ kind: "workspace", userId: "workspace-user" });
  });

  it("keeps responses free of private audit details and tokens", () => {
    const response = {
      reviewId: "review-1",
      auditId: "audit-1",
      version: 2,
      status: "hidden",
    };
    expect(responseSchema.parse(response)).toEqual(response);
    expect(
      responseSchema.safeParse({
        ...response,
        reasonDetails: "private explanation",
      }).success,
    ).toBe(false);
    expect(
      responseSchema.safeParse({ ...response, status: "redacted" }).success,
    ).toBe(false);
  });
});
