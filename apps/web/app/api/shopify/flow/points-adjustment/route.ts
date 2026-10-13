import { handleFlowPointsAction } from "@/lib/weletic/loyalty/flow-action-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  return handleFlowPointsAction(request, {
    enabled: process.env.WELETIC_SHOPIFY_FLOW_ACTIONS_ENABLED === "1",
    appId: process.env.SHOPIFY_CLIENT_ID || process.env.SHOPIFY_API_KEY || "",
    publicAppSecret: process.env.SHOPIFY_WEBHOOK_SECRET,
    rotationSecret: process.env.SHOPIFY_WEBHOOK_SECRET_NEXT,
  });
}
