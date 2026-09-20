import { describe, expect, it, vi } from "vitest";
import { createMerchantReviewTranslationsClient } from "../app/merchant-review-translations-client";

const input = {
  action: "remove" as const,
  reviewId: "review_1",
  locale: "ja" as const,
  expectedInstallationGeneration: "g1",
  expectedReviewVersion: 4,
  expectedTranslationRevision: 2,
};
const result = {
  reviewId: "review_1",
  locale: "ja",
  revision: 3,
  status: "removed",
};
describe("translation merchant transport", () => {
  it("posts one authenticated request and accepts only its exact result", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(result));
    const client = createMerchantReviewTranslationsClient(
      async () => "test-token",
      transport,
    );
    expect(await client.save(input)).toEqual(result);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledWith(
      "/api/merchant/review-translations/write",
      expect.objectContaining({
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        body: expect.any(String),
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
        }),
      }),
    );
    expect(JSON.parse(transport.mock.calls[0][1]!.body as string)).toEqual(
      input,
    );
  });
  it.each([
    { reviewId: "foreign" },
    { locale: "vi" },
    { revision: 2 },
    { status: "active" },
    { extra: "unexpected" },
  ])("rejects mismatched/ambiguous success without retry", async (override) => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ...result, ...override }));
    const client = createMerchantReviewTranslationsClient(
      async () => "test-token",
      transport,
    );
    await expect(client.save(input)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each([
    [401, "reauthenticate"],
    [403, "denied"],
    [404, "denied"],
    [410, "denied"],
    [409, "reload"],
    [500, "unavailable"],
  ] as const)("classifies HTTP %s without retry", async (status, code) => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("", { status }));
    await expect(
      createMerchantReviewTranslationsClient(
        async () => "token",
        transport,
      ).save(input),
    ).rejects.toMatchObject({ code });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("rejects untrusted read fields before fetching credentials", async () => {
    const token = vi.fn();
    const transport = vi.fn();
    await expect(
      createMerchantReviewTranslationsClient(token, transport).read({
        reviewId: "review_1",
        storeId: "foreign",
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(token).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });
  it("rejects another review returned by the read endpoint", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        reviewId: "foreign",
        installationGeneration: "g1",
        reviewVersion: 1,
        original: { title: "Original", body: "Body", status: "published" },
        translations: [],
      }),
    );
    await expect(
      createMerchantReviewTranslationsClient(
        async () => "token",
        transport,
      ).read({ reviewId: "review_1" }),
    ).rejects.toMatchObject({ code: "unavailable" });
  });
});
