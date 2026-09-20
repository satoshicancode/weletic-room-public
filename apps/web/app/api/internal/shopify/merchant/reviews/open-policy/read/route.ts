import { createOpenReviewPolicyRoute } from "@/lib/weletic/shopify/merchant-open-review-policy-route";

export const dynamic = "force-dynamic";
export const POST = createOpenReviewPolicyRoute("read");
