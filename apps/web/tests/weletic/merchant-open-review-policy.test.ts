import { DEFAULT_OPEN_REVIEW_POLICY } from "@/lib/weletic/reviews/open-submission-policy";
import {
  readShopifyMerchantOpenReviewPolicy,
  writeShopifyMerchantOpenReviewPolicy,
} from "@/lib/weletic/shopify/merchant-open-review-policy";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  fence: vi.fn(),
  authorize: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
}));
vi.mock("@/lib/weletic/reviews/transaction", () => ({
  withReviewMutation: mocks.fence,
}));
vi.mock("@/lib/weletic/shopify/staff-authorization", () => ({
  authorizeShopifyMerchantInTransaction: mocks.authorize,
}));
vi.mock("@/lib/weletic/reviews/open-policy-history", () => ({
  createOpenReviewPolicyRevision: mocks.write,
  readCurrentOpenReviewPolicy: mocks.read,
}));
const envelope = {
  version: 1,
  appId: "app_1",
  shop: "test.myshopify.com",
  storeId: "store_1",
  installationGeneration: "g1",
  userId: "42",
  sessionId: "test.myshopify.com_42",
  sessionDigest: "a".repeat(64),
  authenticatedAt: 1,
  requestId: "b".repeat(64),
};
const input = {
  expectedInstallationGeneration: "g1",
  expectedRevision: 0,
  policy: DEFAULT_OPEN_REVIEW_POLICY,
};
const tx = {};
describe("merchant open-review policy service boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.fence.mockImplementation((_store, operation) => operation(tx));
    mocks.authorize.mockResolvedValue({
      storeId: "store_1",
      installationGeneration: "g1",
      appId: "trusted-app",
      shopifyUserId: "42",
    });
    mocks.read.mockResolvedValue({
      revision: 0,
      policy: DEFAULT_OPEN_REVIEW_POLICY,
      installationGeneration: null,
    });
    mocks.write.mockImplementation(async (_store, _input, authorize) => {
      await authorize(tx);
      return { revision: 1, policy: input.policy };
    });
  });
  it("reads only after configure permission in a generation-fenced transaction", async () => {
    expect(
      await readShopifyMerchantOpenReviewPolicy({ envelope, input: {} }),
    ).toEqual({
      revision: 0,
      policy: DEFAULT_OPEN_REVIEW_POLICY,
      installationGeneration: "g1",
      requiresReauthorization: false,
      policyEnabledForInstallation: false,
    });
    expect(mocks.authorize).toHaveBeenCalledWith({
      tx,
      envelope,
      permission: "reviews.configure",
    });
    expect(mocks.fence).toHaveBeenCalledWith(
      "store_1",
      expect.any(Function),
      "g1",
    );
    expect(mocks.read).toHaveBeenCalledWith(tx, "store_1");
  });
  it("does not present an old installation's enabled policy as active", async () => {
    mocks.read.mockResolvedValue({
      revision: 2,
      policy: { ...DEFAULT_OPEN_REVIEW_POLICY, enabled: true },
      installationGeneration: "old",
    });
    expect(
      await readShopifyMerchantOpenReviewPolicy({ envelope, input: {} }),
    ).toMatchObject({
      revision: 2,
      requiresReauthorization: true,
      policyEnabledForInstallation: false,
    });
  });
  it("authorizes and audits writes within the history transaction", async () => {
    await writeShopifyMerchantOpenReviewPolicy({ envelope, input });
    expect(mocks.write).toHaveBeenCalledWith(
      "store_1",
      input,
      expect.any(Function),
    );
    expect(mocks.authorize).toHaveBeenCalledWith({
      tx,
      envelope,
      permission: "reviews.configure",
      recordAction: true,
    });
    expect(await mocks.write.mock.calls[0][2](tx)).toEqual({
      appId: "trusted-app",
      shopifyUserId: "42",
    });
  });
  it("rejects command/envelope generation mismatch before the writer", async () => {
    await expect(
      writeShopifyMerchantOpenReviewPolicy({
        envelope,
        input: { ...input, expectedInstallationGeneration: "other" },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("does not read settings after denied authorization", async () => {
    mocks.authorize.mockRejectedValue(new Error("denied"));
    await expect(
      readShopifyMerchantOpenReviewPolicy({ envelope, input: {} }),
    ).rejects.toThrow("denied");
    expect(mocks.read).not.toHaveBeenCalled();
    await expect(
      writeShopifyMerchantOpenReviewPolicy({ envelope, input }),
    ).rejects.toThrow("denied");
  });
  it("rejects tenant and actor substitution in command JSON", async () => {
    await expect(
      readShopifyMerchantOpenReviewPolicy({
        envelope,
        input: { storeId: "foreign" },
      }),
    ).rejects.toThrow();
    await expect(
      writeShopifyMerchantOpenReviewPolicy({
        envelope,
        input: { ...input, appId: "foreign" },
      }),
    ).rejects.toThrow();
    expect(mocks.fence).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });
});
