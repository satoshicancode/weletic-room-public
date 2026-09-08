import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const dispatch = vi.fn();
vi.mock(
  "@/lib/jobs/handlers/weletic-shopify-session-renewal-sweep-job",
  () => ({ weleticShopifySessionRenewalSweepJob: { dispatch } }),
);
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

describe("Shopify renewal cron authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("WELETIC_ENFORCE_CRON_AUTH", "1");
    vi.stubEnv("WELETIC_SHOPIFY_RENEWAL_ENABLED", "1");
    vi.stubEnv("SHOPIFY_API_KEY", "renewal-test");
    vi.stubEnv("CRON_SECRET", "synthetic-cron-secret");
    dispatch.mockResolvedValue({ status: "published", messageId: "synthetic" });
  });
  afterEach(() => vi.unstubAllEnvs());
  const request = (authorized = true) =>
    new Request(
      "https://app.invalid/api/cron/weletic/shopify/session-renewal",
      {
        headers: authorized
          ? { authorization: "Bearer synthetic-cron-secret" }
          : {},
      },
    );

  it("rejects unsigned requests before dispatch", async () => {
    const { GET } = await import(
      "../../app/(ee)/api/cron/weletic/shopify/session-renewal/route"
    );
    const response = await GET(request(false));
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("refuses the generic development auth bypass", async () => {
    vi.stubEnv("WELETIC_ENFORCE_CRON_AUTH", "");
    const { GET } = await import(
      "../../app/(ee)/api/cron/weletic/shopify/session-renewal/route"
    );
    expect((await GET(request())).status).toBe(401);
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("keeps authenticated requests disabled without explicit activation", async () => {
    vi.stubEnv("WELETIC_SHOPIFY_RENEWAL_ENABLED", "");
    const { GET } = await import(
      "../../app/(ee)/api/cron/weletic/shopify/session-renewal/route"
    );
    expect(await (await GET(request())).json()).toEqual({ status: "disabled" });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("dispatches a minute-scoped root sweep with only app identity and time", async () => {
    const { GET } = await import(
      "../../app/(ee)/api/cron/weletic/shopify/session-renewal/route"
    );
    expect(await (await GET(request())).json()).toEqual({
      status: "published",
    });
    expect(dispatch).toHaveBeenCalledOnce();
    const [payload, options] = dispatch.mock.calls[0];
    expect(payload.appId).toBe("renewal-test");
    expect(Date.parse(payload.scheduledAt) % 60_000).toBe(0);
    expect(options.deduplicationId).toBe(`renewal-test:${payload.scheduledAt}`);
    expect(Object.keys(payload).sort()).toEqual(["appId", "scheduledAt"]);
  });
  it("keeps dispatch outages retryable without returning queue secrets", async () => {
    dispatch.mockRejectedValue(new Error("sensitive-provider-error"));
    const { GET } = await import(
      "../../app/(ee)/api/cron/weletic/shopify/session-renewal/route"
    );
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("sensitive");
  });
});
