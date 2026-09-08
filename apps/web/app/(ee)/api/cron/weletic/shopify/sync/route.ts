import { handleAndReturnErrorResponse } from "@/lib/api/errors";
import { verifyQstashSignature } from "@/lib/cron/verify-qstash";
import { syncWeleticShopifyCatalog } from "@/lib/weletic/shopify/catalog-sync";
import * as z from "zod/v4";

const schema = z.object({ workspaceId: z.string() });

export async function POST(req: Request) {
  try {
    const rawBody = await req.text();
    await verifyQstashSignature({ req, rawBody });
    const { workspaceId } = schema.parse(JSON.parse(rawBody));
    const result = await syncWeleticShopifyCatalog({ workspaceId });
    return Response.json(result);
  } catch (error) {
    return handleAndReturnErrorResponse(error);
  }
}
