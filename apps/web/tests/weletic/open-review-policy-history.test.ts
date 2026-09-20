import {
  createOpenReviewPolicyRevision,
  readCurrentOpenReviewPolicy,
} from "@/lib/weletic/reviews/open-policy-history";
import {
  DEFAULT_OPEN_REVIEW_POLICY,
  openReviewPolicySnapshot,
} from "@/lib/weletic/reviews/open-submission-policy";
import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mutation: vi.fn(),
  query: vi.fn(),
  create: vi.fn(),
  authorize: vi.fn(),
}));
vi.mock("@/lib/weletic/reviews/transaction", () => ({
  withReviewMutation: mocks.mutation,
}));
const tx = {
  $queryRaw: mocks.query,
  weleticOpenReviewPolicy: { create: mocks.create },
} as unknown as Prisma.TransactionClient;
const command = {
  expectedInstallationGeneration: "g1",
  expectedRevision: 0,
  policy: DEFAULT_OPEN_REVIEW_POLICY,
};
const run = (input: unknown = command) =>
  createOpenReviewPolicyRevision("store", input, mocks.authorize);

describe("open review immutable policy history", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.mutation.mockImplementation((_store, operation) => operation(tx));
    mocks.query.mockResolvedValue([]);
    mocks.authorize.mockResolvedValue({
      appId: "public-app",
      shopifyUserId: "123",
    });
  });
  it("returns disabled revision zero without persisting defaults", async () => {
    expect(await readCurrentOpenReviewPolicy(tx, "store")).toEqual({
      revision: 0,
      policy: DEFAULT_OPEN_REVIEW_POLICY,
      installationGeneration: null,
    });
    expect(mocks.create).not.toHaveBeenCalled();
    const query = mocks.query.mock.calls[0][0];
    expect(query.strings.join("?")).toContain("FOR UPDATE");
    expect(query.values).toEqual(["store"]);
  });
  it("creates an explicit disabled revision with trusted attribution and generation fence", async () => {
    expect(await run()).toEqual({
      revision: 1,
      policy: DEFAULT_OPEN_REVIEW_POLICY,
    });
    expect(mocks.mutation).toHaveBeenCalledWith(
      "store",
      expect.any(Function),
      "g1",
    );
    expect(mocks.authorize).toHaveBeenCalledWith(tx);
    expect(mocks.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        storeId: "store",
        revision: 1,
        snapshot: DEFAULT_OPEN_REVIEW_POLICY,
        installationGeneration: "g1",
        appId: "public-app",
        shopifyUserId: "123",
      }),
    });
  });
  it("appends after a digest-verified current revision", async () => {
    const saved = openReviewPolicySnapshot({
      ...DEFAULT_OPEN_REVIEW_POLICY,
      enabled: true,
    });
    mocks.query.mockResolvedValue([
      {
        revision: 4,
        snapshot: JSON.stringify(saved.policy),
        contentDigest: saved.contentDigest,
        installationGeneration: "g1",
      },
    ]);
    expect(await run({ ...command, expectedRevision: 4 })).toEqual({
      revision: 5,
      policy: DEFAULT_OPEN_REVIEW_POLICY,
    });
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
  it("rejects stale revisions without a write", async () => {
    await expect(
      run({ ...command, expectedRevision: 1 }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("fails closed on corrupted saved policy", async () => {
    mocks.query.mockResolvedValue([
      {
        revision: 1,
        snapshot: DEFAULT_OPEN_REVIEW_POLICY,
        contentDigest: "wrong",
        installationGeneration: "g1",
      },
    ]);
    await expect(
      run({ ...command, expectedRevision: 1 }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("does not read or write policy after denied authorization", async () => {
    mocks.authorize.mockRejectedValue(new Error("denied"));
    await expect(run()).rejects.toThrow("denied");
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("rejects caller attribution and revision overflow before entering the transaction", async () => {
    for (const change of [
      { appId: "forged" },
      { shopifyUserId: "123" },
      { expectedRevision: 2147483647 },
    ]) {
      await expect(run({ ...command, ...change })).rejects.toThrow();
    }
    expect(mocks.mutation).not.toHaveBeenCalled();
  });
  it("propagates transaction failure without reporting a successful revision", async () => {
    mocks.create.mockRejectedValue(new Error("rollback"));
    await expect(run()).rejects.toThrow("rollback");
  });
});
