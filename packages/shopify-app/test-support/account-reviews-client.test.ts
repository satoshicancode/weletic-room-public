import { describe, expect, it, vi } from "vitest";
import {
  AccountReviewError,
  accountReviewProduct,
  accountReviewSubmission,
  accountReviewTransport,
  prepareAccountReview,
  type ReviewTransport,
} from "../extensions/weletic-customer-account/src/reviews-client";

const productId = "gid://shopify/Product/456";
const prepared = {
  productId,
  productTitle: "Product fixture",
  expectedInstallationGeneration: "generation_1",
  expectedSettingsRevision: 1,
  authorBinding: "a".repeat(64),
  disclosureRevision: "open_unverified_unrewarded_v1",
  verifiedPurchase: false,
  incentivized: false,
  photoUploadsAvailable: true,
};
const draft = {
  rating: 1,
  displayName: "Reviewer",
  title: "Honest feedback",
  body: "The product did not meet my expectations.",
  publishConsent: true,
  locale: "en" as const,
};
async function policy() {
  return prepareAccountReview(productId, async () => prepared);
}

describe("account review preparation", () => {
  it("accepts one product query, never customer claims", () => {
    const url = `https://account.example.test/pages/reviews?productId=${encodeURIComponent(productId)}`;
    expect(accountReviewProduct(url)).toBe(productId);
    expect(
      accountReviewProduct(`${url}&productId=${encodeURIComponent(productId)}`),
    ).toBeNull();
    expect(accountReviewProduct(null)).toBeNull();
    expect(accountReviewProduct("invalid")).toBeNull();
    expect(
      accountReviewProduct("https://example.test?productId=123"),
    ).toBeNull();
  });
  it.each([
    { verifiedPurchase: true },
    { incentivized: true },
    { productId: "other" },
    { productTitle: "" },
    { productTitle: undefined },
    { authorBinding: "bad" },
    { expectedSettingsRevision: 0 },
    { expectedSettingsRevision: 2147483648 },
    { photoUploadsAvailable: undefined },
    { expectedInstallationGeneration: "" },
    { disclosureRevision: "legacy" },
  ])("rejects malformed or rewarded preparation %j", async (change) => {
    await expect(
      prepareAccountReview(productId, async () => ({ ...prepared, ...change })),
    ).rejects.toMatchObject({ code: "unavailable" });
  });
  it("copies only immutable authority, with no server identities", async () => {
    const result = await prepareAccountReview(productId, async () => ({
      ...prepared,
      customerId: "private",
    }));
    expect(result).not.toHaveProperty("customerId");
    expect(Object.isFrozen(result)).toBe(true);
  });
});

describe("account review submission", () => {
  it("allows definite initial rejection but preserves prior ambiguity", async () => {
    const transport = vi
      .fn<ReviewTransport>()
      .mockRejectedValueOnce(new AccountReviewError("invalidInput"));
    const submit = accountReviewSubmission(
      await policy(),
      draft,
      [],
      transport,
    );
    await expect(submit.send()).rejects.toMatchObject({ code: "invalidInput" });
    const retryTransport = vi
      .fn<ReviewTransport>()
      .mockRejectedValueOnce(new Error("lost reply"))
      .mockRejectedValueOnce(new AccountReviewError("invalidInput"));
    const uncertain = accountReviewSubmission(
      await policy(),
      draft,
      [],
      retryTransport,
    );
    await expect(uncertain.send()).rejects.toMatchObject({ code: "uncertain" });
    await expect(uncertain.send()).rejects.toMatchObject({ code: "uncertain" });
  });
  it("enforces the exact decoded photo bound including padding", async () => {
    const authority = await policy();
    const photo = (bytes: number) => [
      {
        contentType: "image/png",
        base64: Buffer.alloc(bytes).toString("base64"),
      },
    ];
    expect(() =>
      accountReviewSubmission(
        authority,
        draft,
        photo(2 * 1024 * 1024),
        vi.fn(),
      ),
    ).not.toThrow();
    expect(() =>
      accountReviewSubmission(
        authority,
        draft,
        photo(2 * 1024 * 1024 + 1),
        vi.fn(),
      ),
    ).toThrow("invalidPhotos");
  });
  it("freezes the draft and retries the identical uncertain operation", async () => {
    const transport = vi
      .fn<ReviewTransport>()
      .mockRejectedValueOnce(new Error("lost reply"))
      .mockResolvedValue({ status: "received", duplicate: true });
    const input = { ...draft };
    const submit = accountReviewSubmission(
      await policy(),
      input,
      [],
      transport,
      () => "same-uuid",
    );
    await expect(submit.send()).rejects.toMatchObject({ code: "uncertain" });
    input.body = "changed";
    await submit.send();
    expect(transport.mock.calls[0]).toEqual(transport.mock.calls[1]);
    expect(transport.mock.calls[1][1].body).toBe(draft.body);
    await submit.send();
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it("coalesces clicks and preserves confirmed uploads on retry", async () => {
    let release!: (value: unknown) => void;
    const transport = vi
      .fn<ReviewTransport>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockRejectedValueOnce(new Error("lost submit reply"))
      .mockResolvedValue({ status: "received", duplicate: true });
    const submit = accountReviewSubmission(
      await policy(),
      draft,
      [{ contentType: "image/png", base64: "YWJj" }],
      transport,
      () => "same-uuid",
    );
    const first = submit.send();
    expect(submit.send()).toBe(first);
    release({ id: "wrevmedia_owned" });
    await expect(first).rejects.toMatchObject({ code: "uncertain" });
    await submit.send();
    expect(transport.mock.calls.map((call) => call[0])).toEqual([
      "open-upload",
      "open-submit",
      "open-submit",
    ]);
    expect(transport.mock.calls[1]).toEqual(transport.mock.calls[2]);
    expect(transport.mock.calls[1][1].mediaIds).toEqual(["wrevmedia_owned"]);
  });
  it("never treats malformed success as acceptance", async () => {
    const transport = vi
      .fn<ReviewTransport>()
      .mockResolvedValue({ status: "received" });
    const submit = accountReviewSubmission(
      await policy(),
      draft,
      [],
      transport,
    );
    await expect(submit.send()).rejects.toMatchObject({ code: "uncertain" });
    await expect(submit.send()).rejects.toMatchObject({ code: "uncertain" });
    expect(transport.mock.calls[0]).toEqual(transport.mock.calls[1]);
  });
  it.each([
    { rating: 0 },
    { publishConsent: false },
    { title: "" },
    { body: "short" },
  ])("rejects invalid input before dispatch %j", async (change) => {
    const transport = vi.fn<ReviewTransport>();
    const authority = await policy();
    expect(() =>
      accountReviewSubmission(
        authority,
        { ...draft, ...change },
        [],
        transport,
      ),
    ).toThrow("invalidInput");
    expect(transport).not.toHaveBeenCalled();
  });
  it("rejects photos when policy disables them", async () => {
    const authority = { ...(await policy()), photoUploadsAvailable: false };
    expect(() =>
      accountReviewSubmission(
        authority,
        draft,
        [{ contentType: "image/png", base64: "YWJj" }],
        vi.fn(),
      ),
    ).toThrow("invalidPhotos");
  });
});

describe("account review session transport", () => {
  it.each([
    [400, "invalid_review_input", "invalidInput"],
    [403, "invalid_review_input", "unavailable"],
    [400, "review_error", "unavailable"],
  ] as const)(
    "classifies only explicit gateway preflight rejection: %s %s",
    async (status, code, expected) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json(
            { error: { code, message: "private detail" } },
            { status },
          ),
        );
      const send = accountReviewTransport(
        "https://app.example.test/reviews",
        async () => "token",
        fetcher,
      );
      await expect(send("open-submit", {})).rejects.toMatchObject({
        code: expected,
        message: expected,
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it("gets fresh tokens without automatic mutation retries or identity query fields", async () => {
    const token = vi
      .fn()
      .mockResolvedValueOnce("first")
      .mockResolvedValueOnce("second");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ ok: true }));
    const send = accountReviewTransport(
      "https://app.example.test/api/customer-account/reviews",
      token,
      fetcher,
    );
    await send("open-prepare", { productId });
    await send("open-submit", { title: "review" });
    expect(fetcher.mock.calls[0][0]).toBe(
      "https://app.example.test/api/customer-account/reviews/open-prepare",
    );
    expect(fetcher.mock.calls[1][1]).toMatchObject({
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
      headers: { Authorization: "Bearer second" },
    });
    expect(token).toHaveBeenCalledTimes(2);
  });
  it("rejects oversized responses and does not retry", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("x".repeat(8193)));
    const send = accountReviewTransport(
      "https://app.example.test/reviews",
      async () => "token",
      fetcher,
    );
    await expect(send("open-submit", {})).rejects.toThrow("unavailable");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not dispatch if authentication fails", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const send = accountReviewTransport(
      "https://app.example.test/reviews",
      async () => {
        throw new Error("expired");
      },
      fetcher,
    );
    await expect(send("open-prepare", {})).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
