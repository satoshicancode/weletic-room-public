import {
  loyaltyErrorResponse,
  loyaltySuccessResponse,
} from "@/lib/weletic/loyalty/response";
import {
  JUDGEME_WEBHOOK_SIGNATURE_HEADER,
  JudgeMeApiError,
  processJudgeMeWebhook,
} from "@/lib/weletic/loyalty/review-providers/judgeme";

export const dynamic = "force-dynamic";

const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

async function readBoundedBody(request: Request) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_WEBHOOK_BODY_BYTES
  ) {
    return null;
  }

  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_WEBHOOK_BODY_BYTES) return null;
  return new TextDecoder().decode(body);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ integrationId: string }> },
) {
  const { integrationId } = await params;
  if (!/^wreviewint_[A-Za-z0-9_-]{10,64}$/.test(integrationId)) {
    return loyaltyErrorResponse(
      "integration_not_found",
      "Review integration not found.",
      404,
    );
  }

  const rawBody = await readBoundedBody(request);
  if (rawBody === null) {
    return loyaltyErrorResponse(
      "payload_too_large",
      "Webhook payload is too large.",
      413,
    );
  }

  try {
    const result = await processJudgeMeWebhook({
      integrationId,
      rawBody,
      signature: request.headers.get(JUDGEME_WEBHOOK_SIGNATURE_HEADER),
    });
    return loyaltySuccessResponse(result);
  } catch (error) {
    if (error instanceof JudgeMeApiError) {
      const status =
        error.status === 401 || error.status === 404 || error.status === 422
          ? error.status
          : 503;
      return loyaltyErrorResponse(
        status === 401
          ? "invalid_signature"
          : status === 404
            ? "integration_not_found"
            : status === 422
              ? "invalid_event"
              : "review_provider_unavailable",
        error.message,
        status,
      );
    }

    console.error("[Judge.me Loyalty Webhook Error]", {
      errorType: error instanceof Error ? error.name : typeof error,
    });
    return loyaltyErrorResponse(
      "review_webhook_failed",
      "Unable to process the review event.",
      503,
    );
  }
}
