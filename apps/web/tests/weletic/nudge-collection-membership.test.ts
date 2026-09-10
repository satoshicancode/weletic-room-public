import { expect, it } from "vitest";
import {
  buildNudgeCollectionMembershipQuery as build,
  parseNudgeCollectionMembership as parse,
} from "../../lib/weletic/loyalty/nudge-collection-membership";

const product = "gid://shopify/Product/1";
const collection = "gid://shopify/Collection/2";
it("uses variables, deduplicates and preserves exact response identities", () => {
  const request = build([product, product], [collection, collection])!;
  expect(request.variables).toEqual({ p0: product, c0: collection });
  expect(request.query).not.toContain(product);
  expect(parse(request, { data: { p0: { id: product, c0: true } } })).toEqual({
    [product]: [collection],
  });
  expect(parse(request, { data: { p0: { id: product, c0: false } } })).toEqual({
    [product]: [],
  });
});
it.each([
  "1",
  "gid://shopify/Collection/1",
  "gid://shopify/Product/0",
  'gid://shopify/Product/1") { id }',
  "gid://shopify/Product/123456789012345678901",
])("rejects invalid product %s", (id) => {
  expect(build([id], [collection])).toBeNull();
});
it("bounds raw inputs and the cross product", () => {
  expect(build([], [collection])).toBeNull();
  expect(build([product], [])).toBeNull();
  expect(build(Array(51).fill(product), [collection])).toBeNull();
  expect(build([product], Array(21).fill(collection))).toBeNull();
  expect(build([product], [product])).toBeNull();
  expect(
    build(
      Array.from({ length: 11 }, (_, i) => `gid://shopify/Product/${i + 1}`),
      Array.from({ length: 10 }, (_, i) => `gid://shopify/Collection/${i + 1}`),
    ),
  ).toBeNull();
});
it.each([
  null,
  {},
  { errors: [{ message: "partial" }], data: { p0: { id: product, c0: true } } },
  { errors: null },
  { data: { p0: null } },
  { data: { p0: { id: "gid://shopify/Product/3", c0: true } } },
  { data: { p0: { id: product, c0: "true" } } },
  { data: { p0: { id: product } } },
])("fails closed on incomplete or mismatched response %#", (response) => {
  expect(parse(build([product], [collection])!, response)).toBeNull();
});
