// @vitest-environment jsdom
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, expect, it, vi } from "vitest";
import { ReviewProductPicker } from "../extensions/weletic-customer-account/src/ReviewProductPicker";
import { accountReviewCopy } from "../extensions/weletic-customer-account/src/reviews-copy";
const page = (id: string, title: string, cursor: string | null) => ({
  data: {
    products: {
      nodes: [{ id: `gid://shopify/Product/${id}`, title }],
      pageInfo: { hasNextPage: cursor !== null, endCursor: cursor },
    },
  },
});
afterEach(() => {
  act(() => render(null, document.body));
});
async function settle(text: string) {
  await vi.waitFor(async () => {
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain(text);
  });
}
async function click(label: string, count = 1) {
  await act(async () => {
    const button = Array.from(document.querySelectorAll("s-button")).find(
      (node) => node.textContent === label,
    );
    expect(button).toBeTruthy();
    for (let index = 0; index < count; index++) {
      button!.dispatchEvent(new Event("click"));
    }
  });
}
it.each(["en", "ja", "vi"] as const)(
  "renders %s labels and escaped product titles",
  async (language) => {
    const title = "<script>not markup</script>";
    await act(async () => {
      render(
        h(ReviewProductPicker, {
          language,
          queryProducts: async () => page("123", title, "next"),
        }),
        document.body,
      );
    });
    await settle(title);
    expect(document.body.textContent).toContain(
      accountReviewCopy[language].chooseProduct,
    );
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("s-button")?.getAttribute("href")).toBe(
      "extension://reviews?view=reviews&productId=gid%3A%2F%2Fshopify%2FProduct%2F123",
    );
  },
);
it.each([1, 2])(
  "paginates forward/back safely with %i rapid clicks",
  async (count) => {
    const queryProducts = vi
      .fn()
      .mockResolvedValueOnce(page("1", "First", "second"))
      .mockResolvedValueOnce(page("2", "Second", null))
      .mockResolvedValueOnce(page("1", "First", "second"));
    await act(async () => {
      render(
        h(ReviewProductPicker, { language: "en", queryProducts }),
        document.body,
      );
    });
    await settle("First");
    await click(accountReviewCopy.en.nextProducts, count);
    await settle("Second");
    expect(queryProducts.mock.calls[1][1].variables).toEqual({
      after: "second",
    });
    await click(accountReviewCopy.en.previousProducts, count);
    await settle("First");
    expect(queryProducts.mock.calls[2][1].variables).toEqual({ after: null });
    expect(queryProducts).toHaveBeenCalledTimes(3);
    expect(document.body.textContent).not.toContain(
      accountReviewCopy.en.previousProducts,
    );
  },
);
it("offers an explicit retry without exposing provider errors", async () => {
  const queryProducts = vi
    .fn()
    .mockRejectedValueOnce(new Error("private provider text"))
    .mockResolvedValueOnce(page("1", "Recovered", null));
  await act(async () => {
    render(
      h(ReviewProductPicker, { language: "en", queryProducts }),
      document.body,
    );
  });
  await settle(accountReviewCopy.en.catalogUnavailable);
  expect(document.body.textContent).not.toContain("private provider text");
  await click(accountReviewCopy.en.catalogRetry);
  await settle("Recovered");
  expect(queryProducts).toHaveBeenCalledTimes(2);
});
