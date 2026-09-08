import { json } from "@remix-run/node";
import crypto from "node:crypto";

export const WELETIC_INTERNAL_TIMESTAMP_HEADER = "x-weletic-timestamp";
export const WELETIC_INTERNAL_SIGNATURE_HEADER = "x-weletic-signature";
export const WELETIC_REQUEST_ID_HEADER = "x-weletic-request-id";
export const WELETIC_INTERNAL_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
export const DEFAULT_WELETIC_API_TIMEOUT_MS = 8_000;
const MAX_GATEWAY_BODY_BYTES = 64 * 1024;

const EXTENSION_CORS_HEADERS = {
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "Server-Timing, X-Weletic-Request-Id",
  "Access-Control-Max-Age": "86400",
} as const;

export class WeleticGatewayError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "WeleticGatewayError";
    this.status = status;
  }
}

export function privateCustomerJson(
  data: unknown,
  init: ResponseInit = {},
  vary = "Authorization",
) {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set("Vary", vary);
  headers.set(
    "Access-Control-Expose-Headers",
    "Server-Timing, X-Weletic-Request-Id",
  );
  headers.set("Timing-Allow-Origin", "*");
  return json(data, { ...init, headers });
}

/**
 * Shopify UI extensions send bearer session tokens from a sandboxed browser
 * origin. Their OPTIONS request has no token, so it must be answered before
 * the Shopify session-token authenticator runs. The wildcard origin is safe
 * here because the gateways never use ambient cookies and every non-OPTIONS
 * request still requires a verified Shopify bearer token.
 */
export function extensionCorsPreflight(request: Request) {
  if (request.method.toUpperCase() !== "OPTIONS") return null;

  return new Response(null, {
    status: 204,
    headers: EXTENSION_CORS_HEADERS,
  });
}

export async function readGatewayJsonBody(
  request: Request,
): Promise<Record<string, unknown>> {
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_GATEWAY_BODY_BYTES
  ) {
    throw new WeleticGatewayError("Request body is too large", 413);
  }

  const body = await request.text();
  if (Buffer.byteLength(body, "utf8") > MAX_GATEWAY_BODY_BYTES) {
    throw new WeleticGatewayError("Request body is too large", 413);
  }
  if (!body) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new WeleticGatewayError("Invalid JSON request body", 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WeleticGatewayError("JSON request body must be an object", 400);
  }
  return parsed as Record<string, unknown>;
}

export function requireEnv(name: string) {
  const developmentFallbacks: Record<string, string> = {
    SHOPIFY_APP_URL:
      process.env.SHOPIFY_APP_URL ||
      process.env.HOST ||
      process.env.APP_URL ||
      "http://localhost:3000",
    WELETIC_API_URL: "http://localhost:8888",
  };

  const fallback =
    process.env.NODE_ENV === "production"
      ? undefined
      : developmentFallbacks[name];
  const value = process.env[name]?.trim() || fallback;
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

export function requireUrlEnv(name: string) {
  const raw = requireEnv(name);
  const url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);

  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error(`${name} must use HTTPS in production`);
  }

  return url;
}

function getWeleticApiUrl() {
  const url = requireUrlEnv("WELETIC_API_URL");

  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

function getWeleticApiTimeoutMs(method: string): number | null {
  const isRead = method === "GET" || method === "HEAD";
  if (!isRead) return null;

  const configured = Number(process.env.WELETIC_API_TIMEOUT_MS);
  return Number.isSafeInteger(configured) &&
    configured >= 100 &&
    configured <= 60_000
    ? configured
    : DEFAULT_WELETIC_API_TIMEOUT_MS;
}

function signRequest({
  timestamp,
  method,
  path,
  body,
  secret = requireEnv("WELETIC_SHOPIFY_SERVICE_SECRET"),
}: {
  timestamp: string;
  method: string;
  path: string;
  body: string;
  secret?: string;
}) {
  if (secret.length < 32) {
    throw new Error(
      "WELETIC_SHOPIFY_SERVICE_SECRET must be at least 32 characters",
    );
  }

  return crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}\n${method.toUpperCase()}\n${path}\n${body}`)
    .digest("hex");
}

export function verifyWeleticInternalRequest({
  request,
  body = "",
  now = Date.now(),
  secret = requireEnv("WELETIC_SHOPIFY_SERVICE_SECRET"),
}: {
  request: Request;
  body?: string;
  now?: number;
  secret?: string;
}) {
  if (secret.length < 32) {
    throw new Error(
      "WELETIC_SHOPIFY_SERVICE_SECRET must be at least 32 characters",
    );
  }

  const timestamp = request.headers.get(WELETIC_INTERNAL_TIMESTAMP_HEADER);
  const signature = request.headers.get(WELETIC_INTERNAL_SIGNATURE_HEADER);
  if (!timestamp || !signature || !/^[a-f0-9]{64}$/.test(signature)) {
    return false;
  }

  const timestampMs = Number(timestamp);
  if (
    !Number.isSafeInteger(timestampMs) ||
    Math.abs(now - timestampMs) > WELETIC_INTERNAL_MAX_CLOCK_SKEW_MS
  ) {
    return false;
  }

  const url = new URL(request.url);
  const expected = signRequest({
    timestamp,
    method: request.method,
    path: `${url.pathname}${url.search}`,
    body,
    secret,
  });

  return crypto.timingSafeEqual(
    Buffer.from(signature, "hex"),
    Buffer.from(expected, "hex"),
  );
}

export async function weleticApiRequest(
  path: string,
  init: Omit<RequestInit, "body"> & { body?: string } = {},
) {
  if (!path.startsWith("/api/internal/shopify/")) {
    throw new Error("Only Weletic Shopify internal API paths are allowed");
  }

  const url = new URL(path, getWeleticApiUrl());
  if (!url.pathname.startsWith("/api/internal/shopify/")) {
    throw new Error(
      "Normalized path must stay inside the Shopify internal API",
    );
  }
  const method = (init.method || "GET").toUpperCase();
  const body = init.body || "";
  const timestamp = String(Date.now());
  const signedPath = `${url.pathname}${url.search}`;
  const signature = signRequest({ timestamp, method, path: signedPath, body });
  const controller = new AbortController();
  let didTimeout = false;
  const abortFromCaller = () => controller.abort(init.signal?.reason);
  if (init.signal?.aborted) {
    abortFromCaller();
  } else {
    init.signal?.addEventListener("abort", abortFromCaller, { once: true });
  }
  const timeoutMs = getWeleticApiTimeoutMs(method);
  const timeout = timeoutMs
    ? setTimeout(() => {
        didTimeout = true;
        controller.abort();
      }, timeoutMs)
    : null;

  let response: Response;
  try {
    const upstream = await fetch(url, {
      ...init,
      method,
      body: body || undefined,
      cache: "no-store",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
        [WELETIC_INTERNAL_TIMESTAMP_HEADER]: timestamp,
        [WELETIC_INTERNAL_SIGNATURE_HEADER]: signature,
      },
    });
    // Keep the read deadline active until the full response arrives. A server
    // that sends headers and then stalls must not leave the extension loading
    // forever. Internal responses are JSON and intentionally buffered here.
    const responseBody = await upstream.arrayBuffer();
    response = new Response(
      [204, 205, 304].includes(upstream.status) ? null : responseBody,
      {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: upstream.headers,
      },
    );
  } catch (error) {
    if (didTimeout) {
      throw new WeleticGatewayError(
        "Weletic service took too long to respond",
        504,
      );
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    init.signal?.removeEventListener("abort", abortFromCaller);
  }

  if (!response.ok) {
    const responseBody = await response.text();
    let upstreamMessage = "Weletic request was rejected";
    if (response.status >= 500) {
      upstreamMessage = "Weletic service is temporarily unavailable";
    } else {
      try {
        const parsed = JSON.parse(responseBody) as {
          error?: { message?: unknown };
        };
        if (typeof parsed.error?.message === "string") {
          upstreamMessage = parsed.error.message.slice(0, 300);
        }
      } catch {
        // Keep the bounded generic message for non-JSON upstream responses.
      }
    }
    throw new WeleticGatewayError(upstreamMessage, response.status);
  }

  return response;
}

export async function weleticApiJson<T>(
  path: string,
  init?: Omit<RequestInit, "body"> & { body?: string },
) {
  const response = await weleticApiRequest(path, init);
  return (await response.json()) as T;
}
