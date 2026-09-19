// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reviewFormCopy } from "../../../../packages/shopify-app/app/reviews-form-copy";
import {
  REVIEW_FORM_SCRIPT,
  reviewFormResponse,
} from "../../../../packages/shopify-app/app/reviews-form.server";

const token = "A".repeat(43);
const transport = vi.fn<typeof fetch>();
const element = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const form = () => element<HTMLFormElement>("review");
const status = () => element("status").textContent;
const submit = () =>
  form().dispatchEvent(
    new Event("submit", { bubbles: true, cancelable: true }),
  );

async function mount(locale: unknown = "en", fragment = `token=${token}`) {
  history.replaceState(
    null,
    "",
    `/apps/weletic/reviews/write?locale=vi#${fragment}`,
  );
  const response = reviewFormResponse(locale);
  const parsed = new DOMParser().parseFromString(
    await response.text(),
    "text/html",
  );
  document.documentElement.lang = parsed.documentElement.lang;
  document.documentElement.innerHTML = parsed.documentElement.innerHTML;
  // Execute the actual production script with its fixed, server-owned dictionary.
  new Function("REVIEW_FORM_COPY", REVIEW_FORM_SCRIPT)(reviewFormCopy);
  return response;
}
function fill() {
  element<HTMLSelectElement>("rating").value = "1";
  element<HTMLInputElement>("displayName").value = "Buyer";
  element<HTMLInputElement>("title").value = "Honest opinion";
  element<HTMLTextAreaElement>("body").value =
    "This product did not meet my expectations.";
  element<HTMLInputElement>("consent").checked = true;
}
function changeLanguage(locale: string) {
  element<HTMLSelectElement>("language").value = locale;
  element("language").dispatchEvent(new Event("change"));
}
beforeEach(() => {
  transport.mockReset().mockImplementation(async (url) =>
    Response.json(
      String(url).endsWith("/request")
        ? {
            productTitle: '<img src=x onerror="alert(1)">',
            photoUploadsEnabled: true,
          }
        : { status: "pending" },
    ),
  );
  vi.stubGlobal("fetch", transport);
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.innerHTML = "";
});

describe("production review invitation form", () => {
  it("switches the saved disclosure safely without losing the review", async () => {
    transport.mockResolvedValue(
      Response.json({
        productTitle: "Product",
        photoUploadsEnabled: true,
        incentiveDisclosure: {
          en: ["10 points <img src=x>"],
          ja: ["10ポイント"],
          vi: ["10 điểm"],
        },
      }),
    );
    await mount();
    await vi.waitFor(() => expect(form().hidden).toBe(false));
    fill();
    expect(element("incentive-disclosure").textContent).toBe(
      "10 points <img src=x>",
    );
    expect(element("incentive-disclosure").querySelector("img")).toBeNull();
    changeLanguage("ja");
    expect(element("incentive-disclosure").textContent).toBe("10ポイント");
    changeLanguage("vi");
    expect(element("incentive-disclosure").textContent).toBe("10 điểm");
    expect(element<HTMLInputElement>("title").value).toBe("Honest opinion");
    expect(element<HTMLInputElement>("consent").checked).toBe(true);
  });
  it("does not permit submission when a disclosure lacks a supported locale", async () => {
    transport.mockResolvedValue(
      Response.json({
        productTitle: "Product",
        photoUploadsEnabled: true,
        incentiveDisclosure: { en: ["10 points"] },
      }),
    );
    await mount();
    await vi.waitFor(() =>
      expect(status()).toBe(reviewFormCopy.en.unavailable),
    );
    expect(form().hidden).toBe(true);
    submit();
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each(["en", "ja", "vi"] as const)(
    "completes a one-star submission in %s without exposing the token",
    async (locale) => {
      const response = await mount(locale);
      await vi.waitFor(() => expect(form().hidden).toBe(false));
      expect(document.documentElement.lang).toBe(locale);
      expect(document.title).toBe(reviewFormCopy[locale].pageTitle);
      expect(element("product").textContent).toContain("<img");
      expect(element("product").querySelector("img")).toBeNull();
      expect(location.hash).toBe("");
      expect(location.search).toBe("");
      expect(document.documentElement.outerHTML).not.toContain(token);
      expect(response.headers.get("content-security-policy")).toContain(
        "script-src 'nonce-",
      );
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      fill();
      submit();
      await vi.waitFor(() =>
        expect(status()).toBe(reviewFormCopy[locale].pending),
      );
      expect(form().hidden).toBe(true);
      expect(element<HTMLFieldSetElement>("fields").disabled).toBe(true);
      const [url, init] = transport.mock.calls[1];
      expect(url).toBe("/apps/weletic/reviews/submit");
      expect(JSON.parse(String(init?.body))).toEqual({
        token,
        rating: 1,
        title: "Honest opinion",
        body: "This product did not meet my expectations.",
        displayName: "Buyer",
        mediaIds: [],
        publishConsent: true,
      });
      submit();
      expect(transport).toHaveBeenCalledTimes(2);
    },
  );

  it("changes language without losing inputs, consent or issuing another request", async () => {
    await mount();
    await vi.waitFor(() => expect(form().hidden).toBe(false));
    fill();
    changeLanguage("ja");
    expect(element<HTMLTextAreaElement>("body").value).toContain(
      "expectations",
    );
    expect(element<HTMLInputElement>("consent").checked).toBe(true);
    expect(element<HTMLSelectElement>("rating").value).toBe("1");
    expect(document.querySelector("h1")?.textContent).toBe(
      reviewFormCopy.ja.heading,
    );
    expect(transport).toHaveBeenCalledOnce();
    submit();
    await vi.waitFor(() => expect(status()).toBe(reviewFormCopy.ja.pending));
    changeLanguage("vi");
    expect(status()).toBe(reviewFormCopy.vi.pending);
  });

  it.each(["", "token=bad"])(
    "rejects invalid invitation %s before any request",
    async (fragment) => {
      await mount("ja", fragment);
      await vi.waitFor(() => expect(status()).toBe(reviewFormCopy.ja.invalid));
      expect(form().hidden).toBe(true);
      expect(transport).not.toHaveBeenCalled();
      changeLanguage("vi");
      expect(status()).toBe(reviewFormCopy.vi.invalid);
    },
  );

  it.each([403, 404, 500])(
    "localizes invitation HTTP %s without leaking server messages",
    async (httpStatus) => {
      transport.mockResolvedValue(
        Response.json(
          { error: { message: "private@example.invalid secret" } },
          { status: httpStatus },
        ),
      );
      await mount("vi");
      await vi.waitFor(() =>
        expect(status()).toBe(
          httpStatus === 500
            ? reviewFormCopy.vi.unavailable
            : reviewFormCopy.vi.invalid,
        ),
      );
      expect(document.body.textContent).not.toContain(
        "private@example.invalid",
      );
      expect(form().hidden).toBe(true);
    },
  );

  it("keeps submission unavailable until a valid preview and requires consent", async () => {
    let resolve!: (response: Response) => void;
    transport.mockReturnValueOnce(
      new Promise<Response>((done) => {
        resolve = done;
      }),
    );
    await mount();
    fill();
    submit();
    expect(transport).toHaveBeenCalledOnce();
    changeLanguage("ja");
    expect(element("product").textContent).toBe(reviewFormCopy.ja.checking);
    resolve(
      Response.json({ productTitle: "Product", photoUploadsEnabled: false }),
    );
    await vi.waitFor(() => expect(form().hidden).toBe(false));
    expect(element("photos").hidden).toBe(true);
    element<HTMLInputElement>("consent").checked = false;
    submit();
    expect(transport).toHaveBeenCalledOnce();
  });

  it("blocks concurrent submit events and locks an ambiguous result", async () => {
    await mount();
    await vi.waitFor(() => expect(form().hidden).toBe(false));
    let resolve!: (response: Response) => void;
    transport.mockReturnValueOnce(
      new Promise<Response>((done) => {
        resolve = done;
      }),
    );
    fill();
    submit();
    submit();
    expect(transport).toHaveBeenCalledTimes(2);
    resolve(Response.json({ status: "unknown", privateId: "never-render" }));
    await vi.waitFor(() => expect(status()).toBe(reviewFormCopy.en.uncertain));
    submit();
    expect(transport).toHaveBeenCalledTimes(2);
    expect(element<HTMLFieldSetElement>("fields").disabled).toBe(true);
    expect(document.body.textContent).not.toContain("never-render");
  });

  it("retains inputs after rejected validation, but never repeats a completed request", async () => {
    await mount("ja");
    await vi.waitFor(() => expect(form().hidden).toBe(false));
    transport.mockResolvedValueOnce(
      Response.json({ error: { message: "sensitive" } }, { status: 400 }),
    );
    fill();
    submit();
    await vi.waitFor(() =>
      expect(status()).toBe(reviewFormCopy.ja.invalidInput),
    );
    expect(element<HTMLFieldSetElement>("fields").disabled).toBe(false);
    expect(element<HTMLInputElement>("title").value).toBe("Honest opinion");
    transport.mockResolvedValueOnce(Response.json({ status: "published" }));
    submit();
    await vi.waitFor(() => expect(status()).toBe(reviewFormCopy.ja.published));
  });

  it.each(["network", "non-json"])(
    "locks a %s submission failure with localized copy",
    async (mode) => {
      await mount("vi");
      await vi.waitFor(() => expect(form().hidden).toBe(false));
      if (mode === "network")
        transport.mockRejectedValueOnce(new Error("private provider error"));
      else
        transport.mockResolvedValueOnce(
          new Response("private non-json provider error"),
        );
      fill();
      submit();
      await vi.waitFor(() =>
        expect(status()).toBe(reviewFormCopy.vi.uncertain),
      );
      expect(element<HTMLFieldSetElement>("fields").disabled).toBe(true);
      expect(document.body.textContent).not.toContain("private provider");
      submit();
      expect(transport).toHaveBeenCalledTimes(2);
    },
  );

  it.each([null, {}, { productTitle: "Product", photoUploadsEnabled: "true" }])(
    "keeps malformed preview %j hidden",
    async (preview) => {
      transport.mockResolvedValueOnce(Response.json(preview));
      await mount("ja");
      await vi.waitFor(() =>
        expect(status()).toBe(reviewFormCopy.ja.unavailable),
      );
      expect(form().hidden).toBe(true);
    },
  );

  it("reuses an uploaded photo after a rejected submission and locale change", async () => {
    await mount();
    await vi.waitFor(() => expect(form().hidden).toBe(false));
    const photo = new File(["synthetic image transport"], "photo.png", {
      type: "image/png",
    });
    Object.defineProperty(element("photoFiles"), "files", {
      value: [photo],
      configurable: true,
    });
    transport
      .mockResolvedValueOnce(Response.json({ id: "wrevmedia_photo1" }))
      .mockResolvedValueOnce(
        Response.json(
          { error: { message: "private rejection" } },
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(Response.json({ status: "pending" }));
    fill();
    submit();
    await vi.waitFor(() =>
      expect(status()).toBe(reviewFormCopy.en.invalidInput),
    );
    changeLanguage("vi");
    submit();
    await vi.waitFor(() => expect(status()).toBe(reviewFormCopy.vi.pending));
    expect(
      transport.mock.calls.filter(([url]) => String(url).endsWith("/upload")),
    ).toHaveLength(1);
    const submissions = transport.mock.calls.filter(([url]) =>
      String(url).endsWith("/submit"),
    );
    expect(submissions).toHaveLength(2);
    for (const [, init] of submissions)
      expect(JSON.parse(String(init?.body)).mediaIds).toEqual([
        "wrevmedia_photo1",
      ]);
  });

  it("rejects invalid photo types locally without an upload or submission", async () => {
    await mount("ja");
    await vi.waitFor(() => expect(form().hidden).toBe(false));
    Object.defineProperty(element("photoFiles"), "files", {
      value: [new File(["invalid"], "document.html", { type: "text/html" })],
      configurable: true,
    });
    fill();
    submit();
    await vi.waitFor(() =>
      expect(status()).toBe(reviewFormCopy.ja.invalidPhotos),
    );
    expect(transport).toHaveBeenCalledOnce();
    expect(element<HTMLFieldSetElement>("fields").disabled).toBe(false);
  });

  it("falls back for an unsupported locale without reflecting it into HTML", async () => {
    const response = reviewFormResponse('<script id="attack">');
    const html = await response.text();
    expect(html).toContain('<html lang="en">');
    expect(html).not.toContain('id="attack"');
  });
});
