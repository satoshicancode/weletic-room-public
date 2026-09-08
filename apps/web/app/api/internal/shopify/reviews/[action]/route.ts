import { prisma } from "@/lib/prisma";
import { ratelimit } from "@/lib/upstash";
import {
  hashReviewToken,
  REVIEW_MAX_PHOTO_BYTES,
  ReviewError,
} from "@/lib/weletic/reviews/contracts";
import { reviewHttpError, reviewJson } from "@/lib/weletic/reviews/http";
import {
  getPublicReviewPhoto,
  uploadReviewPhoto,
} from "@/lib/weletic/reviews/media";
import { getPublicProductReviews } from "@/lib/weletic/reviews/public";
import { getReviewRequestPreview } from "@/lib/weletic/reviews/requests";
import { submitNativeReview } from "@/lib/weletic/reviews/service";
import {
  readWeleticShopifyRequestBodyBytes,
  verifyWeleticShopifyRequest,
} from "@/lib/weletic/shopify/service-auth";
import { resolveShopifyStoreByDomain } from "@/lib/weletic/shopify/store-resolver";
import { z } from "zod";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ action: string }> };
const tokenSchema = z
  .object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
  .strict();
const photoSchema = tokenSchema.extend({
  contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  base64: z
    .string()
    .max(Math.ceil(REVIEW_MAX_PHOTO_BYTES / 3) * 4)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
});

async function handle(request: Request, context: Context) {
  try {
    const { action } = await context.params;
    const allowed =
      request.method === "GET"
        ? ["list", "photo", "health"]
        : ["request", "submit", "upload"];
    if (!allowed.includes(action))
      throw new ReviewError("not_found", "Review route unavailable");
    const bytes = await readWeleticShopifyRequestBodyBytes(request, {
      maxBytes: action === "upload" ? 3 * 1024 * 1024 : 64 * 1024,
    });
    if (bytes === null)
      return reviewJson(
        {
          error: { code: "bad_request", message: "Request body is too large" },
        },
        413,
      );
    const body = new TextDecoder().decode(bytes);
    if (!verifyWeleticShopifyRequest({ request, body }))
      return reviewJson(
        {
          error: {
            code: "unauthorized",
            message: "Unauthorized service request",
          },
        },
        401,
      );
    const url = new URL(request.url);
    const shop = url.searchParams.get("shop");
    const resolution = shop ? await resolveShopifyStoreByDomain(shop) : null;
    if (!resolution?.storeId)
      throw new ReviewError("not_found", "Store unavailable");
    const storeId = resolution.storeId;
    const store = await prisma.weleticShopifyStore.findFirst({
      where: { id: storeId, complianceState: "active" },
      select: { id: true },
    });
    if (!store) throw new ReviewError("not_found", "Store unavailable");
    if (action === "health") {
      const [settings, failedRequests] = await Promise.all([
        prisma.weleticReviewSettings.findUnique({
          where: { storeId },
          select: { enabled: true, requestEmailEnabled: true },
        }),
        prisma.weleticReviewRequest.count({
          where: { storeId, status: "failed" },
        }),
      ]);
      return reviewJson({
        enabled: settings?.enabled ?? false,
        requestEmailEnabled: settings?.requestEmailEnabled ?? false,
        failedRequests,
      });
    }
    if (action === "list") {
      const query = Object.fromEntries(
        [...url.searchParams].filter(([key]) =>
          ["productId", "sort", "rating", "limit", "cursor"].includes(key),
        ),
      );
      return reviewJson(await getPublicProductReviews(storeId, query));
    }
    if (action === "photo") {
      const mediaId = z
        .string()
        .max(191)
        .regex(/^wrevmedia_[A-Za-z0-9_-]+$/)
        .parse(url.searchParams.get("mediaId"));
      return reviewJson(await getPublicReviewPhoto(storeId, mediaId));
    }
    const input: unknown = JSON.parse(body);
    const { token } = tokenSchema.passthrough().parse(input);
    const limit = await ratelimit(60, "1 h").limit(
      `weletic:reviews:${storeId}:${hashReviewToken(token)}`,
    );
    if (!limit.success)
      return reviewJson(
        {
          error: {
            code: "rate_limited",
            message: "Too many attempts; please try later",
          },
        },
        429,
      );
    if (action === "request")
      return reviewJson(
        await getReviewRequestPreview(storeId, tokenSchema.parse(input).token),
      );
    if (action === "submit")
      return reviewJson(await submitNativeReview(storeId, input), 201);
    const photo = photoSchema.parse(input);
    return reviewJson(
      await uploadReviewPhoto(
        storeId,
        photo.token,
        Buffer.from(photo.base64, "base64"),
        photo.contentType,
      ),
      201,
    );
  } catch (error) {
    return reviewHttpError(error);
  }
}

export const GET = handle;
export const POST = handle;
