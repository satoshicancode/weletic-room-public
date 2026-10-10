/// <reference types="@cloudflare/workers-types" />
import {
  redirectRateLimiter,
  getClientIp,
  createRateLimitResponse,
} from "../../../lib/weletic/edge-rate-limiter";

export interface LinkRecord {
  id: string;
  projectId: string;
  partnerId?: string | null;
  url: string;
  geo?: Record<string, string> | string | null;
  disabledAt?: string | null;
  expiresAt?: string | null;
  archived?: boolean | number | null;
}

export interface NegativeCacheSentinel {
  notFound: true;
  cachedAt: number;
}

export interface AnalyticsEngineDataPointInput {
  blobs?: (string | null | undefined)[];
  doubles?: (number | null | undefined)[];
  indexes?: (string | null | undefined)[];
}

export interface AnalyticsEngineDatasetBinding {
  writeDataPoint(dataPoint: AnalyticsEngineDataPointInput): void;
}

export interface LinkRedirectorEnv {
  LINKS_KV?: KVNamespace;
  DB?: D1Database;
  CLICKS_ANALYTICS?: AnalyticsEngineDatasetBinding;
  RATE_LIMIT_DISABLED?: string | boolean;
  RATE_LIMIT_MAX?: number;
  RATE_LIMIT_WINDOW_MS?: number;
}

export const KV_EXPIRATION_TTL_SECONDS = 86400; // 24 hours
export const KV_NEGATIVE_CACHE_TTL_SECONDS = 60; // 60 seconds (SEC-R4-02)
export const ATTRIBUTION_COOKIE_MAX_AGE_SECONDS = 2592000; // 30 days

/**
 * Builds canonical KV lookup key: link:${domain}:${key.toLowerCase()}
 */
export function buildKvKey(domain: string, key: string): string {
  const cleanDomain = domain.replace(/^www\./, "").split(":")[0].toLowerCase();
  return `link:${cleanDomain}:${key.toLowerCase()}`;
}

/**
 * Safely parses geo targeting mapping (JSON object or parsed map)
 */
export function parseLinkGeo(
  geo: Record<string, string> | string | null | undefined,
): Record<string, string> | null {
  if (!geo) return null;
  if (typeof geo === "object") {
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(geo)) {
      if (typeof v === "string") {
        result[k.toUpperCase()] = v;
      }
    }
    return result;
  }
  if (typeof geo === "string") {
    try {
      const parsed = JSON.parse(geo);
      if (parsed && typeof parsed === "object") {
        const result: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === "string") {
            result[k.toUpperCase()] = v;
          }
        }
        return result;
      }
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Detects whether incoming request is from a search engine bot / crawler
 */
export function isBot(request: Request): boolean {
  if (request.headers.get("cf-verified-bot") === "1") {
    return true;
  }
  const ua = request.headers.get("user-agent") || "";
  if (!ua) return false;
  const botPatterns =
    /bot|spider|crawl|slurp|facebookexternalhit|whatsapp|preview|lighthouse|curl|wget/i;
  return botPatterns.test(ua);
}

/**
 * Detects whether request originated from a QR code scan
 */
export function isQrScan(url: URL): boolean {
  return url.searchParams.get("qr") === "1";
}

/**
 * Resolves destination URL based on custom geo override or regional storefront currency routing
 */
export function resolveTargetUrl(options: {
  baseTargetUrl: string;
  country?: string | null;
  customGeoMapping?: Record<string, string> | null;
}): string {
  const { baseTargetUrl, country, customGeoMapping } = options;
  const normalizedCountry = country ? country.trim().toUpperCase() : "";

  // 1. Custom geo mapping override
  if (customGeoMapping && normalizedCountry && customGeoMapping[normalizedCountry]) {
    return customGeoMapping[normalizedCountry];
  }

  // 2. Default Regional Storefront Currency Routing
  let target: URL;
  try {
    target = new URL(baseTargetUrl);
  } catch {
    try {
      target = new URL(`https://${baseTargetUrl.replace(/^\/+/, "")}`);
    } catch {
      return baseTargetUrl;
    }
  }

  // Strip any existing language/locale prefix (/ja, /vi, /en) to prevent nested paths like /vi/ja/...
  let cleanPathname = target.pathname;
  while (/^\/(?:ja|vi|en)(?:-[a-z]{2})?(?=\/|$)/i.test(cleanPathname)) {
    cleanPathname = cleanPathname.replace(/^\/(?:ja|vi|en)(?:-[a-z]{2})?(?=\/|$)/i, "");
  }
  if (!cleanPathname.startsWith("/")) {
    cleanPathname = `/${cleanPathname}`;
  }

  if (normalizedCountry === "JP") {
    target.searchParams.set("currency", "JPY");
    if (cleanPathname === "" || cleanPathname === "/") {
      target.pathname = "/ja";
    } else {
      target.pathname = `/ja${cleanPathname}`;
    }
  } else if (normalizedCountry === "VN") {
    target.searchParams.set("currency", "VND");
    if (cleanPathname === "" || cleanPathname === "/") {
      target.pathname = "/vi";
    } else {
      target.pathname = `/vi${cleanPathname}`;
    }
  } else {
    // Global / Other
    target.searchParams.set("currency", "USD");
    target.pathname = cleanPathname === "" ? "/" : cleanPathname;
  }

  return target.toString();
}

/**
 * Core handler for edge shortlink redirection, geo-routing and telemetry logging
 */
export async function handleLinkRedirection(
  request: Request,
  env: LinkRedirectorEnv,
  _ctx?: ExecutionContext,
): Promise<Response> {
  // Allow GET and HEAD requests only
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // 0. Edge Burst Rate Limiting (SEC-R4-04)
  if (env.RATE_LIMIT_DISABLED !== true && env.RATE_LIMIT_DISABLED !== "true") {
    const clientIp = getClientIp(request);
    if (clientIp) {
      const rlResult = redirectRateLimiter.check(
        clientIp,
        env.RATE_LIMIT_MAX,
        env.RATE_LIMIT_WINDOW_MS,
      );
      if (!rlResult.success) {
        return createRateLimitResponse(
          rlResult.resetMs,
          rlResult.limit,
          rlResult.remaining,
        );
      }
    }
  }

  const incomingUrl = new URL(request.url);
  const domain = incomingUrl.hostname.replace(/^www\./, "").toLowerCase();

  // Extract key from path (ignoring leading slashes)
  let rawKey = decodeURIComponent(incomingUrl.pathname.replace(/^\/+/, ""));
  if (!rawKey) {
    rawKey = "_root";
  }

  // Dub inspect mode (+ suffix)
  if (rawKey.endsWith("+") && rawKey.length > 1) {
    rawKey = rawKey.slice(0, -1);
  }

  const key = rawKey;

  // Ignore static assets
  if (key === "favicon.ico" || key === "robots.txt") {
    return new Response("Not Found", { status: 404 });
  }

  const kvKey = buildKvKey(domain, key);

  let linkRecord: LinkRecord | null = null;

  // 1. KV Fast-Path Lookup (< 15ms)
  if (env.LINKS_KV) {
    try {
      const cached = await env.LINKS_KV.get(kvKey, "json");
      if (cached && typeof cached === "object") {
        if ((cached as any).notFound === true) {
          // Negative cache hit: return 404 immediately without querying D1 (SEC-R4-02)
          return new Response("Not Found", { status: 404 });
        }
        linkRecord = cached as LinkRecord;
      }
    } catch {
      // KV lookup failure gracefully falls back to D1
    }
  }

  // 2. D1 Fallback on Cache Miss
  if (!linkRecord && env.DB) {
    try {
      const stmt = env.DB.prepare(
        "SELECT id, projectId, partnerId, url, geo, disabledAt, expiresAt, archived FROM Link WHERE domain = ? AND LOWER(key) = LOWER(?) AND disabledAt IS NULL AND (archived = 0 OR archived IS FALSE)",
      );
      const row = await stmt.bind(domain, key).first<any>();

      if (row) {
        linkRecord = {
          id: row.id,
          projectId: row.projectId,
          partnerId: row.partnerId,
          url: row.url,
          geo: typeof row.geo === "string" ? JSON.parse(row.geo) : row.geo,
          disabledAt: row.disabledAt,
          expiresAt: row.expiresAt,
          archived: Boolean(row.archived),
        };

        // Auto-populate KV for subsequent sub-15ms hits (non-blocking via waitUntil)
        if (env.LINKS_KV) {
          const kvPutPromise = Promise.resolve(
            env.LINKS_KV.put(
              kvKey,
              JSON.stringify(linkRecord),
              {
                expirationTtl: KV_EXPIRATION_TTL_SECONDS,
              },
            ),
          ).catch((err) => {
            console.warn(
              `[Link Redirector] Non-blocking KV cache write failed for ${kvKey}:`,
              err,
            );
          });

          if (_ctx?.waitUntil) {
            _ctx.waitUntil(kvPutPromise);
          } else {
            await kvPutPromise;
          }
        }
      }
    } catch {
      // DB error falls through to 404
    }
  }

  // 3. Link Not Found, Soft-Deleted, or Archived (Invariant 2 Enforcement)
  if (!linkRecord) {
    // Write negative cache sentinel to KV with 60s TTL to protect D1 daily quota (SEC-R4-02)
    if (env.LINKS_KV) {
      const negativeSentinel: NegativeCacheSentinel = {
        notFound: true,
        cachedAt: Date.now(),
      };
      const negativePutPromise = Promise.resolve(
        env.LINKS_KV.put(
          kvKey,
          JSON.stringify(negativeSentinel),
          {
            expirationTtl: KV_NEGATIVE_CACHE_TTL_SECONDS,
          },
        ),
      ).catch((err) => {
        console.warn(
          `[Link Redirector] Non-blocking negative KV cache write failed for ${kvKey}:`,
          err,
        );
      });

      if (_ctx?.waitUntil) {
        _ctx.waitUntil(negativePutPromise);
      } else {
        await negativePutPromise;
      }
    }
    return new Response("Not Found", { status: 404 });
  }

  // Strictly enforce Invariant 2: Never redirect soft-deleted links
  if (linkRecord.disabledAt !== null && linkRecord.disabledAt !== undefined) {
    return new Response("Not Found", { status: 404 });
  }

  // Strictly enforce: Never redirect archived links
  if (linkRecord.archived === true || linkRecord.archived === 1) {
    return new Response("Not Found", { status: 404 });
  }

  // Enforce expiration
  if (linkRecord.expiresAt) {
    const expiresTimestamp = new Date(linkRecord.expiresAt).getTime();
    if (!Number.isNaN(expiresTimestamp) && expiresTimestamp <= Date.now()) {
      return new Response("Not Found", { status: 404 });
    }
  }

  // 4. Geo-Routing Engine via request.cf.country
  const cf = (request as any).cf || {};
  const country = cf.country || null;
  const city = cf.city || "Unknown";

  const customGeoMap = parseLinkGeo(linkRecord.geo);
  const resolvedBaseUrl = resolveTargetUrl({
    baseTargetUrl: linkRecord.url,
    country,
    customGeoMapping: customGeoMap,
  });

  const targetUrlObj = new URL(resolvedBaseUrl);

  // 5. Query Parameter Preservation: Merge all incoming search params
  incomingUrl.searchParams.forEach((paramValue, paramKey) => {
    targetUrlObj.searchParams.set(paramKey, paramValue);
  });

  // 6. Attribution Decoration: Append via, clickId, and set 30-day first-party cookie
  const clickId =
    incomingUrl.searchParams.get("clickId") ||
    (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `clk_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`);

  targetUrlObj.searchParams.set("via", key);
  targetUrlObj.searchParams.set("clickId", clickId);

  // First-party attribution cookie
  const cookieName = `dub_id_${domain}_${key}`;
  const cookieHeader = `${cookieName}=${clickId}; Path=/; Max-Age=${ATTRIBUTION_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax; Secure`;

  // 7. Workers Analytics Engine Telemetry (Non-blocking via ctx.waitUntil)
  if (env.CLICKS_ANALYTICS) {
    const recordTelemetry = () => {
      try {
        const userAgent = request.headers.get("user-agent") || "";
        let referrerHost = "(direct)";
        const referer = request.headers.get("referer");
        if (referer) {
          try {
            referrerHost = new URL(referer).hostname;
          } catch {
            referrerHost = referer;
          }
        }

        const bot = isBot(request);
        const qr = isQrScan(incomingUrl);
        const conversionValue = Number(incomingUrl.searchParams.get("conversionValue")) || 0;

        // Blob length clamping according to Cloudflare limits (LNK-05)
        const blobs = [
          domain.slice(0, 256), // blob1: domain
          key.slice(0, 256), // blob2: key
          (linkRecord.id || "").slice(0, 64), // blob3: linkId
          (linkRecord.projectId || "").slice(0, 64), // blob4: projectId
          (linkRecord.partnerId || "").slice(0, 64), // blob5: partnerId
          (country || "XX").slice(0, 8), // blob6: country
          city.slice(0, 128), // blob7: city
          userAgent.slice(0, 512), // blob8: userAgent (clamped)
          referrerHost.slice(0, 256), // blob9: referrerHost
          clickId.slice(0, 64), // blob10: clickId
          targetUrlObj.toString().slice(0, 2048), // blob11: targetUrl (clamped)
        ];

        const doubles = [
          bot ? 1 : 0, // double1: isBot
          qr ? 1 : 0, // double2: isQr
          conversionValue, // double3: conversionValue
        ];

        const indexes = [
          (linkRecord.projectId || "").slice(0, 32), // index1: workspace partition (max 32 bytes)
        ];

        env.CLICKS_ANALYTICS?.writeDataPoint({
          blobs,
          doubles,
          indexes,
        });
      } catch (err) {
        // Telemetry failure must never block edge redirection
        console.warn("[Link Redirector] Telemetry write failed:", err);
      }
    };

    if (_ctx?.waitUntil) {
      _ctx.waitUntil(Promise.resolve().then(recordTelemetry));
    } else {
      recordTelemetry();
    }
  }

  // 8. Return HTTP 302 Redirection
  return new Response(null, {
    status: 302,
    headers: {
      Location: targetUrlObj.toString(),
      "Set-Cookie": cookieHeader,
      "Cache-Control": "private, no-cache, no-store, must-revalidate",
      "X-Robots-Tag": "noindex",
    },
  });
}

const worker = {
  async fetch(
    request: Request,
    env: LinkRedirectorEnv,
    ctx?: ExecutionContext,
  ): Promise<Response> {
    return handleLinkRedirection(request, env, ctx);
  },
};

export default worker;
