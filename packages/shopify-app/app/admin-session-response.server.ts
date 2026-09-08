import { json, type LoaderFunctionArgs } from "@remix-run/node";
import type { Session } from "@shopify/shopify-api";
import { SessionNotFoundError } from "@shopify/shopify-app-remix/server";
import {
  verifyWeleticInternalRequest,
  WeleticGatewayError,
} from "./weletic-api.server";

const headers = { "Cache-Control": "private, no-store" };

/** The installed endpoint is distinct: an old backend cannot ignore its fence. */
export function adminSessionResponse(
  load: (
    shop: string,
    generation: string | null,
  ) => Promise<{ session: Session }>,
  requireGeneration = false,
) {
  return async ({ request }: LoaderFunctionArgs) => {
    if (!verifyWeleticInternalRequest({ request }))
      return json({ error: "Unauthorized" }, { status: 401, headers });
    const params = new URL(request.url).searchParams;
    const shop = params.get("shop")?.trim().toLowerCase();
    const generation = params.get("generation");
    if (
      !shop ||
      shop.length > 255 ||
      !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) ||
      params.getAll("shop").length !== 1 ||
      params.getAll("generation").length > 1 ||
      (requireGeneration &&
        (!generation || !/^[A-Za-z0-9_-]{1,64}$/.test(generation))) ||
      (!requireGeneration && generation !== null)
    )
      return json(
        { error: "Invalid Shopify session request" },
        { status: 400, headers },
      );
    try {
      const { session } = await load(shop, generation);
      if (
        session.isOnline ||
        session.shop !== shop ||
        !session.accessToken ||
        (session.expires &&
          (!Number.isFinite(session.expires.getTime()) ||
            session.expires.getTime() <= Date.now() + 60_000))
      )
        return json(
          { error: "Offline Shopify session unavailable" },
          { status: 503, headers },
        );
      return json(
        {
          shop,
          accessToken: session.accessToken,
          scope: session.scope || "",
          expiresAt: session.expires?.toISOString() || null,
          ...(requireGeneration ? { installationGeneration: generation } : {}),
        },
        { headers },
      );
    } catch (error) {
      // Generic SDK failures include uncertain refresh outcomes. They cannot
      // establish merchant expiry or permission to clear/reconnect a session.
      const missing = error instanceof SessionNotFoundError;
      const conflict =
        error instanceof WeleticGatewayError && error.status === 409;
      return json(
        {
          ...(missing
            ? {
                code: "SESSION_MISSING",
                shop,
                ...(requireGeneration
                  ? { installationGeneration: generation }
                  : {}),
              }
            : {}),
          error: missing
            ? "Offline Shopify session unavailable"
            : "Shopify session temporarily unavailable",
        },
        { status: missing ? 404 : conflict ? 409 : 503, headers },
      );
    }
  };
}
