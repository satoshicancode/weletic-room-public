import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { withShopifyCustomerSettlementLocks } from "../shopify/customer-settlement-lock";
import { readWeleticShopifyRequestBodyBytes } from "../shopify/service-auth";
import { readStoreOwnedShopifyCredential } from "../shopify/store-owned-credential";
import {
  executeFlowPointsActionInTransaction,
  FlowActionExecutionError,
} from "./flow-action-execution";
import { readAuthenticatedFlowPointsAction } from "./flow-action-request";

const response = (status: number) =>
  new Response(
    status === 200
      ? null
      : JSON.stringify({ message: "Flow action unavailable" }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );

/** No legacy credential fallback, customer fetch, enrollment, or token exchange.
 * Config is supplied by the server, never derived from request fields.
 */
export async function handleFlowPointsAction(
  request: Request,
  config: {
    enabled: boolean;
    appId: string;
    publicAppSecret: string | undefined;
    rotationSecret?: string;
  },
) {
  if (
    !config.enabled ||
    !config.appId ||
    config.appId !== process.env.SHOPIFY_API_KEY?.trim()
  )
    return response(503);
  const authenticated = await readAuthenticatedFlowPointsAction({
    request,
    ...config,
  });
  if (!authenticated.ok) return response(authenticated.status);
  const action = authenticated.action;
  try {
    // Native public credentials only recognize the canonical persisted domain.
    // A signed shop ID alone must never select an unrelated store's grant.
    const store = await prisma.weleticShopifyStore.findUnique({
      where: { shopDomain: action.shopify_domain },
      select: { id: true, projectId: true, installationGeneration: true },
    });
    if (!store?.installationGeneration) return response(403);
    const identity = {
      storeId: store.id,
      workspaceId: store.projectId,
      appId: config.appId,
      shop: action.shopify_domain,
      installationGeneration: store.installationGeneration,
    };
    const credential = await prisma.$transaction((tx) =>
      readStoreOwnedShopifyCredential(tx, identity),
    );
    if (!credential) return response(503);
    // Read-only live shop verification happens outside SQL/Redis locks.
    // Redirects are forbidden: the token must never leave the configured shop.
    const verification = await fetch(
      `https://${identity.shop}/admin/api/2026-07/graphql.json`,
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(4000),
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": credential.accessToken,
        },
        body: JSON.stringify({
          query:
            "query WeleticFlowShopIdentity { shop { id myshopifyDomain } }",
        }),
      },
    );
    if (!verification.ok) return response(503);
    const bytes = await readWeleticShopifyRequestBodyBytes(verification, {
      maxBytes: 16 * 1024,
    });
    if (bytes === null) return response(503);
    const body = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (body?.errors?.length || !body?.data?.shop) return response(503);
    if (
      body.data.shop.id !== `gid://shopify/Shop/${action.shop_id}` ||
      body.data.shop.myshopifyDomain !== identity.shop
    )
      return response(403);
    await withShopifyCustomerSettlementLocks({
      workspaceId: identity.workspaceId,
      storeId: identity.storeId,
      shopifyCustomerId: action.properties.customer_id,
      fn: () =>
        prisma.$transaction(
          async (tx) => {
            // Fence the network observation against reinstall and same-generation
            // credential rotation. Store -> credential -> program -> grant/account.
            const current = await readStoreOwnedShopifyCredential(tx, identity);
            if (
              !current ||
              current.revision !== credential.revision ||
              current.accessToken !== credential.accessToken
            )
              throw new Error("Flow credential changed");
            return executeFlowPointsActionInTransaction({
              tx,
              scope: identity,
              input: action,
            });
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            maxWait: 2000,
            timeout: 5000,
          },
        ),
    });
    return response(200);
  } catch (error) {
    if (
      error instanceof FlowActionExecutionError &&
      error.code === "run_conflict"
    )
      return response(409);
    // Includes unknown commit outcomes: let Shopify redeliver the SAME run.
    // Never retry with a new key or expose tokens, IDs, provider bodies or SQL.
    return response(503);
  }
}
