import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const retiredMessage =
  "Direct Shopify credential bootstrap is retired. Open the app in Shopify Admin for managed installation, or use the authenticated Shopify connection settings for an existing legacy integration. Do not pass access tokens on the command line.";

/** Keep the old entry point fail-closed for local callers, without importing
 * runtime configuration, choosing a workspace user, persisting credentials,
 * or starting catalog/customer synchronization. See ADR 0025.
 */
export async function connectShopifyStore(_input: {
  workspaceSlug: string;
  shopDomain: string;
  accessToken: string;
}): Promise<never> {
  throw new Error(retiredMessage);
}

// Importing this module must not execute a command based on unrelated argv.
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  console.error(retiredMessage);
  process.exitCode = 1;
}
