import { COMMON_CORS_HEADERS } from "@/lib/api/cors";
import { persistAndQueueShopifyComplianceRequest } from "@/lib/weletic/shopify/compliance-ingress";
import { resolveComplianceShopifyStoreByDomain } from "@/lib/weletic/shopify/compliance-store-resolver";
import { parseShopifyComplianceSubject } from "@/lib/weletic/shopify/compliance-types";
import { createAllShopifyWebhookBodyDigests } from "@/lib/weletic/shopify/privacy-identity";
import { readVerifiedShopifyWebhook } from "@/lib/weletic/shopify/webhook-request";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export const POST = async (req: Request) => {
  const verified = await readVerifiedShopifyWebhook<unknown>({
    request: req,
    expectedTopic: "customers/data_request",
  });
  if (!verified.ok) return verified.response;

  try {
    const subject = parseShopifyComplianceSubject({
      topic: "customers/data_request",
      payload: verified.body,
    });
    const [headerStore, signedStore] = await Promise.all([
      resolveComplianceShopifyStoreByDomain(
        req.headers.get("x-shopify-shop-domain") ?? "",
      ),
      resolveComplianceShopifyStoreByDomain(subject.shopDomain),
    ]);
    if (
      !headerStore ||
      !signedStore ||
      headerStore.storeId !== signedStore.storeId
    ) {
      return new Response("[Shopify] Compliance tenant mismatch.", {
        status: 401,
      });
    }
    const persisted = await persistAndQueueShopifyComplianceRequest({
      storeId: headerStore.storeId,
      canonicalShopDomain: headerStore.canonicalShopDomain,
      storageShopDomain: headerStore.storageShopDomain,
      alreadyRedacted:
        headerStore.complianceState === "redacted" ||
        headerStore.resolvedFromTombstone,
      webhookId: req.headers.get("x-shopify-webhook-id") ?? "",
      authenticatedBodyDigests: createAllShopifyWebhookBodyDigests({
        topic: "customers/data_request",
        rawBodyBytes: verified.rawBodyBytes,
      }),
      topic: "customers/data_request",
      payload: verified.body,
    });
    return NextResponse.json(
      { accepted: true, requestId: persisted.requestId },
      { status: 200, headers: COMMON_CORS_HEADERS },
    );
  } catch {
    return NextResponse.json(
      { message: "Compliance request could not be persisted." },
      { status: 500, headers: COMMON_CORS_HEADERS },
    );
  }
};

export const OPTIONS = () =>
  new Response(null, { status: 204, headers: COMMON_CORS_HEADERS });
