import { handleFlowPointsAction } from "@/lib/weletic/loyalty/flow-action-handler";
import { PUBLIC_LOYALTY_CLIENT_ID } from "../../../../../../../packages/shopify-app/app/public-runtime-policy.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  return handleFlowPointsAction(request, {
    enabled: process.env.WELETIC_SHOPIFY_FLOW_ACTIONS_ENABLED === "1",
    appId: PUBLIC_LOYALTY_CLIENT_ID,
    publicAppSecret: process.env.SHOPIFY_WEBHOOK_SECRET,
    rotationSecret: process.env.SHOPIFY_WEBHOOK_SECRET_NEXT,
  });
}
