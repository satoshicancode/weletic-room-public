// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeAll, expect, it, vi } from "vitest";

const source = readFileSync(
  resolve(
    process.cwd(),
    "extensions/weletic-analytics/assets/weletic-store-reviews.js",
  ),
  "utf8",
);
beforeAll(() => new Function(source)());
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
const review = {
  rating: 4,
  title: "Store <script>bad()</script>",
  body: "Helpful staff",
  displayName: "Buyer",
  createdAt: "2026-09-23T00:00:00Z",
  verifiedPurchase: true,
  incentivized: true,
  merchantReply: "Thank you",
};
function mount(locale: string) {
  const widget = document.createElement("weletic-store-reviews");
  widget.dataset.locale = locale;
  widget.dataset.proxy = "/apps/weletic/reviews";
  document.body.append(widget);
  return widget;
}
it.each([
  ["en", "Store experience reviews"],
  ["ja", "ストア体験のレビュー"],
  ["vi", "Đánh giá trải nghiệm cửa hàng"],
])("renders safe store feedback in %s", async (locale, heading) => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      summary: { count: 1, average: 4 },
      items: [review],
      nextCursor: null,
    }),
  });
  vi.stubGlobal("fetch", fetchMock);
  const widget = mount(locale);
  await vi.waitFor(() =>
    expect(widget.querySelector("article")).not.toBeNull(),
  );
  expect(widget.querySelector("h2")?.textContent).toBe(heading);
  expect(widget.querySelector("script")).toBeNull();
  expect(widget.querySelector("h3")?.textContent).toBe(review.title);
  expect(fetchMock.mock.calls[0][0]).toContain(
    "/apps/weletic/reviews/store-list?",
  );
  expect(fetchMock.mock.calls[0][1]).toMatchObject({
    cache: "no-store",
    credentials: "same-origin",
  });
});
it("clears rows and totals after pagination loses privacy access", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          summary: { count: 2, average: 4 },
          items: [review],
          nextCursor: "page-two",
        }),
      })
      .mockResolvedValueOnce({ ok: false, status: 503 }),
  );
  const widget = mount("en");
  await vi.waitFor(() =>
    expect(widget.querySelector("article")).not.toBeNull(),
  );
  (widget.querySelector("button") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(widget.querySelector("article")).toBeNull());
  expect(widget.querySelector(".wsr-summary")?.textContent).toBe("");
  expect(widget.textContent).toContain("temporarily unavailable");
});
