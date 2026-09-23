import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import * as z from "zod/v4";
import { ReviewError } from "../reviews/contracts";
import { buildStoreReviewMerchantPrivacySql } from "../reviews/privacy-public-sql";
import {
  storeMerchantListInputSchema,
  storeMerchantListResponseSchema,
} from "../reviews/store-merchant-contract";
import { moderateStoreReviewWithAuditInTransaction } from "../reviews/store-service";
import { withReviewMutation } from "../reviews/transaction";
import { authorizeShopifyMerchantInTransaction } from "./staff-authorization";
import { shopifyMerchantActorEnvelopeSchema } from "./staff-contract";

const cursorSchema = z
  .object({
    scope: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.string().datetime(),
    id: z.string().min(1).max(191),
  })
  .strict();

/** The signed caller supplies the actor envelope; this service derives store
 * authority from its committed staff authorization receipt. */
export async function listShopifyMerchantStoreReviewsInTransaction({
  tx,
  envelope,
  input,
}: {
  tx: Prisma.TransactionClient;
  envelope: unknown;
  input: unknown;
}) {
  const query = storeMerchantListInputSchema.parse(input);
  const actor = await authorizeShopifyMerchantInTransaction({
    tx,
    envelope,
    permission: "reviews.read",
  });
  const scope = createHash("sha256")
    .update(
      JSON.stringify([
        "store-review-merchant-v1",
        actor.storeId,
        actor.appId,
        actor.installationGeneration,
        query.status ?? null,
        query.rating ?? null,
      ]),
    )
    .digest("hex");
  let after = Prisma.sql`1 = 1`;
  if (query.cursor) {
    try {
      const bytes = Buffer.from(query.cursor, "base64url");
      if (bytes.toString("base64url") !== query.cursor) throw new Error();
      const cursor = cursorSchema.parse(JSON.parse(bytes.toString("utf8")));
      if (cursor.scope !== scope) throw new Error();
      const date = new Date(cursor.createdAt);
      after = Prisma.sql`(r.createdAt < ${date} OR (r.createdAt = ${date} AND r.id < ${cursor.id}))`;
    } catch {
      throw new ReviewError("bad_request", "Invalid store review cursor");
    }
  }
  const [module, settings] = await Promise.all([
    tx.weleticReviewSettings.findUnique({
      where: { storeId: actor.storeId },
      select: { enabled: true },
    }),
    tx.weleticStoreReviewSettings.findUnique({
      where: { storeId: actor.storeId },
      select: { enabled: true },
    }),
  ]);
  const enabled = Boolean(module?.enabled && settings?.enabled);
  const privacy = buildStoreReviewMerchantPrivacySql({
    storeId: actor.storeId,
    installationGeneration: actor.installationGeneration,
  });
  const unknown = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT r.id FROM ${privacy.from} WHERE ${privacy.unknown} LIMIT 1`);
  if (unknown.length)
    throw new ReviewError("unavailable", "Store reviews unavailable");
  const rows = await tx.$queryRaw<
    Array<{
      id: string;
      version: number;
      status: string;
      rating: number;
      title: string;
      body: string;
      displayName: string;
      merchantReply: string | null;
      source: string;
      requestId: string | null;
      verifiedPurchase: boolean | number;
      incentivized: boolean | number;
      createdAt: Date;
    }>
  >(Prisma.sql`
    SELECT r.id, r.version, r.status, r.rating, r.title, r.body, r.displayName,
      r.merchantReply, r.source, r.requestId, r.verifiedPurchase,
      r.incentivized, r.createdAt
    FROM ${privacy.from} WHERE ${privacy.eligible} AND ${after}
      AND r.source = 'invitation'
      AND ${query.status ? Prisma.sql`r.status = ${query.status}` : Prisma.sql`1 = 1`}
      AND ${query.rating ? Prisma.sql`r.rating = ${query.rating}` : Prisma.sql`1 = 1`}
    ORDER BY r.createdAt DESC, r.id DESC LIMIT ${query.limit + 1}`);
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return storeMerchantListResponseSchema.parse({
    enabled,
    items: page.map((row) => ({
      id: row.id,
      version: row.version,
      status: row.status,
      rating: row.rating,
      title: row.title,
      body: row.body,
      displayName: row.displayName,
      merchantReply: row.merchantReply,
      verifiedPurchase:
        row.source === "invitation" &&
        row.requestId !== null &&
        !!row.verifiedPurchase,
      incentivized:
        row.source === "invitation" &&
        row.requestId !== null &&
        !!row.incentivized,
      createdAt: row.createdAt.toISOString(),
      canModerate: enabled && row.source === "invitation" && !!row.requestId,
    })),
    nextCursor:
      rows.length > query.limit && last
        ? Buffer.from(
            JSON.stringify({
              scope,
              createdAt: last.createdAt.toISOString(),
              id: last.id,
            }),
          ).toString("base64url")
        : null,
  });
}

export async function moderateShopifyMerchantStoreReview({
  envelope,
  input,
}: {
  envelope: unknown;
  input: unknown;
}) {
  const actorEnvelope = shopifyMerchantActorEnvelopeSchema.parse(envelope);
  return withReviewMutation(
    actorEnvelope.storeId,
    async (tx, generation) => {
      const actor = await authorizeShopifyMerchantInTransaction({
        tx,
        envelope: actorEnvelope,
        permission: "reviews.moderate",
      });
      return moderateStoreReviewWithAuditInTransaction({
        tx,
        storeId: actor.storeId,
        generation: actor.installationGeneration,
        input,
        actor: {
          kind: "shopify",
          userId: actor.shopifyUserId,
          appId: actor.appId,
          installationGeneration: actor.installationGeneration,
          merchantActionId: actor.actionId,
        },
      });
    },
    actorEnvelope.installationGeneration,
  );
}
