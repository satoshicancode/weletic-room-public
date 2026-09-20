import { afterEach, expect, it, vi } from "vitest";
import { reviewProducts } from "../extensions/weletic-customer-account/src/reviews-products";

const page = {
  data: {
    products: {
      nodes: [{ id: "gid://shopify/Product/1", title: "Public product" }],
      pageInfo: { hasNextPage: true, endCursor: "next" },
    },
  },
};
afterEach(() => vi.useRealTimers());
it("queries only public product fields with bounded cursor pagination", async () => {
  const query = vi.fn().mockResolvedValue(page);
  expect(await reviewProducts(query, null)).toEqual({
    nodes: page.data.products.nodes,
    next: "next",
  });
  expect(query.mock.calls[0][0]).not.toMatch(/customer|order|email|token/i);
  expect(query.mock.calls[0][0]).toContain("first: 20");
  expect(query.mock.calls[0][1]).toEqual({
    variables: { after: null },
    version: "2026-07",
  });
});
it.each([
  { errors: [{ message: "private provider detail" }], ...page },
  { data: null },
  {
    data: {
      products: {
        nodes: [{ id: "gid://shopify/Customer/1", title: "x" }],
        pageInfo: { hasNextPage: false },
      },
    },
  },
  {
    data: {
      products: {
        nodes: [],
        pageInfo: { hasNextPage: true, endCursor: "next" },
      },
    },
  },
  {
    data: {
      products: {
        nodes: page.data.products.nodes,
        pageInfo: { hasNextPage: "false" },
      },
    },
  },
])(
  "fails closed on incomplete or malformed catalog result",
  async (response) => {
    await expect(reviewProducts(async () => response, null)).rejects.toThrow(
      "unavailable",
    );
  },
);
it("rejects a stuck cursor rather than cycling forever", async () => {
  await expect(reviewProducts(async () => page, "next")).rejects.toThrow(
    "unavailable",
  );
});
it("times out without retrying a hung platform query", async () => {
  vi.useFakeTimers();
  const query = vi.fn(() => new Promise(() => {}));
  const promise = expect(reviewProducts(query, null)).rejects.toThrow(
    "unavailable",
  );
  await vi.advanceTimersByTimeAsync(10_000);
  await promise;
  expect(query).toHaveBeenCalledTimes(1);
});
