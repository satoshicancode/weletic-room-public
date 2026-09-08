import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  download: vi.fn(),
  readBody: vi.fn(),
}));

vi.mock("@/lib/weletic/shopify/compliance-artifacts", () => ({
  createComplianceExportDownload: mocks.download,
}));
vi.mock("@/lib/weletic/shopify/service-auth", () => ({
  readWeleticShopifyRequestBodyBytes: mocks.readBody,
}));

import {
  GET,
  POST,
} from "../../app/api/shopify/compliance/exports/[requestId]/route";

describe("private Shopify compliance export route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses a no-store landing page and exchanges a fragment token via POST", async () => {
    const response = await GET();
    const html = await response.text();

    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(html).toContain("location.hash");
    expect(html).toContain('method:"POST"');
    expect(html).toContain("history.replaceState");
    expect(html).not.toContain("location.search");
  });

  it("rejects an invalid bearer without exposing whether a request exists", async () => {
    mocks.readBody.mockResolvedValue(
      new TextEncoder().encode(JSON.stringify({ token: "too-short" })),
    );
    const response = await POST(
      new Request(
        "https://weletic.test/api/shopify/compliance/exports/wcomp_1",
        {
          method: "POST",
        },
      ),
      { params: Promise.resolve({ requestId: "wcomp_1" }) },
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.download).not.toHaveBeenCalled();
  });
});
