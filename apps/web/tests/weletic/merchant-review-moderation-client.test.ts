import { describe, expect, it, vi } from "vitest";
import { createMerchantReviewModerationClient } from "../../../../packages/shopify-app/app/merchant-review-moderation-client";

const input = {
  reviewId: "review-1",
  version: 1,
  status: "hidden" as const,
  reason: "spam" as const,
};
const response = {
  reviewId: "review-1",
  auditId: "audit-1",
  version: 2,
  status: "hidden",
};

describe("merchant moderation browser adapter", () => {
  it("gets a fresh token for each explicit request without cookies", async () => {
    const token = vi
      .fn()
      .mockResolvedValueOnce("token-1")
      .mockResolvedValueOnce("token-2");
    const transport = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json(response));
    const save = createMerchantReviewModerationClient(token, transport);
    await expect(save(input)).resolves.toEqual(response);
    await save(input);
    expect(token).toHaveBeenCalledTimes(2);
    expect(transport).toHaveBeenNthCalledWith(
      1,
      "/api/merchant/review-moderation",
      expect.objectContaining({
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        body: JSON.stringify(input),
        headers: expect.objectContaining({ Authorization: "Bearer token-1" }),
      }),
    );
    expect(transport).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer token-2" }),
      }),
    );
  });
  it.each([400, 401, 403, 404, 409, 503])(
    "never retries HTTP %s",
    async (status) => {
      const transport = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({}, { status }));
      await expect(
        createMerchantReviewModerationClient(
          async () => "token",
          transport,
        )(input),
      ).rejects.toBeDefined();
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    { ...response, reviewId: "other-review" },
    { ...response, version: 1 },
    { ...response, version: 3 },
    { ...response, status: "published" },
    { ...response, reasonDetails: "Private explanation" },
    { ...response, auditId: undefined },
  ])("rejects mismatched or private response %j", async (value) => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(value));
    await expect(
      createMerchantReviewModerationClient(
        async () => "token",
        transport,
      )(input),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("rejects invalid input before authentication", async () => {
    const token = vi.fn().mockResolvedValue("token");
    await expect(
      createMerchantReviewModerationClient(token)({ ...input, version: 0 }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(token).not.toHaveBeenCalled();
  });
  it("does not retry an uncertain transport failure", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("connection lost after send"));
    await expect(
      createMerchantReviewModerationClient(
        async () => "token",
        transport,
      )(input),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
