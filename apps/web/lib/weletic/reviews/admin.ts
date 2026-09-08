import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { ReviewError } from "./contracts";

const querySchema = z.object({
  view: z.enum(["reviews", "requests"]).default("reviews"),
  status: z.string().optional(),
  rating: z.coerce.number().int().min(1).max(5).optional(),
  cursor: z.string().max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
const reviewStatus = z.enum([
  "pending",
  "published",
  "hidden",
  "rejected",
  "redacted",
]);
const requestStatus = z.enum([
  "queued",
  "sending",
  "sent",
  "submitted",
  "expired",
  "cancelled",
  "failed",
]);
const cursorSchema = z
  .object({
    storeId: z.string(),
    view: z.string(),
    status: z.string(),
    rating: z.number().nullable(),
    createdAt: z.string().datetime(),
    id: z.string().max(191),
  })
  .strict();

export async function listAdminReviews(
  storeId: string,
  input: unknown,
  database:
    | Pick<
        Prisma.TransactionClient,
        | "weleticProductReview"
        | "weleticReviewRequest"
        | "weleticReviewIncentiveClaim"
      >
    | Pick<
        typeof prisma,
        | "weleticProductReview"
        | "weleticReviewRequest"
        | "weleticReviewIncentiveClaim"
      > = prisma,
) {
  const query = querySchema.parse(input);
  let chronology: {
    OR?: Array<{ createdAt: Date | { lt: Date }; id?: { lt: string } }>;
  } = {};
  if (query.cursor) {
    try {
      const cursor = cursorSchema.parse(
        JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")),
      );
      if (
        cursor.storeId !== storeId ||
        cursor.view !== query.view ||
        cursor.status !== (query.status ?? "") ||
        cursor.rating !== (query.rating ?? null)
      )
        throw new Error("Scope mismatch");
      chronology = {
        OR: [
          { createdAt: { lt: new Date(cursor.createdAt) } },
          { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
        ],
      };
    } catch {
      throw new ReviewError("bad_request", "Invalid review cursor");
    }
  }
  const pagination = {
    take: query.limit + 1,
    orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }],
  };
  // The cursor contributes only the structurally identical id/time predicate.
  const after = chronology.OR
    ? {
        OR: chronology.OR.map((row) => ({
          createdAt: row.createdAt,
          id: row.id,
        })),
      }
    : {};
  const rows =
    query.view === "reviews"
      ? await database.weleticProductReview.findMany({
          where: {
            storeId,
            product: { storeId },
            ...after,
            ...(query.status
              ? { status: reviewStatus.parse(query.status) }
              : {}),
            ...(query.rating ? { rating: query.rating } : {}),
          },
          ...pagination,
          select: {
            id: true,
            version: true,
            createdAt: true,
            status: true,
            rating: true,
            title: true,
            body: true,
            displayName: true,
            merchantReply: true,
            verifiedPurchase: true,
            incentivized: true,
            rewardStatus: true,
            rewardReason: true,
            shopperId: true,
            participationStatus: true,
            request: { select: { incentivePolicyId: true, orderId: true } },
            product: { select: { title: true, externalId: true } },
            media: {
              where: { storeId, status: "uploaded" },
              select: { id: true },
            },
          },
        })
      : await database.weleticReviewRequest.findMany({
          where: {
            storeId,
            product: { storeId },
            ...after,
            ...(query.status
              ? { status: requestStatus.parse(query.status) }
              : {}),
          },
          ...pagination,
          select: {
            id: true,
            createdAt: true,
            status: true,
            sendAt: true,
            expiresAt: true,
            sentAt: true,
            submittedAt: true,
            deliveryAttempts: true,
            lastError: true,
            cancellationReason: true,
            product: { select: { title: true, externalId: true } },
          },
        });
  const pageItems = rows.slice(0, query.limit);
  const versionedOrderIds = pageItems.flatMap((row) =>
    "rewardStatus" in row && row.request.incentivePolicyId !== null
      ? [row.request.orderId]
      : [],
  );
  const claims = versionedOrderIds.length
    ? await database.weleticReviewIncentiveClaim.findMany({
        where: { storeId, orderId: { in: [...new Set(versionedOrderIds)] } },
        select: {
          orderId: true,
          sourceReviewId: true,
          shopperId: true,
          policyId: true,
          status: true,
          awardSnapshot: true,
        },
      })
    : [];
  const items = pageItems.map((row) => {
    if (!("rewardStatus" in row)) return row;
    const { request, shopperId, participationStatus, ...item } = row;
    const legacy = request.incentivePolicyId === null;
    const claim = claims.find(
      (claim) =>
        claim.orderId === request.orderId &&
        claim.sourceReviewId === row.id &&
        claim.shopperId === shopperId &&
        claim.policyId === request.incentivePolicyId,
    );
    const award = claim?.awardSnapshot;
    const pendingPoints =
      claim?.status === "reserved" &&
      participationStatus === "validated" &&
      award &&
      typeof award === "object" &&
      !Array.isArray(award) &&
      award.kind === "points";
    return {
      ...item,
      rewardPolicy: legacy ? ("legacy" as const) : ("participation" as const),
      canRetryReward:
        item.status !== "redacted" &&
        item.rewardStatus === "pending" &&
        (legacy ? item.status === "published" : Boolean(pendingPoints)),
    };
  });
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > query.limit && last
        ? Buffer.from(
            JSON.stringify({
              storeId,
              view: query.view,
              status: query.status ?? "",
              rating: query.rating ?? null,
              createdAt: last.createdAt.toISOString(),
              id: last.id,
            }),
          ).toString("base64url")
        : null,
  };
}
