/**
 * Edge Rate Limiter & Burst Protection (SEC-R4-04)
 * Provides in-memory sliding window / token bucket burst protection for Cloudflare Edge Workers.
 * Features automatic garbage collection to prevent unbounded isolate memory growth.
 */

export interface EdgeRateLimiterOptions {
  maxRequests?: number;
  windowMs?: number;
  maxEntries?: number;
}

export interface RateLimitCheckResult {
  success: boolean;
  limit: number;
  remaining: number;
  resetMs: number;
}

interface WindowBucket {
  count: number;
  resetAt: number;
}

export class EdgeRateLimiter {
  private readonly defaultLimit: number;
  private readonly defaultWindowMs: number;
  private readonly maxEntries: number;
  private readonly buckets = new Map<string, WindowBucket>();

  constructor(options: EdgeRateLimiterOptions = {}) {
    this.defaultLimit = options.maxRequests ?? 100;
    this.defaultWindowMs = options.windowMs ?? 10_000; // 10 seconds
    this.maxEntries = options.maxEntries ?? 5_000;
  }

  /**
   * Checks whether a request with the given key is allowed under rate limits.
   */
  public check(
    key: string,
    limitOverride?: number,
    windowMsOverride?: number,
  ): RateLimitCheckResult {
    const now = Date.now();
    const limit = limitOverride ?? this.defaultLimit;
    const windowMs = windowMsOverride ?? this.defaultWindowMs;

    // Prune expired entries if capacity threshold reached
    if (this.buckets.size >= this.maxEntries) {
      this.prune(now);
      while (this.buckets.size >= this.maxEntries) {
        const oldestKey = this.buckets.keys().next().value;
        if (oldestKey) {
          this.buckets.delete(oldestKey);
        } else {
          break;
        }
      }
    }

    const existing = this.buckets.get(key);

    if (!existing || existing.resetAt <= now) {
      this.buckets.set(key, {
        count: 1,
        resetAt: now + windowMs,
      });
      return {
        success: true,
        limit,
        remaining: Math.max(0, limit - 1),
        resetMs: windowMs,
      };
    }

    if (existing.count < limit) {
      existing.count += 1;
      return {
        success: true,
        limit,
        remaining: Math.max(0, limit - existing.count),
        resetMs: Math.max(0, existing.resetAt - now),
      };
    }

    return {
      success: false,
      limit,
      remaining: 0,
      resetMs: Math.max(0, existing.resetAt - now),
    };
  }

  /**
   * Clears all stored rate limit buckets (useful in tests and worker resets).
   */
  public reset(): void {
    this.buckets.clear();
  }

  /**
   * Removes expired buckets to bound isolate memory.
   */
  private prune(now: number): void {
    for (const [k, bucket] of this.buckets.entries()) {
      if (bucket.resetAt <= now) {
        this.buckets.delete(k);
      }
    }
  }
}

/**
 * Extracts client IP identifier from standard edge headers.
 * Returns null if no client IP header is provided (e.g. unit test harness).
 */
export function getClientIp(request: Request): string | null {
  const cfConnectingIp = request.headers.get("cf-connecting-ip");
  if (cfConnectingIp && cfConnectingIp.trim()) {
    return cfConnectingIp.trim();
  }

  const xForwardedFor = request.headers.get("x-forwarded-for");
  if (xForwardedFor && xForwardedFor.trim()) {
    const firstIp = xForwardedFor.split(",")[0]?.trim();
    if (firstIp) return firstIp;
  }

  const xRealIp = request.headers.get("x-real-ip");
  if (xRealIp && xRealIp.trim()) {
    return xRealIp.trim();
  }

  return null;
}

/**
 * Builds standard HTTP 429 Too Many Requests response with standard headers.
 */
export function createRateLimitResponse(
  resetMs: number,
  limit: number,
  remaining = 0,
): Response {
  const retryAfterSec = Math.max(1, Math.ceil(resetMs / 1000));
  const resetTimestampSec = Math.ceil((Date.now() + resetMs) / 1000);

  return new Response(
    JSON.stringify({
      error: "Too Many Requests",
      message: "Rate limit exceeded. Please try again later.",
      retryAfter: retryAfterSec,
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": retryAfterSec.toString(),
        "X-RateLimit-Limit": limit.toString(),
        "X-RateLimit-Remaining": remaining.toString(),
        "X-RateLimit-Reset": resetTimestampSec.toString(),
      },
    },
  );
}

// Global edge rate limiter instances per worker domain
export const webhookRateLimiter = new EdgeRateLimiter({
  maxRequests: 100,
  windowMs: 10_000,
});

export const redirectRateLimiter = new EdgeRateLimiter({
  maxRequests: 100,
  windowMs: 10_000,
});

export const cronRateLimiter = new EdgeRateLimiter({
  maxRequests: 20,
  windowMs: 60_000,
});
