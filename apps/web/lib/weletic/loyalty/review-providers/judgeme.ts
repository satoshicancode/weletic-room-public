import { decrypt, encrypt } from "@/lib/encryption";
import { prisma } from "@/lib/prisma";
import { createWeleticId } from "@/lib/weletic/ids";
import { withActiveStoreLoyaltyMutation } from "@/lib/weletic/loyalty/merchant-write-fence";
import {
  awardVerifiedReviewPoints,
  reverseReviewPoints,
} from "@/lib/weletic/loyalty/review-rewards";
import { APP_DOMAIN_WITH_NGROK } from "@dub/utils";
import { Prisma } from "@prisma/client";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const JUDGEME_PROVIDER = "judgeme";
export const JUDGEME_WEBHOOK_SIGNATURE_HEADER = "judgeme-hmac-sha256";
const JUDGEME_API_ORIGIN = "https://api.judge.me";
const JUDGEME_VERIFIED_STATUSES = new Set([
  "confirmed-buyer",
  "buyer",
  "verified-purchase",
  "semi-verified-purchase",
  "admin",
]);
const JUDGEME_WEBHOOK_KEYS = ["review/created", "review/updated"] as const;
const JUDGEME_REQUEST_TIMEOUT_MS = 8_000;

const judgeMeReviewSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    email: z.string().email().optional(),
    body: z.string().nullish(),
    rating: z.coerce.number().int().min(1).max(5),
    product_external_id: z.union([z.string(), z.number()]).nullish(),
    verified: z.string(),
    published: z.boolean().optional().default(true),
    hidden: z.boolean().optional().default(false),
    curated: z.string().nullish(),
    deleted_at: z.string().nullish(),
    has_published_pictures: z.boolean().optional().default(false),
    has_published_videos: z.boolean().optional().default(false),
    reviewer: z
      .object({ email: z.string().email().optional() })
      .passthrough()
      .nullish(),
  })
  .passthrough();

export type JudgeMeReview = z.input<typeof judgeMeReviewSchema>;

function getIneligibleJudgeMeReviewReason(review: JudgeMeReview) {
  if (review.deleted_at) return "review_deleted";
  if (review.hidden || review.published === false) return "review_unpublished";
  if (
    review.curated &&
    !["ok", "approved", "published"].includes(review.curated.toLowerCase())
  ) {
    return "review_moderated";
  }
  if (!JUDGEME_VERIFIED_STATUSES.has(review.verified)) {
    return "review_not_verified";
  }
  return null;
}

type JudgeMeWebhook = {
  id: string | number;
  key: string;
  url: string;
};

export class JudgeMeApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "JudgeMeApiError";
    this.status = status;
  }
}

export function verifyJudgeMeWebhookSignature({
  rawBody,
  signature,
  secret,
}: {
  rawBody: string;
  signature: string | null;
  secret: string;
}) {
  if (!signature || !/^[a-f0-9]{64}$/i.test(signature) || !secret) {
    return false;
  }
  const expected = createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("hex");
  return timingSafeEqual(
    Buffer.from(signature.toLowerCase(), "hex"),
    Buffer.from(expected, "hex"),
  );
}

export function readJudgeMeReviewId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const root = payload as Record<string, unknown>;
  const review =
    root.review &&
    typeof root.review === "object" &&
    !Array.isArray(root.review)
      ? (root.review as Record<string, unknown>)
      : null;
  const value = root.review_id ?? root.id ?? review?.id;
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : null;
}

async function judgeMeRequest({
  path,
  apiToken,
  shopDomain,
  init,
}: {
  path: string;
  apiToken: string;
  shopDomain: string;
  init?: RequestInit;
}) {
  const url = new URL(path, JUDGEME_API_ORIGIN);
  if (
    url.origin !== JUDGEME_API_ORIGIN ||
    !url.pathname.startsWith("/api/v1/")
  ) {
    throw new Error("Invalid Judge.me API path.");
  }
  url.searchParams.set("shop_domain", shopDomain);

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    JUDGEME_REQUEST_TIMEOUT_MS,
  );
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "X-Api-Token": apiToken,
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
    if (!response.ok) {
      throw new JudgeMeApiError(
        response.status === 401 || response.status === 403
          ? "Judge.me rejected the private API token."
          : `Judge.me API request failed with status ${response.status}.`,
        response.status,
      );
    }
    return (await response.json()) as unknown;
  } catch (error) {
    if (error instanceof JudgeMeApiError) throw error;
    throw new JudgeMeApiError("Judge.me API is temporarily unavailable.", 503);
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchJudgeMeReview({
  apiToken,
  shopDomain,
  reviewId,
}: {
  apiToken: string;
  shopDomain: string;
  reviewId: string;
}) {
  if (!/^\d+$/.test(reviewId)) {
    throw new JudgeMeApiError("Judge.me review ID is invalid.", 422);
  }
  const payload = await judgeMeRequest({
    path: `/api/v1/reviews/${reviewId}`,
    apiToken,
    shopDomain,
  });
  const root =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const parsed = judgeMeReviewSchema.safeParse(root.review);
  if (!parsed.success) {
    throw new JudgeMeApiError(
      "Judge.me returned an invalid review response.",
      502,
    );
  }
  return parsed.data;
}

async function listJudgeMeWebhooks({
  apiToken,
  shopDomain,
}: {
  apiToken: string;
  shopDomain: string;
}) {
  const payload = await judgeMeRequest({
    path: "/api/v1/webhooks",
    apiToken,
    shopDomain,
  });
  const root =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  return Array.isArray(root.webhooks)
    ? root.webhooks.filter((value): value is JudgeMeWebhook =>
        Boolean(
          value &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            (typeof (value as JudgeMeWebhook).id === "string" ||
              typeof (value as JudgeMeWebhook).id === "number") &&
            typeof (value as JudgeMeWebhook).key === "string" &&
            typeof (value as JudgeMeWebhook).url === "string",
        ),
      )
    : [];
}

async function ensureJudgeMeWebhooks({
  apiToken,
  shopDomain,
  integrationId,
}: {
  apiToken: string;
  shopDomain: string;
  integrationId: string;
}) {
  const callbackUrl = new URL(
    `/api/shopify/loyalty/webhooks/review/judgeme/${encodeURIComponent(integrationId)}`,
    APP_DOMAIN_WITH_NGROK,
  );
  if (callbackUrl.protocol !== "https:") {
    throw new JudgeMeApiError(
      "Judge.me setup requires the public Weletic HTTPS application URL.",
      503,
    );
  }

  const existing = await listJudgeMeWebhooks({ apiToken, shopDomain });
  const ids: Record<string, string> = {};
  for (const key of JUDGEME_WEBHOOK_KEYS) {
    const match = existing.find(
      (webhook) =>
        webhook.key === key && webhook.url === callbackUrl.toString(),
    );
    if (match) {
      ids[key] = String(match.id);
      continue;
    }
    const payload = await judgeMeRequest({
      path: "/api/v1/webhooks",
      apiToken,
      shopDomain,
      init: {
        method: "POST",
        body: JSON.stringify({
          webhook: { key, url: callbackUrl.toString() },
        }),
      },
    });
    const root = payload as { webhook?: { id?: string | number } };
    if (root.webhook?.id === undefined) {
      throw new JudgeMeApiError(
        `Judge.me did not confirm the ${key} webhook.`,
        502,
      );
    }
    ids[key] = String(root.webhook.id);
  }
  return ids;
}

export async function configureJudgeMeIntegration({
  storeId,
  shopDomain,
  privateApiToken,
}: {
  storeId: string;
  shopDomain: string;
  privateApiToken: string;
}) {
  const token = privateApiToken.trim();
  if (token.length < 16 || token.length > 512) {
    throw new JudgeMeApiError("Judge.me private API token is invalid.", 422);
  }

  // Validate the store/token pair without retrieving or persisting review PII.
  await judgeMeRequest({
    path: "/api/v1/shops/info",
    apiToken: token,
    shopDomain,
  });
  // Persist the encrypted credential in a disabled state before registering
  // external callbacks. A callback can therefore never award points against
  // an integration whose local configuration did not commit.
  const proposedId = createWeleticId("wreviewint_");
  const prepared = await withActiveStoreLoyaltyMutation({
    storeId,
    action: "judgeme_review_integration_prepare",
    operation: (tx) =>
      tx.weleticLoyaltyReviewIntegration.upsert({
        where: { storeId_provider: { storeId, provider: JUDGEME_PROVIDER } },
        create: {
          id: proposedId,
          storeId,
          provider: JUDGEME_PROVIDER,
          encryptedApiToken: encrypt(token),
          enabled: false,
          lastVerifiedAt: null,
        },
        update: {
          encryptedApiToken: encrypt(token),
          enabled: false,
          lastVerifiedAt: null,
        },
        select: { id: true, updatedAt: true },
      }),
  });
  const webhookIds = await ensureJudgeMeWebhooks({
    apiToken: token,
    shopDomain,
    integrationId: prepared.id,
  });

  return withActiveStoreLoyaltyMutation({
    storeId,
    action: "judgeme_review_integration_activate",
    operation: async (tx) => {
      const activated = await tx.weleticLoyaltyReviewIntegration.updateMany({
        where: {
          id: prepared.id,
          storeId,
          provider: JUDGEME_PROVIDER,
          enabled: false,
          updatedAt: prepared.updatedAt,
        },
        data: {
          webhookIds: webhookIds as Prisma.InputJsonValue,
          enabled: true,
          lastVerifiedAt: new Date(),
        },
      });
      if (activated.count !== 1) {
        throw new JudgeMeApiError(
          "Judge.me configuration changed concurrently. Retry the connection.",
          409,
        );
      }
      return tx.weleticLoyaltyReviewIntegration.findUniqueOrThrow({
        where: { id: prepared.id },
        select: {
          id: true,
          provider: true,
          enabled: true,
          lastVerifiedAt: true,
        },
      });
    },
  });
}

export function validateJudgeMeReviewRuleConditions(value: unknown) {
  const conditions =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  if (
    conditions.provider !== undefined &&
    conditions.provider !== JUDGEME_PROVIDER
  ) {
    throw new Error("Product review earning currently supports Judge.me only.");
  }
  const numberInRange = (key: string, fallback: number, max: number) => {
    if (conditions[key] === undefined || conditions[key] === "") {
      return fallback;
    }
    const parsed = Number(conditions[key]);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) {
      throw new Error(`${key} must be a whole number from 0 to ${max}.`);
    }
    return parsed;
  };
  return {
    provider: JUDGEME_PROVIDER,
    minContentLength: numberInRange("minContentLength", 20, 10_000),
    photoBonusPoints: numberInRange("photoBonusPoints", 0, 1_000_000),
    videoBonusPoints: numberInRange("videoBonusPoints", 0, 1_000_000),
  };
}

export type JudgeMeReviewAwardResult =
  | { status: "awarded"; pointsAwarded: string; accountId: string }
  | {
      status: "duplicate" | "ignored" | "limit_reached";
      reason: string;
    };

export async function awardJudgeMeReview({
  integrationId,
  review,
  now = new Date(),
}: {
  integrationId: string;
  review: JudgeMeReview;
  now?: Date;
}): Promise<JudgeMeReviewAwardResult> {
  const integration = await prisma.weleticLoyaltyReviewIntegration.findUnique({
    where: { id: integrationId },
    include: { store: { select: { id: true } } },
  });
  if (
    !integration ||
    !integration.enabled ||
    integration.provider !== JUDGEME_PROVIDER
  ) {
    return { status: "ignored", reason: "integration_unavailable" };
  }

  const reviewId = String(review.id);
  const reviewerEmail = (review.email || review.reviewer?.email || "")
    .normalize("NFKC")
    .trim()
    .toLowerCase();
  const ineligibleReason = getIneligibleJudgeMeReviewReason(review);
  if (!reviewerEmail || ineligibleReason) {
    return {
      status: "ignored",
      reason: ineligibleReason ?? "reviewer_email_missing",
    };
  }

  return withActiveStoreLoyaltyMutation({
    storeId: integration.storeId,
    action: "judgeme_review_points_earn",
    operation: async (tx) => {
      const currentIntegration =
        await tx.weleticLoyaltyReviewIntegration.findUnique({
          where: { id: integration.id },
          select: { enabled: true, provider: true },
        });
      if (
        !currentIntegration?.enabled ||
        currentIntegration.provider !== JUDGEME_PROVIDER
      ) {
        return { status: "ignored", reason: "integration_unavailable" };
      }

      return awardVerifiedReviewPoints({
        tx,
        storeId: integration.storeId,
        provider: JUDGEME_PROVIDER,
        accountIdentity: { email: reviewerEmail },
        now,
        review: {
          id: reviewId,
          body: review.body ?? "",
          rating: Number(review.rating),
          productId:
            review.product_external_id == null
              ? null
              : String(review.product_external_id),
          hasPhoto: review.has_published_pictures ?? false,
          hasVideo: review.has_published_videos ?? false,
          verifiedStatus: review.verified,
        },
      });
    },
  });
}

export async function processJudgeMeWebhook({
  integrationId,
  rawBody,
  signature,
}: {
  integrationId: string;
  rawBody: string;
  signature: string | null;
}) {
  const integration = await prisma.weleticLoyaltyReviewIntegration.findUnique({
    where: { id: integrationId },
    include: { store: { select: { shopDomain: true } } },
  });
  if (
    !integration ||
    !integration.enabled ||
    integration.provider !== JUDGEME_PROVIDER
  ) {
    throw new JudgeMeApiError("Review integration not found.", 404);
  }
  const apiToken = decrypt(integration.encryptedApiToken);
  if (
    !verifyJudgeMeWebhookSignature({ rawBody, signature, secret: apiToken })
  ) {
    throw new JudgeMeApiError("Invalid Judge.me webhook signature.", 401);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new JudgeMeApiError("Invalid Judge.me webhook JSON.", 400);
  }
  const reviewId = readJudgeMeReviewId(payload);
  if (!reviewId) {
    throw new JudgeMeApiError("Judge.me webhook is missing review ID.", 422);
  }

  // Never trust the event body for identity or verification status. Read the
  // current review from Judge.me using the tenant's encrypted server token.
  let review: JudgeMeReview;
  try {
    review = await fetchJudgeMeReview({
      apiToken,
      shopDomain: integration.store.shopDomain,
      reviewId,
    });
  } catch (error) {
    if (error instanceof JudgeMeApiError && error.status === 404) {
      return clawbackJudgeMeReview({
        integrationId,
        reviewId,
        reason: "Judge.me review was deleted",
      });
    }
    throw error;
  }
  const ineligibleReason = getIneligibleJudgeMeReviewReason(review);
  if (ineligibleReason) {
    return clawbackJudgeMeReview({
      integrationId,
      reviewId,
      reason: `Judge.me ${ineligibleReason.replaceAll("_", " ")}`,
    });
  }
  return awardJudgeMeReview({ integrationId, review });
}

export type JudgeMeReviewClawbackResult =
  | {
      status: "clawed_back";
      pointsReversed: string;
      balanceAfter: string;
      accountId: string;
    }
  | {
      status: "duplicate";
      reason: "already_clawed_back";
      pointsReversed: string;
      balanceAfter: string;
      accountId: string;
    }
  | {
      status: "ignored";
      reason: string;
    };

export async function clawbackJudgeMeReview({
  integrationId,
  reviewId,
  reason,
}: {
  integrationId: string;
  reviewId: string;
  reason?: string;
}): Promise<JudgeMeReviewClawbackResult> {
  const integration = await prisma.weleticLoyaltyReviewIntegration.findUnique({
    where: { id: integrationId },
    select: { storeId: true, enabled: true, provider: true },
  });
  if (!integration) {
    return { status: "ignored", reason: "integration_not_found" };
  }
  if (!integration.enabled || integration.provider !== JUDGEME_PROVIDER) {
    return { status: "ignored", reason: "integration_unavailable" };
  }

  return withActiveStoreLoyaltyMutation({
    storeId: integration.storeId,
    action: "judgeme_review_points_clawback",
    operation: (tx) =>
      reverseReviewPoints({
        tx,
        storeId: integration.storeId,
        provider: JUDGEME_PROVIDER,
        reviewId: String(reviewId).trim(),
        reason,
      }),
  });
}
