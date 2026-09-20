export type ReviewProductQuery = (
  query: string,
  options: {
    variables: { after: string | null };
    version: "2026-07";
  },
) => Promise<unknown>;

const query = `query ReviewProducts($after: String) {
  products(first: 20, after: $after, sortKey: TITLE) {
    nodes { id title }
    pageInfo { hasNextPage endCursor }
  }
}`;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("unavailable");
  return value as Record<string, unknown>;
}

/** Public catalog only. Product selection confers no purchase or review authority. */
export async function reviewProducts(
  queryProducts: ReviewProductQuery,
  after: string | null,
) {
  if (after !== null && (!after || after.length > 2048))
    throw new Error("unavailable");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = record(
      await Promise.race([
        queryProducts(query, { variables: { after }, version: "2026-07" }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("unavailable")), 10_000);
        }),
      ]),
    );
    if (
      response.errors !== undefined &&
      (!Array.isArray(response.errors) || response.errors.length)
    )
      throw new Error("unavailable");
    const products = record(record(response.data).products);
    if (!Array.isArray(products.nodes) || products.nodes.length > 20)
      throw new Error("unavailable");
    const nodes = products.nodes.map((node) => {
      const product = record(node);
      if (
        typeof product.id !== "string" ||
        !/^gid:\/\/shopify\/Product\/[1-9][0-9]{0,19}$/.test(product.id) ||
        typeof product.title !== "string" ||
        !product.title.trim() ||
        product.title.length > 512
      )
        throw new Error("unavailable");
      return { id: product.id, title: product.title };
    });
    if (new Set(nodes.map((node) => node.id)).size !== nodes.length)
      throw new Error("unavailable");
    const page = record(products.pageInfo);
    if (typeof page.hasNextPage !== "boolean") throw new Error("unavailable");
    if (
      page.hasNextPage &&
      (typeof page.endCursor !== "string" ||
        !page.endCursor ||
        page.endCursor.length > 2048 ||
        page.endCursor === after ||
        nodes.length === 0)
    )
      throw new Error("unavailable");
    return {
      nodes,
      next: page.hasNextPage ? (page.endCursor as string) : null,
    };
  } finally {
    clearTimeout(timer);
  }
}
