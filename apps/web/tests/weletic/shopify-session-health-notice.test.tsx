import { ShopifySessionHealthNotice } from "@/ui/weletic/shopify/session-health-notice";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const swr = vi.hoisted(() => vi.fn());
vi.mock("swr", () => ({ default: swr }));

describe("Shopify connection notice presentation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    swr.mockReturnValue({
      data: undefined,
      error: undefined,
      isLoading: false,
    });
  });
  const render = (workspaceId: string | undefined = "workspace-1") =>
    renderToStaticMarkup(
      createElement(ShopifySessionHealthNotice, { workspaceId }),
    );

  it("renders an accessible reconnect notice without credentials or automatic mutation", () => {
    swr.mockReturnValue({
      data: {
        status: "reconnect_required",
        detectedAt: "2026-09-06T00:00:00Z",
      },
    });
    const html = render();
    expect(html).toContain('role="alert"');
    expect(html).toContain("Shopify reconnection required");
    expect(html).toContain("Shopify store owner");
    expect(html).toContain("authorized staff member");
    expect(html).toContain(
      "does not grant company approval or activate loyalty",
    );
    expect(html).not.toContain("workspace owner");
    expect(html).toContain("does not change existing points");
    expect(html).not.toContain("<button");
    expect(swr.mock.calls[0][0]).toBe(
      "/api/weletic/shopify/session-health?workspaceId=workspace-1",
    );
  });

  it("keeps the last reported alert visible if revalidation fails", () => {
    swr.mockReturnValue({
      data: { status: "reconnect_required" },
      error: new Error("private-error"),
    });
    const html = render();
    expect(html).toContain("last reported issue remains visible");
    expect(html).not.toContain("private-error");
  });

  it("reports loading and unavailable states without claiming healthy", () => {
    swr.mockReturnValue({ isLoading: true });
    expect(render()).toContain("Checking Shopify connection alerts");
    swr.mockReturnValue({ error: new Error("private-error") });
    expect(render()).toContain("connection status is unavailable");
    expect(render()).not.toContain("private-error");
  });

  it("does not claim live health when no incident was observed", () => {
    swr.mockReturnValue({ data: { status: "not_observed", detectedAt: null } });
    expect(render()).toBe("");
  });

  it("reports disconnected installations", () => {
    swr.mockReturnValue({
      data: { status: "not_connected", detectedAt: null },
    });
    expect(render()).toContain("No active Shopify installation");
  });

  it("does not reuse another workspace's cached response", () => {
    render("workspace-one");
    render("workspace-two");
    expect(swr.mock.calls.map(([key]) => key)).toEqual([
      "/api/weletic/shopify/session-health?workspaceId=workspace-one",
      "/api/weletic/shopify/session-health?workspaceId=workspace-two",
    ]);
    expect(swr.mock.calls[1][2]).toMatchObject({ keepPreviousData: false });
    renderToStaticMarkup(createElement(ShopifySessionHealthNotice, {}));
    expect(swr.mock.calls[2][0]).toBeNull();
  });
});
