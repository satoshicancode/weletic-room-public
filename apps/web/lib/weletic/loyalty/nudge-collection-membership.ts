/** Pure query boundary; callers must authorize the store and derive collection
 * IDs from its reward terms. This module does not authenticate or fetch. */
export function buildNudgeCollectionMembershipQuery(
  productIds: readonly string[],
  collectionIds: readonly string[],
) {
  // Bound input before deduplication, as well as the resulting GraphQL cost.
  if (
    productIds.length === 0 ||
    collectionIds.length === 0 ||
    productIds.length > 50 ||
    collectionIds.length > 20 ||
    productIds.some(
      (id) => !/^gid:\/\/shopify\/Product\/[1-9]\d{0,19}$/.test(id),
    ) ||
    collectionIds.some(
      (id) => !/^gid:\/\/shopify\/Collection\/[1-9]\d{0,19}$/.test(id),
    )
  )
    return null;
  const products = [...new Set(productIds)];
  const collections = [...new Set(collectionIds)];
  if (products.length * collections.length > 100) return null;
  const variables: Record<string, string> = {};
  products.forEach((id, i) => {
    variables[`p${i}`] = id;
  });
  collections.forEach((id, i) => {
    variables[`c${i}`] = id;
  });
  const declarations = Object.keys(variables)
    .map((key) => `$${key}: ID!`)
    .join(", ");
  const fields = collections
    .map((_, i) => `c${i}: inCollection(id: $c${i})`)
    .join(" ");
  const query = `query WeleticNudgeMembership(${declarations}) { ${products.map((_, i) => `p${i}: product(id: $p${i}) { id ${fields} }`).join(" ")} }`;
  return { query, variables, products, collections };
}

type MembershipQuery = NonNullable<
  ReturnType<typeof buildNudgeCollectionMembershipQuery>
>;

/** Reject the entire read on partial errors, missing products or coercible
 * booleans. An unknown result must never be treated as verified membership. */
export function parseNudgeCollectionMembership(
  request: MembershipQuery,
  response: unknown,
): Record<string, string[]> | null {
  if (!response || typeof response !== "object" || Array.isArray(response))
    return null;
  const envelope = response as Record<string, unknown>;
  if (
    envelope.errors !== undefined &&
    (!Array.isArray(envelope.errors) || envelope.errors.length !== 0)
  )
    return null;
  if (
    !envelope.data ||
    typeof envelope.data !== "object" ||
    Array.isArray(envelope.data)
  )
    return null;
  const data = envelope.data as Record<string, unknown>;
  const memberships: Record<string, string[]> = {};
  for (const [index, productId] of request.products.entries()) {
    const raw = data[`p${index}`];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const product = raw as Record<string, unknown>;
    if (product.id !== productId) return null;
    const matching: string[] = [];
    for (const [
      collectionIndex,
      collectionId,
    ] of request.collections.entries()) {
      const value = product[`c${collectionIndex}`];
      if (typeof value !== "boolean") return null;
      if (value) matching.push(collectionId);
    }
    memberships[productId] = matching;
  }
  return memberships;
}
