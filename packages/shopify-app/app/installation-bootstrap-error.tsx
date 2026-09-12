import { isRouteErrorResponse } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";

// Preserve Shopify's typed response handling, but never rethrow or display
// ordinary gateway/provider errors before the recovery link can render.
export function installationBootstrapError(error: unknown) {
  return isRouteErrorResponse(error) ? (
    boundary.error(error)
  ) : (
    <p role="alert">
      App authentication is unavailable. Open installation status to recover.
    </p>
  );
}
