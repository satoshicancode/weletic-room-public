import { createWeleticId } from "@/lib/weletic/ids";
import {
  canonicalizeShopifyCustomerEmail,
  canonicalizeShopifyCustomerId,
  deriveAllShopifyCustomerPrivacyIdentities,
} from "@/lib/weletic/shopify/privacy-identity";
import { assertShopifyStoreAcceptsOperationalWrites } from "@/lib/weletic/shopify/store-compliance-state";
import { Prisma } from "@prisma/client";
import { ReviewError } from "./contracts";
import {
  replaceReviewOwnerPrivacyProjection,
  ReviewOwnerPrivacySuppressedError,
} from "./privacy-owner-write";

/** Internal primitive, NOT authentication. The caller must verify Shopify
 * identity and open-policy authority before entering this same transaction.
 * Email is an explicit trusted Shopify value (null means known absent, not a
 * failed/permission-denied fetch). Never pass shopper-supplied JSON here.
 * Creates identity/coverage only: no enrollment, consent update or rewards.
 */
export async function ensureOpenReviewAuthorInTransaction({
  tx,
  storeId,
  installationGeneration,
  customer,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  installationGeneration: string;
  customer: { shopifyCustomerId: string; email: string | null };
}) {
  if (!storeId || !installationGeneration || installationGeneration.length > 64)
    throw new ReviewError("unavailable", "Review identity unavailable");
  const customerId = canonicalizeShopifyCustomerId(customer.shopifyCustomerId);
  if (!/^[1-9][0-9]{0,19}$/.test(customerId))
    throw new ReviewError("not_found", "Review identity unavailable");
  // Undefined must not become a silent absence when a trusted fetch failed.
  if (customer.email !== null && typeof customer.email !== "string")
    throw new ReviewError("unavailable", "Review identity unavailable");
  const email =
    customer.email === null
      ? null
      : canonicalizeShopifyCustomerEmail(customer.email);
  await assertShopifyStoreAcceptsOperationalWrites({
    tx,
    storeId,
    action: "open_review_author",
    expectedInstallationGeneration: installationGeneration,
  });
  const settings = await tx.$queryRaw<Array<{ enabled: boolean | number }>>`
    SELECT enabled FROM WeleticReviewSettings WHERE storeId = ${storeId} FOR UPDATE
  `;
  if (settings.length !== 1 || ![true, 1].includes(settings[0].enabled))
    throw new ReviewError("disabled", "Reviews are unavailable");
  const identities = deriveAllShopifyCustomerPrivacyIdentities({
    storeId,
    shopifyCustomerId: customerId,
    email,
  });
  if (!identities.length)
    throw new ReviewError("unavailable", "Review privacy identity unavailable");
  const identityMatch = Prisma.join(
    identities.map(
      (identity) => Prisma.sql`
    (identityKind = ${identity.identityKind} AND identityKeyId = ${identity.identityKeyId}
      AND customerDigest = ${identity.customerDigest})
  `,
    ),
    " OR ",
  );
  // No expiresAt condition: retained suppression is authoritative until its
  // retention workflow removes it. This current read shares the store lock.
  const suppressed = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM WeleticShopifyCustomerPrivacyTombstone
    WHERE storeId = ${storeId} AND (${identityMatch}) LIMIT 1 FOR UPDATE
  `);
  if (suppressed.length)
    throw new ReviewError("not_found", "Review identity unavailable");
  const gid = `gid://shopify/Customer/${customerId}`;
  const existing = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM WeleticShopper WHERE storeId = ${storeId}
      AND shopifyCustomerId IN (${customerId}, ${gid})
    ORDER BY id ASC LIMIT 2 FOR UPDATE
  `;
  if (existing.length > 1)
    throw new ReviewError(
      "unavailable",
      "Review identity requires reconciliation",
    );
  let shopperId = existing[0]?.id;
  if (!shopperId) {
    const created = await tx.weleticShopper.create({
      data: {
        id: createWeleticId("wshop_"),
        storeId,
        shopifyCustomerId: customerId,
        email,
      },
      select: { id: true },
    });
    shopperId = created.id;
  }
  // Existing profile/consent remains untouched. Persisted and retained old-email
  // proofs are checked by this helper before updating coverage. A failure rolls
  // back a newly created profile together with the caller's review transaction.
  try {
    await replaceReviewOwnerPrivacyProjection({
      tx,
      storeId,
      shopperId,
      installationGeneration,
    });
  } catch (error) {
    if (error instanceof ReviewOwnerPrivacySuppressedError)
      throw new ReviewError("not_found", "Review identity unavailable");
    throw error;
  }
  return { shopperId };
}
