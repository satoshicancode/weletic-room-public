import { prisma } from "@/lib/prisma";
import { isCoreLaunch } from "@/lib/weletic/core-launch-policy";
import { reconcileSubscribedInstallation } from "@/lib/weletic/shopify/app-pricing-service";
import { assertFreshInstallationStatusIdentity } from "@/lib/weletic/shopify/installation-admission-contract";
import {
  readWeleticShopifyRequestBodyBytes,
  verifyWeleticShopifyRequest,
} from "@/lib/weletic/shopify/service-auth";
import { Prisma } from "@prisma/client";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
export async function POST(request: Request) {
  try {
    if (!isCoreLaunch())
      return Response.json({ error: "unavailable" }, { status: 404, headers });
    const bytes = await readWeleticShopifyRequestBodyBytes(request, {
      maxBytes: 4096,
    });
    if (!bytes)
      return Response.json(
        { error: "invalid_request" },
        { status: 400, headers },
      );
    const body = new TextDecoder().decode(bytes);
    if (!verifyWeleticShopifyRequest({ request, body }))
      return Response.json({ error: "unauthorized" }, { status: 401, headers });
    const value: unknown = JSON.parse(body);
    const actor = await prisma.$transaction(async (tx) => {
      const [clock] = await tx.$queryRaw<Array<{ now: Date }>>(
        Prisma.sql`SELECT CURRENT_TIMESTAMP(3) AS now`,
      );
      return assertFreshInstallationStatusIdentity(
        value,
        process.env.SHOPIFY_API_KEY ?? "",
        clock.now,
      );
    });
    const result = await reconcileSubscribedInstallation(actor.shop);
    return Response.json(
      {
        status: result.status,
        credentialsChanged: result.credentialsChanged,
        validUntil: result.validUntil.toISOString(),
      },
      { headers },
    );
  } catch {
    return Response.json(
      { error: "subscription_unavailable" },
      { status: 503, headers },
    );
  }
}
