// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  OPEN_REVIEW_FORM_SCRIPT,
  openReviewFormCopy,
} from "../../../../packages/shopify-app/app/open-reviews-form";
import { reviewFormResponse } from "../../../../packages/shopify-app/app/reviews-form.server";
const transport = vi.fn<typeof fetch>();
const policy = {
  authorBinding: "a".repeat(64),
  productId: "gid://shopify/Product/456",
  expectedInstallationGeneration: "g1",
  expectedSettingsRevision: 7,
  disclosureRevision: "open_unverified_unrewarded_v1",
  verifiedPurchase: false,
  incentivized: false,
  photoUploadsAvailable: false,
};
const el = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const submit = () =>
  el("review").dispatchEvent(
    new Event("submit", { bubbles: true, cancelable: true }),
  );
it("allows replacing a server-invalid photo before dispatching any review", async () => {
  transport.mockImplementation(async (url) => {
    if (String(url).endsWith("open-prepare"))
      return Response.json({ ...policy, photoUploadsAvailable: true });
    if (String(url).endsWith("open-upload"))
      return Response.json(
        { error: { code: "invalid_open_photo" } },
        { status: 400 },
      );
    return Response.json({ status: "received", duplicate: false });
  });
  await mount();
  await vi.waitFor(() =>
    expect(el<HTMLFormElement>("review").hidden).toBe(false),
  );
  fill();
  Object.defineProperty(el("photoFiles"), "files", {
    configurable: true,
    value: [new File(["not a PNG"], "bad.png", { type: "image/png" })],
  });
  submit();
  await vi.waitFor(() =>
    expect(el("status").textContent).toBe(openReviewFormCopy.en.invalidPhotos),
  );
  expect(el<HTMLFieldSetElement>("fields").disabled).toBe(false);
  expect(
    transport.mock.calls.some(([url]) => String(url).endsWith("open-submit")),
  ).toBe(false);
  Object.defineProperty(el("photoFiles"), "files", {
    configurable: true,
    value: [],
  });
  submit();
  await vi.waitFor(() =>
    expect(el("status").textContent).toBe(openReviewFormCopy.en.pending),
  );
  expect(
    transport.mock.calls.filter(([url]) => String(url).endsWith("open-submit")),
  ).toHaveLength(1);
});
async function mount(
  locale: "en" | "ja" | "vi" = "en",
  productId = policy.productId,
) {
  history.replaceState(
    null,
    "",
    "/apps/weletic/reviews/open-write?productId=" +
      encodeURIComponent(productId),
  );
  const response = reviewFormResponse(locale, "open");
  const parsed = new DOMParser().parseFromString(
    await response.text(),
    "text/html",
  );
  document.documentElement.lang = parsed.documentElement.lang;
  document.documentElement.innerHTML = parsed.documentElement.innerHTML;
  new Function("REVIEW_FORM_COPY", OPEN_REVIEW_FORM_SCRIPT)(openReviewFormCopy);
  return response;
}
function fill() {
  el<HTMLSelectElement>("rating").value = "1";
  el<HTMLInputElement>("displayName").value = "Reviewer";
  el<HTMLInputElement>("title").value = "Honest review";
  el<HTMLTextAreaElement>("body").value =
    "The product did not meet my expectations.";
  el<HTMLInputElement>("consent").checked = true;
}
beforeEach(() => {
  transport
    .mockReset()
    .mockImplementation(async (url) =>
      Response.json(
        String(url).endsWith("open-prepare")
          ? policy
          : { status: "received", duplicate: false },
      ),
    );
  vi.stubGlobal("fetch", transport);
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.innerHTML = "";
});
it.each(["en", "ja", "vi"] as const)(
  "uploads photos and submits the %s review with exact retry identity",
  async (locale) => {
    let attempts = 0;
    transport.mockImplementation(async (url) => {
      if (String(url).endsWith("open-prepare"))
        return Response.json({ ...policy, photoUploadsAvailable: true });
      if (String(url).endsWith("open-upload")) {
        attempts++;
        if (attempts === 1) throw new Error("lost response");
        return Response.json({ id: "wrevmedia_fixture" });
      }
      return Response.json({ status: "received", duplicate: false });
    });
    await mount(locale);
    await vi.waitFor(() =>
      expect(el<HTMLFormElement>("review").hidden).toBe(false),
    );
    expect(el("photos").hidden).toBe(false);
    fill();
    const file = new File(["synthetic photo"], "private-name.png", {
      type: "image/png",
    });
    Object.defineProperty(el("photoFiles"), "files", {
      configurable: true,
      value: [file],
    });
    submit();
    submit();
    await vi.waitFor(() => expect(el("retry").hidden).toBe(false));
    expect(attempts).toBe(1);
    expect(el<HTMLFieldSetElement>("fields").disabled).toBe(true);
    const original = transport.mock.calls.find(([url]) =>
      String(url).endsWith("open-upload"),
    )![1]!.body;
    Object.defineProperty(el("photoFiles"), "files", {
      configurable: true,
      value: [new File(["changed"], "changed.png", { type: "image/png" })],
    });
    el("retry").click();
    el("retry").click();
    await vi.waitFor(() =>
      expect(el("status").textContent).toBe(openReviewFormCopy[locale].pending),
    );
    const uploads = transport.mock.calls.filter(([url]) =>
      String(url).endsWith("open-upload"),
    );
    expect(uploads).toHaveLength(2);
    expect(uploads[1][1]!.body).toBe(original);
    const upload = JSON.parse(String(original));
    const submitted = JSON.parse(
      String(
        transport.mock.calls.find(([url]) =>
          String(url).endsWith("open-submit"),
        )![1]!.body,
      ),
    );
    expect(submitted.submissionId).toBe(upload.submissionId);
    expect(submitted.mediaIds).toEqual(["wrevmedia_fixture"]);
    expect(upload).not.toHaveProperty("fileName");
    expect(document.documentElement.outerHTML).not.toContain(upload.base64);
    expect(document.documentElement.outerHTML).not.toContain(
      policy.authorBinding,
    );
  },
);
it("rejects excessive or empty photos before any upload dispatch", async () => {
  transport.mockResolvedValue(
    Response.json({ ...policy, photoUploadsAvailable: true }),
  );
  await mount();
  await vi.waitFor(() =>
    expect(el<HTMLFormElement>("review").hidden).toBe(false),
  );
  fill();
  Object.defineProperty(el("photoFiles"), "files", {
    configurable: true,
    value: [new File([], "empty.png", { type: "image/png" })],
  });
  submit();
  expect(el("status").textContent).toBe(openReviewFormCopy.en.invalidPhotos);
  expect(transport).toHaveBeenCalledTimes(1);
});
it.each(["en", "ja", "vi"] as const)(
  "prepares and submits the %s unverified/unrewarded form",
  async (locale) => {
    const response = await mount(locale);
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    await vi.waitFor(() =>
      expect(el<HTMLFormElement>("review").hidden).toBe(false),
    );
    expect(document.body.textContent).toContain(
      openReviewFormCopy[locale].rewardNotice,
    );
    expect(el("photos").hidden).toBe(true);
    fill();
    submit();
    submit();
    await vi.waitFor(() =>
      expect(el("status").textContent).toBe(openReviewFormCopy[locale].pending),
    );
    expect(document.activeElement).toBe(el("status"));
    expect(transport).toHaveBeenCalledTimes(2);
    const data = JSON.parse(String(transport.mock.calls[1][1]?.body));
    expect(data).toMatchObject({
      productId: policy.productId,
      expectedSettingsRevision: 7,
      locale,
      rating: 1,
      mediaIds: [],
      publishConsent: true,
    });
    expect(data).not.toHaveProperty("customerId");
    expect(data).not.toHaveProperty("email");
  },
);
it("retries an ambiguous response with exactly the same payload despite language changes", async () => {
  transport.mockImplementation(async (url) => {
    if (String(url).endsWith("prepare")) return Response.json(policy);
    throw new Error("ambiguous response");
  });
  await mount();
  await vi.waitFor(() =>
    expect(el<HTMLFormElement>("review").hidden).toBe(false),
  );
  fill();
  submit();
  await vi.waitFor(() =>
    expect(el<HTMLButtonElement>("retry").hidden).toBe(false),
  );
  const first = transport.mock.calls[1][1]?.body;
  expect(document.activeElement).toBe(el("retry"));
  expect(el("retry").getAttribute("aria-describedby")).toBe("status");
  expect(el<HTMLFieldSetElement>("fields").disabled).toBe(true);
  el<HTMLSelectElement>("language").value = "ja";
  el("language").dispatchEvent(new Event("change"));
  transport.mockResolvedValue(
    Response.json({ status: "received", duplicate: true }),
  );
  el<HTMLButtonElement>("retry").click();
  await vi.waitFor(() =>
    expect(el("status").textContent).toBe(openReviewFormCopy.ja.pending),
  );
  expect(transport.mock.calls[2][1]?.body).toBe(first);
});
it.each([
  { ...policy, verifiedPurchase: true },
  { ...policy, expectedSettingsRevision: 0 },
  { ...policy, productId: "gid://shopify/Product/999" },
])(
  "does not enable a form with a mismatched prepare response",
  async (badPolicy) => {
    transport.mockResolvedValue(Response.json(badPolicy));
    await mount();
    await vi.waitFor(() =>
      expect(el("status").textContent).toBe(openReviewFormCopy.en.invalid),
    );
    expect(el<HTMLFormElement>("review").hidden).toBe(true);
  },
);
it("rejects invalid product IDs before transport", async () => {
  await mount("en", "<script>bad</script>");
  expect(transport).not.toHaveBeenCalled();
  expect(document.querySelector("script[src]")).toBeNull();
});
it("rejects trimmed-empty content before freezing or dispatching", async () => {
  await mount();
  await vi.waitFor(() =>
    expect(el<HTMLFormElement>("review").hidden).toBe(false),
  );
  fill();
  el<HTMLInputElement>("title").value = "   ";
  submit();
  expect(transport).toHaveBeenCalledTimes(1);
  expect(el<HTMLFieldSetElement>("fields").disabled).toBe(false);
  expect(el("status").textContent).toBe(openReviewFormCopy.en.invalidInput);
});
it("allows correction after a definite initial validation rejection", async () => {
  await mount();
  await vi.waitFor(() =>
    expect(el<HTMLFormElement>("review").hidden).toBe(false),
  );
  transport.mockResolvedValue(
    Response.json({ error: { code: "invalid_review_input" } }, { status: 400 }),
  );
  fill();
  submit();
  await vi.waitFor(() =>
    expect(el("status").textContent).toBe(openReviewFormCopy.en.invalidInput),
  );
  expect(el<HTMLFieldSetElement>("fields").disabled).toBe(false);
  expect(el("retry").hidden).toBe(true);
});
it("never unlocks an uncertain accepted operation after a later rejection", async () => {
  await mount();
  await vi.waitFor(() =>
    expect(el<HTMLFormElement>("review").hidden).toBe(false),
  );
  transport.mockRejectedValue(new Error("lost response"));
  fill();
  submit();
  await vi.waitFor(() => expect(el("retry").hidden).toBe(false));
  transport.mockResolvedValue(Response.json({}, { status: 400 }));
  el<HTMLButtonElement>("retry").click();
  await vi.waitFor(() =>
    expect(el("status").textContent).toBe(openReviewFormCopy.en.uncertain),
  );
  expect(el<HTMLFieldSetElement>("fields").disabled).toBe(true);
  expect(transport.mock.calls[2][1]?.body).toBe(
    transport.mock.calls[1][1]?.body,
  );
});
it("does not treat an unmarked upstream 400 as proof that nothing committed", async () => {
  await mount();
  await vi.waitFor(() =>
    expect(el<HTMLFormElement>("review").hidden).toBe(false),
  );
  transport.mockResolvedValue(
    Response.json({ error: { code: "review_error" } }, { status: 400 }),
  );
  fill();
  submit();
  await vi.waitFor(() =>
    expect(el("status").textContent).toBe(openReviewFormCopy.en.uncertain),
  );
  expect(el<HTMLFieldSetElement>("fields").disabled).toBe(true);
});
it("keeps the form hidden after expired authentication", async () => {
  transport.mockResolvedValue(
    Response.json({ error: "private upstream" }, { status: 401 }),
  );
  await mount();
  await vi.waitFor(() =>
    expect(el("status").textContent).toBe(openReviewFormCopy.en.invalid),
  );
  expect(el<HTMLFormElement>("review").hidden).toBe(true);
  expect(el("status").textContent).not.toContain("private upstream");
});
