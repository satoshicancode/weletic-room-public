import { moderateReviewWithAuditInTransaction } from "@/lib/weletic/reviews/moderation-audit";
import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  create: vi.fn(),
  moderate: vi.fn(),
}));
vi.mock("@/lib/weletic/reviews/service", () => ({
  moderateNativeReviewInTransaction: (...args: unknown[]) =>
    mocks.moderate(...args),
}));
const tx = {
  weleticProductReview: { findFirst: mocks.read },
  weleticReviewModerationAudit: { create: mocks.create },
} as unknown as Prisma.TransactionClient;
const actor = {
  kind: "shopify",
  userId: "123",
  appId: "app-1",
  installationGeneration: "generation-1",
  merchantActionId: "a".repeat(64),
};
const input = {
  reviewId: "review-1",
  version: 1,
  status: "hidden",
  reason: "spam",
};
const run = (
  changes: Partial<
    Parameters<typeof moderateReviewWithAuditInTransaction>[0]
  > = {},
) =>
  moderateReviewWithAuditInTransaction({
    tx,
    storeId: "store-1",
    generation: "generation-1",
    actor,
    input,
    ...changes,
  });

describe("transactional moderation audit", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.read.mockResolvedValue({
      id: "review-1",
      version: 1,
      status: "published",
      merchantReply: null,
    });
    mocks.moderate.mockResolvedValue({
      id: "review-1",
      version: 2,
      status: "hidden",
      merchantReply: null,
    });
    mocks.create.mockResolvedValue({});
  });
  it("persists explicit actor and transition on the mutation transaction", async () => {
    const result = await run();
    expect(mocks.read).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          storeId: "store-1",
          id: "review-1",
          product: { storeId: "store-1" },
        },
      }),
    );
    expect(mocks.moderate).toHaveBeenCalledWith(
      expect.objectContaining({
        tx,
        userId: null,
        input: { version: 1, status: "hidden" },
      }),
    );
    expect(mocks.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: result.auditId,
        storeId: "store-1",
        reviewId: "review-1",
        actorKind: "shopify",
        actorUserId: "123",
        merchantActionId: actor.merchantActionId,
        reasonCode: "spam",
        fromVersion: 1,
        toVersion: 2,
        fromStatus: "published",
        toStatus: "hidden",
        replyChanged: false,
      }),
    });
    expect(Object.keys(result).sort()).toEqual([
      "auditId",
      "reviewId",
      "status",
      "version",
    ]);
  });
  it("keeps workspace provenance distinct and records reply changes without copying text", async () => {
    mocks.moderate.mockResolvedValue({
      id: "review-1",
      version: 2,
      status: "published",
      merchantReply: "New reply",
    });
    await run({
      actor: { kind: "workspace", userId: "workspace-user" },
      input: {
        reviewId: "review-1",
        version: 1,
        merchantReply: "New reply",
        reason: "merchant_reply",
      },
    });
    expect(mocks.moderate).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "workspace-user" }),
    );
    const data = mocks.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      actorKind: "workspace",
      appId: null,
      merchantActionId: null,
      replyChanged: true,
    });
    expect(JSON.stringify(data)).not.toContain("New reply");
  });
  it("rejects generation mismatch before reading", async () => {
    await expect(run({ generation: "replacement" })).rejects.toMatchObject({
      code: "conflict",
    });
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it.each([null, { id: "review-1", status: "redacted" }])(
    "rejects missing/redacted review %j",
    async (value) => {
      mocks.read.mockResolvedValue(value);
      await expect(run()).rejects.toMatchObject({ code: "not_found" });
      expect(mocks.moderate).not.toHaveBeenCalled();
      expect(mocks.create).not.toHaveBeenCalled();
    },
  );
  it("propagates stale mutation failure without an audit", async () => {
    mocks.moderate.mockRejectedValue(new Error("stale version"));
    await expect(run()).rejects.toThrow("stale version");
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("propagates audit failure without recovering or repeating the mutation", async () => {
    mocks.create.mockRejectedValue(new Error("audit unavailable"));
    await expect(run()).rejects.toThrow("audit unavailable");
    expect(mocks.moderate).toHaveBeenCalledTimes(1);
  });
});
