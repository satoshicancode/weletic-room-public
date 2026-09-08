import { prisma } from "@/lib/prisma";
import { hasShopifyCustomerRedactionTombstone } from "@/lib/weletic/loyalty/shopper-privacy";
import {
  deriveAllShopifyCustomerPrivacyIdentities,
  SHOPIFY_CUSTOMER_PRIVACY_PSEUDONYM_PATTERN,
} from "@/lib/weletic/shopify/privacy-identity";
import type { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { z } from "zod";
import { shopperDirectoryQuerySchema } from "./directory-query";
import { ShopperProfileError } from "./profile-query";
import { shopperSegmentWhere } from "./segment-filter";
import { hasShopperSegment, shopperSegmentSchema } from "./segment-query";

const cursorSchema = z
  .object({
    v: z.union([z.literal(1), z.literal(2)]),
    storeId: z.string(),
    generation: z.string(),
    searchHash: z.string(),
    createdAt: z.string().datetime(),
    id: z.string().min(1).max(191),
  })
  .strict();
type Identity = ReturnType<
  typeof deriveAllShopifyCustomerPrivacyIdentities
>[number];
const identityKey = (identity: Identity) =>
  `${identity.identityKind}:${identity.identityKeyId}:${identity.customerDigest}`;

/** Scan bounded shopper pages, not account pages. Privacy filtering occurs
 * before serialization; continuation advances over scanned rows even if an
 * entire page is suppressed. Never expose a count of redacted matches.
 * Authenticated gateways can supply their authorization transaction; this
 * read primitive does not authenticate the workspace or caller itself.
 */
export async function listMerchantShoppers(
  workspaceId: string,
  input: unknown,
  transaction?: Prisma.TransactionClient,
) {
  const query = shopperDirectoryQuerySchema.parse(input);
  const segment = shopperSegmentSchema.parse(input);
  const read = async (tx: Prisma.TransactionClient) => {
    const store = await tx.weleticShopifyStore.findFirst({
      where: {
        projectId: workspaceId,
        complianceState: "active",
        installationGeneration: { not: null },
      },
      select: { id: true, installationGeneration: true },
    });
    if (!store?.installationGeneration)
      throw new ShopperProfileError("not_found");
    const scope = {
      storeId: store.id,
      generation: store.installationGeneration,
      searchHash: createHash("sha256")
        .update(JSON.stringify([query.search, segment]))
        .digest("hex"),
    };
    let after: {
      OR?: Array<{ createdAt: Date | { lt: Date }; id?: { lt: string } }>;
    } = {};
    if (query.cursor) {
      try {
        if (!/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error();
        const cursor = cursorSchema.parse(
          JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")),
        );
        if (
          cursor.storeId !== scope.storeId ||
          cursor.generation !== scope.generation ||
          (cursor.v === 1
            ? hasShopperSegment(segment) ||
              cursor.searchHash !==
                createHash("sha256").update(query.search).digest("hex")
            : cursor.searchHash !== scope.searchHash)
        )
          throw new Error();
        after = {
          OR: [
            { createdAt: { lt: new Date(cursor.createdAt) } },
            { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
          ],
        };
      } catch {
        throw new ShopperProfileError("bad_request");
      }
    }
    const raw = await tx.weleticShopper.findMany({
      where: {
        storeId: store.id,
        AND: [
          after,
          shopperSegmentWhere(store.id, segment),
          ...(query.search
            ? [
                {
                  OR: [
                    { firstName: { contains: query.search } },
                    { lastName: { contains: query.search } },
                    { email: { contains: query.search } },
                    { shopifyCustomerId: { equals: query.search } },
                  ],
                },
              ]
            : []),
        ],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      select: {
        id: true,
        shopifyCustomerId: true,
        firstName: true,
        lastName: true,
        email: true,
        createdAt: true,
      },
    });
    const scanned = raw.slice(0, query.limit);
    const candidates = scanned.filter(
      (row) =>
        !SHOPIFY_CUSTOMER_PRIVACY_PSEUDONYM_PATTERN.test(row.shopifyCustomerId),
    );
    const identities = new Map(
      candidates.map((row) => [
        row.id,
        deriveAllShopifyCustomerPrivacyIdentities({
          storeId: store.id,
          shopifyCustomerId: row.shopifyCustomerId,
          email: row.email,
        }),
      ]),
    );
    const accounts = candidates.length
      ? await tx.weleticLoyaltyAccount.findMany({
          where: {
            storeId: store.id,
            shopperId: { in: candidates.map((row) => row.id) },
          },
          select: { id: true, shopperId: true, status: true, metadata: true },
        })
      : [];
    const accountsByShopper = new Map(
      accounts.map((row) => [row.shopperId, row]),
    );
    const now = new Date();
    // Owner links retain suppression even after identity expiry. Group them
    // before returning results: historical rows per owner are not bounded.
    const shopperOwners = candidates.length
      ? await tx.weleticShopifyCustomerPrivacyTombstone.groupBy({
          by: ["shopperId"],
          where: {
            storeId: store.id,
            shopperId: { in: candidates.map((row) => row.id) },
          },
        })
      : [];
    const accountOwners = accounts.length
      ? await tx.weleticShopifyCustomerPrivacyTombstone.groupBy({
          by: ["accountId"],
          where: {
            storeId: store.id,
            accountId: { in: accounts.map((row) => row.id) },
          },
        })
      : [];
    // The store/identity composite unique key bounds this separate lookup.
    const tombstones = candidates.length
      ? await tx.weleticShopifyCustomerPrivacyTombstone.findMany({
          where: {
            storeId: store.id,
            expiresAt: { gt: now },
            OR: [...identities.values()].flat(),
          },
          select: {
            identityKind: true,
            identityKeyId: true,
            customerDigest: true,
          },
        })
      : [];
    const blockedShoppers = new Set(shopperOwners.map((row) => row.shopperId));
    const blockedAccounts = new Set(accountOwners.map((row) => row.accountId));
    const blockedIdentities = new Set(tombstones.map(identityKey));
    const items = candidates
      .filter((row) => {
        const account = accountsByShopper.get(row.id);
        return (
          !blockedShoppers.has(row.id) &&
          !(account && blockedAccounts.has(account.id)) &&
          !hasShopifyCustomerRedactionTombstone(account?.metadata) &&
          !identities
            .get(row.id)
            ?.some((identity) => blockedIdentities.has(identityKey(identity)))
        );
      })
      .map((row) => {
        const account = accountsByShopper.get(row.id);
        return {
          ...row,
          createdAt: row.createdAt.toISOString(),
          loyalty: account
            ? { accountId: account.id, status: account.status }
            : null,
        };
      });
    const last = scanned.at(-1);
    const hasMore = raw.length > query.limit;
    return {
      items,
      pagination: {
        limit: query.limit,
        hasMore,
        nextCursor:
          hasMore && last
            ? Buffer.from(
                JSON.stringify({
                  v: 2,
                  ...scope,
                  createdAt: last.createdAt.toISOString(),
                  id: last.id,
                }),
              ).toString("base64url")
            : null,
      },
    };
  };
  return transaction ? read(transaction) : prisma.$transaction(read);
}

export type MerchantShopperDirectory = Awaited<
  ReturnType<typeof listMerchantShoppers>
>;
