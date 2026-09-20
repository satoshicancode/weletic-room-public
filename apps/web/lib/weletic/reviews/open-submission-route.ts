import { prisma } from "@/lib/prisma";
import { ratelimit } from "@/lib/upstash";
import {
  readWeleticShopifyRequestBodyBytes,
  verifyWeleticShopifyRequest,
} from "@/lib/weletic/shopify/service-auth";
import type { Prisma } from "@prisma/client";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { REVIEW_MAX_PHOTO_BYTES, ReviewError } from "./contracts";
import { reviewHttpError, reviewJson } from "./http";
import { requireReviewStorage } from "./media";
import { openReviewPhotoSchema } from "./open-media-contract";
import { InvalidOpenReviewPhoto } from "./open-media-errors";
import { uploadOpenReviewPhoto } from "./open-media-upload";
import { readCurrentOpenReviewPolicy } from "./open-policy-history";
import {
  OPEN_REVIEW_DISCLOSURE_REVISION,
  openReviewSubmissionSchema,
} from "./open-submission-contract";
import { readOpenReviewCustomer } from "./open-submission-customer";
import { submitOpenReview } from "./open-submission-write";
import { withReviewMutation } from "./transaction";

const contextSchema = z
  .object({
    shop: z.string().regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/),
    customerId: z.string().regex(/^[1-9][0-9]{0,19}$/),
    source: z.enum(["app_proxy", "customer_account"]),
  })
  .strict();

function authorBinding(shop: string, customerId: string, generation: string) {
  return createHmac("sha256", process.env.WELETIC_SHOPIFY_SERVICE_SECRET!)
    .update(
      JSON.stringify([
        "weletic:open-review-author:v1",
        shop,
        customerId,
        generation,
      ]),
    )
    .digest("hex");
}

/** Only authenticated Shopify App Proxy/customer-account gateways construct this
 * signed context. Shopper content cannot override identity or source.
 */
export async function openReviewSubmissionRoute(
  request: Request,
  operation: "submit" | "prepare" | "upload" = "submit",
) {
  try {
    if (request.method !== "POST")
      return reviewJson({ error: { code: "method_not_allowed" } }, 405);
    const bytes = await readWeleticShopifyRequestBodyBytes(request, {
      maxBytes: operation === "upload" ? 3 * 1024 * 1024 : 64 * 1024,
    });
    if (bytes === null)
      return reviewJson({ error: { code: "bad_request" } }, 413);
    const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!verifyWeleticShopifyRequest({ request, body }))
      return reviewJson({ error: { code: "unauthorized" } }, 401);
    const url = new URL(request.url);
    if (
      [...url.searchParams.keys()].some(
        (key) => url.searchParams.getAll(key).length !== 1,
      )
    )
      throw new ReviewError("bad_request", "Invalid review context");
    const context = contextSchema.parse(Object.fromEntries(url.searchParams));
    const raw: unknown = JSON.parse(body);
    const photo =
      operation === "upload"
        ? openReviewPhotoSchema
            .safeExtend({
              authorBinding: z.string().regex(/^[a-f0-9]{64}$/),
              base64: z
                .string()
                .min(4)
                .max(Math.ceil(REVIEW_MAX_PHOTO_BYTES / 3) * 4),
            })
            .parse(raw)
        : null;
    const prepared =
      operation === "prepare"
        ? z
            .object({
              productId: z
                .string()
                .regex(/^gid:\/\/shopify\/Product\/[1-9][0-9]{0,19}$/),
            })
            .strict()
            .parse(raw)
        : null;
    const submitted =
      operation === "submit"
        ? openReviewSubmissionSchema
            .safeExtend({ authorBinding: z.string().regex(/^[a-f0-9]{64}$/) })
            .parse(raw)
        : null;
    const input = submitted
      ? openReviewSubmissionSchema.parse(
          Object.fromEntries(
            Object.entries(submitted).filter(
              ([key]) => key !== "authorBinding",
            ),
          ),
        )
      : null;
    const store = await prisma.weleticShopifyStore.findUnique({
      where: { shopDomain: context.shop },
      select: { id: true, installationGeneration: true },
    });
    if (!store) throw new ReviewError("not_found", "Store unavailable");
    const generation =
      photo?.expectedInstallationGeneration ??
      input?.expectedInstallationGeneration ??
      store.installationGeneration;
    if (!generation)
      throw new ReviewError("unavailable", "Installation unavailable");
    const binding = authorBinding(context.shop, context.customerId, generation);
    if (
      (photo || submitted) &&
      !timingSafeEqual(
        Buffer.from((photo || submitted)!.authorBinding),
        Buffer.from(binding),
      )
    )
      throw new ReviewError("conflict", "Review session changed");
    // Cheap fenced policy check before any protected Shopify customer-data read.
    // The writer repeats it after external I/O; this is not write authorization.
    const currentPolicy = await withReviewMutation(
      store.id,
      async (tx) => {
        let photoUploadsAvailable = false;
        let productTitle: string | null = null;
        const policy = await readCurrentOpenReviewPolicy(tx, store.id);
        if (
          !policy.policy.enabled ||
          policy.installationGeneration !== generation
        )
          throw new ReviewError("disabled", "Open reviews are unavailable");
        if (prepared) {
          const current = await tx.weleticShopifyStore.findUnique({
            where: { id: store.id },
            select: { shopDomain: true },
          });
          if (current?.shopDomain !== context.shop)
            throw new ReviewError("conflict", "Installation changed");
          const settings = await tx.$queryRaw<
            Array<{
              enabled: boolean | number;
              photoUploadsEnabled: boolean | number;
            }>
          >`SELECT enabled, photoUploadsEnabled FROM WeleticReviewSettings WHERE storeId = ${store.id} FOR UPDATE`;
          if (settings.length !== 1 || ![true, 1].includes(settings[0].enabled))
            throw new ReviewError("disabled", "Reviews are unavailable");
          const products = await tx.$queryRaw<
            Array<{ id: string; title: string }>
          >`SELECT id, title FROM WeleticShopifyProduct WHERE storeId = ${store.id} AND externalId = ${prepared.productId} AND status = 'active' LIMIT 1 FOR UPDATE`;
          if (!products.length)
            throw new ReviewError("not_found", "Product unavailable");
          productTitle = products[0].title;
          if (
            policy.policy.photoUploadsEnabled &&
            [true, 1].includes(settings[0].photoUploadsEnabled)
          ) {
            try {
              requireReviewStorage();
              photoUploadsAvailable = true;
            } catch {
              // An unconfigured private provider must not expose an upload UI.
            }
          }
        }
        return { ...policy, photoUploadsAvailable, productTitle };
      },
      generation,
    );
    const limit = await ratelimit(60, "1 h").limit(
      `weletic:reviews:open:${createHash("sha256")
        .update(JSON.stringify([store.id, context.customerId]))
        .digest("hex")}`,
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
    if (prepared)
      return reviewJson({
        productId: prepared.productId,
        productTitle: currentPolicy.productTitle,
        expectedInstallationGeneration: generation,
        expectedSettingsRevision: currentPolicy.revision,
        authorBinding: binding,
        disclosureRevision: OPEN_REVIEW_DISCLOSURE_REVISION,
        verifiedPurchase: false,
        incentivized: false,
        photoUploadsAvailable: currentPolicy.photoUploadsAvailable,
      });
    if (!input && !photo)
      throw new ReviewError("bad_request", "Invalid review input");
    let photoBytes: Buffer | undefined;
    if (photo) {
      photoBytes = Buffer.from(photo.base64, "base64");
      // Buffer decoding is permissive: require canonical standard base64 and
      // enforce decoded size before protected customer reads or image decoding.
      if (
        !photoBytes.length ||
        photoBytes.length > REVIEW_MAX_PHOTO_BYTES ||
        photoBytes.toString("base64") !== photo.base64
      )
        throw new ReviewError("bad_request", "Invalid photo encoding");
    }
    const customer = await readOpenReviewCustomer({
      storeId: store.id,
      installationGeneration: generation,
      shopifyCustomerId: context.customerId,
    });
    const command = {
      storeId: store.id,
      installationGeneration: generation,
      authorize: async (tx: Prisma.TransactionClient) => {
        // The writer already holds the operational generation lock. Rebind the
        // exact signed domain within that transaction, never a mutable alias.
        const current = await tx.weleticShopifyStore.findUnique({
          where: { id: store.id },
          select: { shopDomain: true, installationGeneration: true },
        });
        if (
          current?.shopDomain !== context.shop ||
          current.installationGeneration !== generation
        )
          throw new ReviewError("conflict", "Installation changed");
        return { ...customer, source: context.source };
      },
    };
    if (photo && photoBytes) {
      const metadata = openReviewPhotoSchema.strip().parse(photo);
      const result = await uploadOpenReviewPhoto({
        ...command,
        input: metadata,
        bytes: photoBytes,
      });
      return reviewJson({ id: result.id });
    }
    const result = await submitOpenReview({ ...command, input });
    return reviewJson(result, result.duplicate ? 200 : 201);
  } catch (error) {
    if (operation === "upload" && error instanceof InvalidOpenReviewPhoto)
      return reviewJson(
        {
          error: {
            code: "invalid_open_photo",
            message: "Photo could not be validated",
          },
        },
        400,
      );
    return reviewHttpError(error);
  }
}
