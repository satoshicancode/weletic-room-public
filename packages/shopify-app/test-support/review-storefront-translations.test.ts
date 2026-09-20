// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
const source = readFileSync(
  resolve(
    process.cwd(),
    "extensions/weletic-analytics/assets/weletic-reviews.js",
  ),
  "utf8",
);
beforeAll(() => {
  new Function(source)();
});
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
function mount(locale = "en") {
  const widget = document.createElement("weletic-reviews");
  widget.dataset.mode = "full";
  widget.dataset.locale = locale;
  widget.dataset.proxy = "/apps/weletic/reviews";
  widget.dataset.productId = "123";
  document.body.append(widget);
  return widget;
}
const originalReview = {
  title: "Original title",
  body: "Original body",
  displayName: "Reviewer",
  rating: 1,
  createdAt: "2026-09-20T00:00:00Z",
  verifiedPurchase: false,
  incentivized: false,
  merchantReply: null,
  media: [],
};
it("clears cached cards, original text and totals after pagination loses access", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        summary: { count: 2, average: 1 },
        nextCursor: "private-boundary",
        items: [originalReview],
      }),
    })
    .mockResolvedValueOnce({ ok: false, status: 404 });
  vi.stubGlobal("fetch", fetchMock);
  const widget = mount();
  await vi.waitFor(() =>
    expect(widget.querySelector("article")).not.toBeNull(),
  );
  const more = [...widget.querySelectorAll("button")].find(
    (item) => item.textContent === "Load more reviews",
  )!;
  more.click();
  await vi.waitFor(() => expect(widget.querySelector("article")).toBeNull());
  expect(widget.textContent).not.toContain("Original body");
  expect(widget.textContent).not.toContain("2 reviews");
  expect(widget.querySelector(".wr-summary")!.textContent).toBe("");
  expect(more.hidden).toBe(true);
  expect(widget.textContent).toContain("temporarily unavailable");
});
it.each([
  undefined,
  {
    locale: "ja",
    original: { title: "Japanese source", body: "Other source" },
  },
])(
  "does not offer a translation toggle for an original-only or wrong-locale item",
  async (translation) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          summary: { count: 1, average: 1 },
          nextCursor: null,
          items: [{ ...originalReview, translation }],
        }),
      }),
    );
    const widget = mount("unsupported");
    await vi.waitFor(() =>
      expect(widget.querySelector("article")).not.toBeNull(),
    );
    expect(widget.lang).toBe("en");
    expect(widget.querySelector("article button")).toBeNull();
    expect(widget.textContent).not.toContain("Other source");
    expect(widget.querySelector("h3")!.textContent).toBe("Original title");
  },
);
it.each([
  ["en", "Show original", "Show translation"],
  ["ja", "原文を表示", "翻訳を表示"],
  ["vi", "Xem bản gốc", "Xem bản dịch"],
])(
  "renders and toggles a %s translation as safe text",
  async (locale, originalLabel, translatedLabel) => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        summary: { count: 1, average: 2 },
        nextCursor: null,
        items: [
          {
            title: "Translated <script>bad()</script>",
            body: "Translated body",
            displayName: "Reviewer",
            rating: 2,
            createdAt: "2026-09-20T00:00:00Z",
            verifiedPurchase: true,
            incentivized: false,
            merchantReply: null,
            media: [],
            translation: {
              locale,
              original: {
                title: "Original <img src=x>",
                body: "Original body",
              },
            },
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const widget = document.createElement("weletic-reviews");
    widget.dataset.mode = "full";
    widget.dataset.locale = locale + "-XX";
    widget.dataset.proxy = "/apps/weletic/reviews";
    widget.dataset.productId = "123";
    document.body.append(widget);
    await vi.waitFor(() =>
      expect(widget.querySelector("article")).not.toBeNull(),
    );
    expect(fetchMock.mock.calls[0][0]).toContain("locale=" + locale);
    expect(widget.querySelector("script, img")).toBeNull();
    const toggle = [...widget.querySelectorAll("button")].find(
      (button) => button.textContent === originalLabel,
    )!;
    expect(toggle).toBeDefined();
    toggle.click();
    expect(widget.querySelector("h3")!.textContent).toBe(
      "Original <img src=x>",
    );
    expect(toggle.textContent).toBe(translatedLabel);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    toggle.click();
    expect(widget.querySelector("h3")!.textContent).toBe(
      "Translated <script>bad()</script>",
    );
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(widget.querySelector("script, img")).toBeNull();
  },
);
