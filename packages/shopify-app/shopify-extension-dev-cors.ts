import type { Connect, Plugin } from "vite";

const EXTENSION_GATEWAY_PREFIXES = [
  "/api/customer-account",
  "/api/checkout",
] as const;

function isExtensionGatewayPath(pathname: string) {
  return EXTENSION_GATEWAY_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Vite handles OPTIONS before Remix resource routes in local development.
 * Answer only the bearer-auth extension gateways; all other Vite resources
 * retain same-origin development-server protection.
 */
export const shopifyExtensionDevCorsMiddleware: Connect.NextHandleFunction = (
  request,
  response,
  next,
) => {
  if (request.method?.toUpperCase() !== "OPTIONS") return next();

  let pathname: string;
  try {
    pathname = new URL(
      request.url || "/",
      `http://${request.headers.host || "localhost"}`,
    ).pathname;
  } catch {
    return next();
  }
  if (!isExtensionGatewayPath(pathname)) return next();

  response.statusCode = 204;
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type",
  );
  response.setHeader(
    "Access-Control-Expose-Headers",
    "Server-Timing, X-Weletic-Request-Id",
  );
  response.setHeader("Access-Control-Max-Age", "86400");
  response.end();
};

export function shopifyExtensionDevCorsPlugin(): Plugin {
  return {
    name: "weletic-shopify-extension-dev-cors",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(shopifyExtensionDevCorsMiddleware);
    },
  };
}
